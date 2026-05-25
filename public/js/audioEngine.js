/**
 * ============================================================================
 * AudioEngine — Core audio playback engine for synchronized music playback
 * ============================================================================
 *
 * Uses the Web Audio API to achieve sample-accurate synchronized playback
 * between two (or more) devices. The key idea:
 *
 *   1. A "clockSync" object provides a shared reference clock
 *      (`clockSync.getSyncedTime()`) that returns the estimated server
 *      timestamp in milliseconds, already corrected for network latency
 *      and local-clock drift.
 *
 *   2. When a host says "play at server-time T", every client converts T
 *      into its own AudioContext timeline:
 *
 *        localDelay  = T - clockSync.getSyncedTime()   // ms until play
 *        acTime      = audioContext.currentTime + localDelay / 1000
 *
 *      Because AudioContext.currentTime is a monotonic high-resolution
 *      clock driven by the audio hardware, scheduling via
 *      `source.start(acTime, offset)` gives us *sample-accurate* sync
 *      — far more precise than setTimeout could ever be.
 *
 *   3. If the scheduled time is already in the past (e.g. message arrived
 *      late), we compute how far into the track we should be and start
 *      playback with that offset so the listener "catches up" instantly.
 *
 * Audio graph:
 *
 *   AudioBufferSourceNode  →  GainNode  →  AnalyserNode  →  destination
 *        (playback)          (volume)     (visualizer)      (speakers)
 *
 * ============================================================================
 */

(function () {
  'use strict';

  // ── Utility ───────────────────────────────────────────────────────────────

  /**
   * Format a time value in seconds to a human-readable "m:ss" string.
   *
   * @param {number} seconds - Time in seconds (may be fractional).
   * @returns {string} Formatted string, e.g. "3:45".
   */
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';

    const totalSeconds = Math.floor(seconds);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  // ── AudioEngine class ────────────────────────────────────────────────────

  class AudioEngine {
    /**
     * @param {object} clockSync - An object that exposes `getSyncedTime()`
     *   returning the estimated server timestamp in **milliseconds**.
     */
    constructor(clockSync) {
      // ------------------------------------------------------------------
      // 1. AudioContext — the heart of Web Audio.
      //    Safari ≤ 13 still exposes the prefixed constructor.
      // ------------------------------------------------------------------
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('Web Audio API is not supported in this browser.');
      }

      /** @type {AudioContext} */
      this.audioContext = new AudioCtx();

      // ------------------------------------------------------------------
      // 2. GainNode — provides smooth volume control.
      //    Connected directly to the context destination (speakers).
      // ------------------------------------------------------------------
      /** @type {GainNode} */
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0; // default: full volume

      // ------------------------------------------------------------------
      // 3. AnalyserNode — taps the audio stream for visualiser data.
      //    Sits between the gain node and the destination so the
      //    visualiser sees volume-adjusted waveform data.
      //
      //    fftSize 256  →  128-bin frequency data (good for a compact bar
      //                     visualiser without excessive CPU cost).
      //    smoothingTimeConstant 0.8  →  visually pleasing smoothing.
      // ------------------------------------------------------------------
      /** @type {AnalyserNode} */
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.8;

      // Wire the graph:  gain → analyser → destination
      this.gainNode.connect(this.analyserNode);
      this.analyserNode.connect(this.audioContext.destination);

      // ------------------------------------------------------------------
      // 4. Playback state
      // ------------------------------------------------------------------

      /** @type {AudioBuffer|null} Decoded audio data ready for playback. */
      this.audioBuffer = null;

      /**
       * @type {AudioBufferSourceNode|null}
       * The currently active source node. Each play creates a new one
       * (source nodes are one-shot by design in Web Audio).
       */
      this.sourceNode = null;

      /**
       * @type {number}
       * AudioContext.currentTime at which playback conceptually started,
       * accounting for any initial offset (pausedAt).
       *
       * currentPosition = audioContext.currentTime - startedAt
       */
      this.startedAt = 0;

      /**
       * @type {number}
       * Position in seconds within the track where playback was paused.
       * Used as the `offset` argument in `source.start()`.
       */
      this.pausedAt = 0;

      /** @type {boolean} Whether audio is currently playing. */
      this.isPlaying = false;

      /** @type {number} Total duration of the loaded audio in seconds. */
      this.duration = 0;

      // ------------------------------------------------------------------
      // 5. Clock synchronization handle
      // ------------------------------------------------------------------

      /**
       * @type {object}
       * Must expose `getSyncedTime()` → server timestamp in ms.
       */
      this.clockSync = clockSync;

      console.log('[AudioEngine] Initialised. Sample rate:', this.audioContext.sampleRate, 'Hz');
    }

    // ====================================================================
    // File loading
    // ====================================================================

    /**
     * Load audio from a user-selected File object (e.g. from <input type="file">).
     *
     * Reads the file into an ArrayBuffer via FileReader, then decodes it
     * through the AudioContext's built-in decoder (supports MP3, AAC,
     * WAV, OGG, FLAC — whatever the browser supports).
     *
     * @param {File} file - A File object from an <input> element.
     * @returns {Promise<{duration: number, sampleRate: number, numberOfChannels: number}>}
     */
    async loadFile(file) {
      try {
        console.log('[AudioEngine] Loading file:', file.name, `(${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

        // Read the File as a raw ArrayBuffer using a Promise wrapper
        const arrayBuffer = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Failed to read file: ' + reader.error));
          reader.readAsArrayBuffer(file);
        });

        // Delegate to the shared decode path
        return await this._decodeAndStore(arrayBuffer);
      } catch (err) {
        console.error('[AudioEngine] loadFile error:', err);
        throw err;
      }
    }

    /**
     * Load audio from a raw ArrayBuffer (e.g. received over WebSocket
     * from the other device).
     *
     * @param {ArrayBuffer} arrayBuffer - Raw audio bytes.
     * @returns {Promise<{duration: number, sampleRate: number, numberOfChannels: number}>}
     */
    async loadArrayBuffer(arrayBuffer) {
      try {
        console.log('[AudioEngine] Loading ArrayBuffer:', (arrayBuffer.byteLength / (1024 * 1024)).toFixed(2), 'MB');
        return await this._decodeAndStore(arrayBuffer);
      } catch (err) {
        console.error('[AudioEngine] loadArrayBuffer error:', err);
        throw err;
      }
    }

    /**
     * Internal helper — decodes an ArrayBuffer and stores the result.
     *
     * @private
     * @param {ArrayBuffer} arrayBuffer
     * @returns {Promise<{duration: number, sampleRate: number, numberOfChannels: number}>}
     */
    async _decodeAndStore(arrayBuffer) {
      // decodeAudioData returns a Promise in modern browsers.
      // In older Safari it used a callback API — wrapping both patterns.
      const decoded = await new Promise((resolve, reject) => {
        this.audioContext.decodeAudioData(
          arrayBuffer,
          (buffer) => resolve(buffer),
          (err) => reject(err || new Error('Audio decode failed'))
        );
      });

      this.audioBuffer = decoded;
      this.duration = decoded.duration;

      // Reset playback state for the new track
      this.pausedAt = 0;
      this.startedAt = 0;

      const info = {
        duration: decoded.duration,
        sampleRate: decoded.sampleRate,
        numberOfChannels: decoded.numberOfChannels,
      };

      console.log(
        '[AudioEngine] Audio decoded — duration:',
        formatTime(info.duration),
        `(${info.duration.toFixed(3)}s)`,
        '| sample rate:', info.sampleRate,
        '| channels:', info.numberOfChannels
      );

      return info;
    }

    // ====================================================================
    // Synchronized playback — the core sync logic
    // ====================================================================

    /**
     * Schedule playback so that audio begins at a specific **server
     * timestamp**.
     *
     * This is THE KEY METHOD for multi-device synchronization.
     *
     * ### How it works
     *
     * ```
     * serverNow   = clockSync.getSyncedTime()         // estimated server time (ms)
     * delayMs     = serverTimestamp - serverNow        // ms until we should start
     * acWhen      = audioContext.currentTime + delayMs / 1000
     * ```
     *
     * Three cases:
     *
     * | delayMs | Meaning | Action |
     * |---------|---------|--------|
     * | > 0     | Play is in the future | Schedule `source.start(acWhen, pausedAt)` |
     * | ≈ 0     | Play right now | Same, acWhen ≈ currentTime |
     * | < 0     | We're late! | Compute offset into the track and start immediately |
     *
     * @param {number} serverTimestamp - Server time (ms) at which playback
     *   should begin (from the paused position).
     */
    async playAt(serverTimestamp) {
      if (!this.audioBuffer) {
        console.warn('[AudioEngine] playAt called but no audio is loaded.');
        return;
      }

      try {
        // ── Handle autoplay policy (iOS / Safari / Chrome) ──────────
        // Browsers suspend AudioContext until a user gesture triggers
        // `resume()`. We call it every time to be safe — it's a no-op
        // if the context is already running.
        if (this.audioContext.state === 'suspended') {
          console.log('[AudioEngine] Resuming suspended AudioContext…');
          await this.audioContext.resume();
        }

        // ── Tear down any previous source ───────────────────────────
        this._stopSource();

        // ── Compute scheduling parameters ───────────────────────────
        const serverNow = this.clockSync.getSyncedTime();
        const delayMs = serverTimestamp - serverNow; // positive = future
        let when = this.audioContext.currentTime + (delayMs / 1000);
        let offset = this.pausedAt; // resume from paused position

        console.log(
          '[AudioEngine] playAt sync details:',
          '\n  serverTimestamp :', serverTimestamp.toFixed(1), 'ms',
          '\n  serverNow      :', serverNow.toFixed(1), 'ms',
          '\n  delayMs        :', delayMs.toFixed(2), 'ms',
          '\n  ac.currentTime :', this.audioContext.currentTime.toFixed(4), 's',
          '\n  scheduled when :', when.toFixed(4), 's',
          '\n  offset (paused):', offset.toFixed(3), 's'
        );

        // ── Late-arrival compensation ───────────────────────────────
        // If `when` is in the past, the message arrived late (network
        // jitter, GC pause, etc.). Instead of playing from the paused
        // position we fast-forward by how many seconds we're late so
        // the listener is "in sync" with everyone else.
        if (when < this.audioContext.currentTime) {
          const lateBy = this.audioContext.currentTime - when; // seconds
          offset += lateBy;
          console.warn(
            `[AudioEngine] Late by ${(lateBy * 1000).toFixed(1)} ms — ` +
            `adjusting offset to ${offset.toFixed(3)}s`
          );

          // If we're so late that the track would already be finished,
          // don't bother starting.
          if (offset >= this.duration) {
            console.warn('[AudioEngine] Offset exceeds duration — track already ended.');
            this.isPlaying = false;
            this.pausedAt = 0;
            return;
          }

          // Start immediately
          when = this.audioContext.currentTime;
        }

        // ── Create & configure source node ──────────────────────────
        // AudioBufferSourceNodes are single-use: you create one, start
        // it, and when it stops it's done. You can't restart it.
        const source = this.audioContext.createBufferSource();
        source.buffer = this.audioBuffer;
        source.connect(this.gainNode);

        // Schedule the start.  `when` is an AudioContext timestamp and
        // `offset` is how many seconds into the buffer to begin.
        source.start(when, offset);

        // ── Update internal state ───────────────────────────────────
        // startedAt represents the AudioContext time at which position
        // 0:00 of the track *would have been* if we started from the
        // beginning.  This makes getCurrentTime() a simple subtraction.
        this.startedAt = when - offset;
        this.sourceNode = source;
        this.isPlaying = true;

        console.log(
          '[AudioEngine] Playback scheduled.',
          'Effective start position:', formatTime(offset),
          `(${offset.toFixed(3)}s)`
        );

        // ── Handle natural end-of-track ─────────────────────────────
        source.onended = () => {
          // Only update state if this is still the active source.
          // (If seekTo or pause replaced the source, we ignore this.)
          if (this.sourceNode === source) {
            this.isPlaying = false;
            this.pausedAt = 0;
            this.sourceNode = null;
            console.log('[AudioEngine] Playback ended naturally.');
          }
        };
      } catch (err) {
        console.error('[AudioEngine] playAt error:', err);
        throw err;
      }
    }

    // ====================================================================
    // Transport controls
    // ====================================================================

    /**
     * Pause playback and record the current position.
     *
     * @returns {number} The position (in seconds) at which playback was
     *   paused, or 0 if not currently playing.
     */
    pause() {
      if (!this.isPlaying) {
        console.log('[AudioEngine] pause() called but not playing.');
        return this.pausedAt;
      }

      // Calculate where we are in the track right now
      const elapsed = this.audioContext.currentTime - this.startedAt;
      this.pausedAt = Math.max(0, Math.min(elapsed, this.duration));

      // Stop the source (this triggers onended, but our guard prevents
      // it from resetting pausedAt).
      this._stopSource();
      this.isPlaying = false;

      console.log('[AudioEngine] Paused at', formatTime(this.pausedAt), `(${this.pausedAt.toFixed(3)}s)`);
      return this.pausedAt;
    }

    /**
     * Seek to a specific position in the track.
     *
     * If currently playing, playback restarts from the new position at
     * the given server timestamp. If paused, only the paused position
     * is updated (playback resumes from here on next play).
     *
     * @param {number} position - Position in seconds to seek to.
     * @param {number} serverTimestamp - Server time (ms) at which the
     *   seek-and-play should occur (used only when currently playing).
     */
    async seekTo(position, serverTimestamp) {
      // Clamp to valid range
      this.pausedAt = Math.max(0, Math.min(position, this.duration));

      console.log('[AudioEngine] seekTo', formatTime(this.pausedAt), `(${this.pausedAt.toFixed(3)}s)`);

      if (this.isPlaying) {
        // Stop current playback and restart from the new position
        this._stopSource();
        this.isPlaying = false; // playAt will set it back to true
        await this.playAt(serverTimestamp);
      }
    }

    // ====================================================================
    // State queries
    // ====================================================================

    /**
     * Get the current playback position in seconds.
     *
     * @returns {number} Current position clamped to [0, duration].
     */
    getCurrentTime() {
      let time;

      if (this.isPlaying) {
        time = this.audioContext.currentTime - this.startedAt;
      } else {
        time = this.pausedAt;
      }

      // Clamp to valid range
      return Math.max(0, Math.min(time, this.duration));
    }

    /**
     * Set the playback volume with a smooth ramp to avoid clicks.
     *
     * @param {number} value - Volume level from 0.0 (mute) to 1.0 (full).
     */
    setVolume(value) {
      const clamped = Math.max(0, Math.min(1, value));
      const now = this.audioContext.currentTime;

      // Cancel any previously scheduled ramps, then ramp smoothly over
      // 50 ms to avoid audible clicks/pops.
      this.gainNode.gain.cancelScheduledValues(now);
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(clamped, now + 0.05);

      console.log('[AudioEngine] Volume →', clamped.toFixed(2));
    }

    /**
     * Return the AnalyserNode for external visualiser use.
     *
     * @returns {AnalyserNode}
     */
    getAnalyser() {
      return this.analyserNode;
    }

    /**
     * Return the total duration of the loaded audio in seconds.
     *
     * @returns {number}
     */
    getDuration() {
      return this.duration;
    }

    /**
     * Check whether an audio file has been loaded and decoded.
     *
     * @returns {boolean}
     */
    isLoaded() {
      return this.audioBuffer !== null;
    }

    /**
     * Return the underlying AudioContext (e.g. for advanced use or
     * creating additional nodes).
     *
     * @returns {AudioContext}
     */
    getAudioContext() {
      return this.audioContext;
    }

    // ====================================================================
    // Internal helpers
    // ====================================================================

    /**
     * Safely stop and disconnect the current source node.
     *
     * Called before creating a new source to avoid overlapping playback
     * and to release the old node for garbage collection.
     *
     * @private
     */
    _stopSource() {
      if (this.sourceNode) {
        try {
          this.sourceNode.onended = null; // prevent stale handler
          this.sourceNode.stop();
          this.sourceNode.disconnect();
        } catch (e) {
          // source.stop() throws if the node was never started or
          // has already stopped — safe to ignore.
        }
        this.sourceNode = null;
      }
    }
  }

  // ── Export on the global window object (no ES modules) ────────────────

  window.AudioEngine = AudioEngine;

  // Also expose the helper for external use
  window.AudioEngine.formatTime = formatTime;
})();
