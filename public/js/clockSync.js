/**
 * ClockSync — NTP-style clock synchronisation over Socket.IO
 * ===========================================================
 *
 * Estimates the time-offset between this client and the server so that
 * every connected client can agree on "what time it is" to within a few
 * milliseconds.  The algorithm mirrors a simplified NTP exchange:
 *
 *   1. Client records  t0  (local send time)
 *   2. Client sends    clock:ping  { t0 }
 *   3. Server records  t1  (server receive time) and replies
 *      clock:pong  { t0, t1 }
 *   4. Client records  t2  (local receive time)
 *   5. Offset = ((t1 - t0) + (t1 - t2)) / 2
 *
 * Multiple rounds are performed and the *median* offset is chosen to
 * reject outliers caused by network jitter.
 *
 * Usage:
 *   const sync = new ClockSync(socket);
 *   sync.start();
 *   sync.onReady(() => {
 *     console.log('Server time:', sync.getSyncedTime());
 *   });
 */

(function () {
  'use strict';

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Return a high-resolution monotonic timestamp (ms) when available,
   * falling back to Date.now().  performance.now() is origin-relative
   * so we add performance.timeOrigin to get an absolute wall-clock
   * approximation that is still measured with sub-ms precision.
   */
  function preciseNow() {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function' &&
      typeof performance.timeOrigin === 'number'
    ) {
      return performance.timeOrigin + performance.now();
    }
    return Date.now();
  }

  /**
   * Return the median of a sorted (ascending) numeric array.
   * @param {number[]} sorted
   * @returns {number}
   */
  function median(sorted) {
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ─── Constants ─────────────────────────────────────────────────────

  /** Number of ping-pong rounds during the initial sync. */
  var INITIAL_ROUNDS = 10;

  /** Number of ping-pong rounds for periodic re-syncs. */
  var RESYNC_ROUNDS = 5;

  /** Interval between periodic re-syncs (ms). */
  var RESYNC_INTERVAL_MS = 30 * 1000; // 30 seconds

  /** Small delay between consecutive pings to avoid flooding (ms). */
  var PING_DELAY_MS = 100;

  // ─── ClockSync class ──────────────────────────────────────────────

  /**
   * @constructor
   * @param {object} socket — A connected Socket.IO client instance.
   */
  function ClockSync(socket) {
    if (!socket) {
      throw new Error('ClockSync: a Socket.IO socket instance is required.');
    }

    /** @type {object} Socket.IO socket */
    this._socket = socket;

    /** @type {number} Estimated offset: serverTime ≈ Date.now() + offset */
    this.offset = 0;

    /** @type {boolean} Whether the initial sync has completed */
    this._ready = false;

    /** @type {number[]} Collected offsets for the current sync batch */
    this._offsets = [];

    /** @type {boolean} True while a sync batch is in progress */
    this._syncing = false;

    /** @type {number|null} ID of the periodic re-sync interval */
    this._resyncTimer = null;

    /** @type {number|null} ID of the pending ping timeout */
    this._pingTimer = null;

    /** @type {Function[]} Callbacks registered via onReady() */
    this._readyCallbacks = [];

    /** @type {number} Rounds remaining in the current sync batch */
    this._roundsRemaining = 0;

    /** @type {Function|null} Bound pong handler (kept so we can remove it) */
    this._boundPongHandler = null;

    // Bind socket lifecycle handlers once
    this._onDisconnect = this._handleDisconnect.bind(this);
    this._onReconnect = this._handleReconnect.bind(this);
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Kick off the initial synchronisation (INITIAL_ROUNDS rounds).
   * Safe to call multiple times — subsequent calls are no-ops while
   * a sync is already running.
   */
  ClockSync.prototype.start = function () {
    console.log('[ClockSync] Starting initial sync (' + INITIAL_ROUNDS + ' rounds)…');

    // Wire up lifecycle listeners
    this._socket.on('disconnect', this._onDisconnect);
    this._socket.io.on('reconnect', this._onReconnect);

    this._runSync(INITIAL_ROUNDS, true);
  };

  /**
   * Returns the current estimated server time (ms since epoch).
   * @returns {number}
   */
  ClockSync.prototype.getSyncedTime = function () {
    return Date.now() + this.offset;
  };

  /**
   * Returns the raw offset in milliseconds.
   * Positive means the server clock is ahead of the client.
   * @returns {number}
   */
  ClockSync.prototype.getOffset = function () {
    return this.offset;
  };

  /**
   * Whether the initial sync has completed at least once.
   * @returns {boolean}
   */
  ClockSync.prototype.isReady = function () {
    return this._ready;
  };

  /**
   * Register a callback to be invoked (once) when the initial sync
   * completes.  If the sync is already complete the callback fires
   * immediately (asynchronously).
   *
   * @param {Function} cb
   */
  ClockSync.prototype.onReady = function (cb) {
    if (typeof cb !== 'function') return;

    if (this._ready) {
      // Already synced — fire asynchronously to keep consistent semantics
      setTimeout(cb, 0);
    } else {
      this._readyCallbacks.push(cb);
    }
  };

  /**
   * Tear down timers and listeners.  Call this if you no longer need
   * clock sync (e.g. when leaving the page / destroying the player).
   */
  ClockSync.prototype.destroy = function () {
    this._cancelPendingSyncs();
    this._socket.off('disconnect', this._onDisconnect);
    this._socket.io.off('reconnect', this._onReconnect);
    console.log('[ClockSync] Destroyed — all timers and listeners removed.');
  };

  // ─── Internal methods ─────────────────────────────────────────────

  /**
   * Run a full sync batch of `rounds` ping-pong exchanges.
   *
   * @param {number}  rounds   Number of rounds to perform.
   * @param {boolean} initial  If true, treat completion as the "initial"
   *                           sync and fire readyCallbacks / start re-sync
   *                           timer.
   */
  ClockSync.prototype._runSync = function (rounds, initial) {
    if (this._syncing) {
      console.log('[ClockSync] Sync already in progress — skipping.');
      return;
    }

    this._syncing = true;
    this._offsets = [];
    this._roundsRemaining = rounds;

    var self = this;

    // Register the pong handler for this batch
    this._boundPongHandler = function (data) {
      self._handlePong(data, initial);
    };
    this._socket.on('clock:pong', this._boundPongHandler);

    // Fire the first ping
    this._sendPing();
  };

  /**
   * Send a single clock:ping event.
   */
  ClockSync.prototype._sendPing = function () {
    var t0 = preciseNow();
    this._socket.emit('clock:ping', { t0: t0 });
  };

  /**
   * Handle a clock:pong response from the server.
   *
   * @param {{ t0: number, t1: number }} data
   * @param {boolean} initial  Whether this batch is the initial sync.
   */
  ClockSync.prototype._handlePong = function (data, initial) {
    var t2 = preciseNow();
    var t0 = data.t0;
    var t1 = data.t1;

    // NTP-style offset calculation
    var offset = ((t1 - t0) + (t1 - t2)) / 2;
    var rtt = t2 - t0;

    this._offsets.push(offset);
    this._roundsRemaining--;

    var completed = this._offsets.length;
    var total = completed + this._roundsRemaining;
    console.log(
      '[ClockSync] Round ' + completed + '/' + total +
      ' — offset: ' + offset.toFixed(2) + ' ms, RTT: ' + rtt.toFixed(2) + ' ms'
    );

    if (this._roundsRemaining > 0) {
      // Schedule the next ping after a short delay to avoid flooding
      var self = this;
      this._pingTimer = setTimeout(function () {
        self._pingTimer = null;
        self._sendPing();
      }, PING_DELAY_MS);
    } else {
      // All rounds complete — compute the median offset
      this._finalizeBatch(initial);
    }
  };

  /**
   * Compute final offset from collected samples and clean up.
   *
   * @param {boolean} initial
   */
  ClockSync.prototype._finalizeBatch = function (initial) {
    // Remove the pong listener for this batch
    if (this._boundPongHandler) {
      this._socket.off('clock:pong', this._boundPongHandler);
      this._boundPongHandler = null;
    }

    // Sort offsets ascending and pick the median
    var sorted = this._offsets.slice().sort(function (a, b) { return a - b; });
    var medianOffset = median(sorted);

    var previousOffset = this.offset;
    this.offset = medianOffset;
    this._syncing = false;

    console.log(
      '[ClockSync] Sync complete — median offset: ' + medianOffset.toFixed(2) +
      ' ms (Δ from previous: ' + (medianOffset - previousOffset).toFixed(2) + ' ms)'
    );

    if (initial && !this._ready) {
      this._ready = true;
      console.log('[ClockSync] ✔ Initial sync ready. Server time ≈ Date.now() + (' + medianOffset.toFixed(2) + ' ms)');

      // Fire all registered ready callbacks
      var cbs = this._readyCallbacks.slice();
      this._readyCallbacks = [];
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](); } catch (e) {
          console.error('[ClockSync] onReady callback error:', e);
        }
      }
    }

    // (Re-)start the periodic re-sync timer
    this._startResyncTimer();
  };

  /**
   * Set up a repeating timer that re-syncs every RESYNC_INTERVAL_MS.
   */
  ClockSync.prototype._startResyncTimer = function () {
    // Clear any existing timer first
    if (this._resyncTimer !== null) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }

    var self = this;
    this._resyncTimer = setInterval(function () {
      console.log('[ClockSync] Periodic re-sync (' + RESYNC_ROUNDS + ' rounds)…');
      self._runSync(RESYNC_ROUNDS, false);
    }, RESYNC_INTERVAL_MS);
  };

  /**
   * Cancel any in-flight pings, pending timers, and the re-sync
   * interval.  Called on disconnect and from destroy().
   */
  ClockSync.prototype._cancelPendingSyncs = function () {
    // Cancel pending ping
    if (this._pingTimer !== null) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }

    // Cancel re-sync interval
    if (this._resyncTimer !== null) {
      clearInterval(this._resyncTimer);
      this._resyncTimer = null;
    }

    // Remove pong listener if still attached
    if (this._boundPongHandler) {
      this._socket.off('clock:pong', this._boundPongHandler);
      this._boundPongHandler = null;
    }

    this._syncing = false;
    this._roundsRemaining = 0;
    this._offsets = [];
  };

  /**
   * Handle socket disconnection: cancel all pending work.
   */
  ClockSync.prototype._handleDisconnect = function () {
    console.warn('[ClockSync] Socket disconnected — cancelling pending syncs.');
    this._cancelPendingSyncs();
  };

  /**
   * Handle socket reconnection: trigger a fresh full sync.
   */
  ClockSync.prototype._handleReconnect = function () {
    console.log('[ClockSync] Socket reconnected — starting fresh sync.');
    // Reset ready state so consumers know we are re-syncing
    this._ready = false;
    this._runSync(INITIAL_ROUNDS, true);
  };

  // ─── Export ────────────────────────────────────────────────────────
  window.ClockSync = ClockSync;

})();
