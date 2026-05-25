/**
 * Visualizer — Canvas-based audio frequency visualizer
 * =====================================================
 *
 * Renders a beautiful bar-graph of real-time frequency data from a
 * Web Audio API AnalyserNode.  Features include:
 *
 *   • Gradient bars  (purple → cyan) with pink peak highlights
 *   • Rounded top corners
 *   • Subtle mirror / reflection beneath each bar
 *   • Glow (canvas shadow) on every bar
 *   • Smooth frame-to-frame interpolation (lerp)
 *   • Idle animation when no audio is playing
 *   • Responsive — watches for canvas container resizes
 *
 * Usage:
 *   const analyser = audioCtx.createAnalyser();
 *   // … connect source → analyser → destination
 *   const vis = new Visualizer(canvasElement, analyser);
 *   vis.start();
 *   // later…
 *   vis.stop();
 */

(function () {
  'use strict';

  // ─── Configuration ─────────────────────────────────────────────────

  /** Number of bars to render. */
  var BAR_COUNT = 56;

  /** Gap between bars in pixels. */
  var BAR_GAP = 2;

  /** Corner radius for the rounded top of each bar (px). */
  var CORNER_RADIUS = 4;

  /** How much of the canvas height the reflection occupies (0-1). */
  var REFLECTION_HEIGHT_RATIO = 0.35;

  /** Opacity of the reflection at its top edge. */
  var REFLECTION_OPACITY = 0.25;

  /**
   * Interpolation factor (0-1).
   * Lower = smoother but slower transitions; higher = snappier.
   */
  var LERP_FACTOR = 0.18;

  /** Idle-mode bounce speed (radians per frame). */
  var IDLE_SPEED = 0.04;

  /** Maximum bar height during idle animation (fraction of canvas). */
  var IDLE_MAX_HEIGHT = 0.10;

  /** Minimum bar height during idle animation (fraction of canvas). */
  var IDLE_MIN_HEIGHT = 0.02;

  /**
   * Threshold: if the sum of all frequency bins is below this value we
   * consider the audio "silent" and switch to idle animation.
   */
  var SILENCE_THRESHOLD = 50;

  // Colours
  var COLOR_BOTTOM = '#7c3aed'; // purple
  var COLOR_TOP    = '#06b6d4'; // cyan
  var COLOR_PEAK   = '#ec4899'; // pink

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Linear interpolation between two values.
   * @param {number} a  Start value.
   * @param {number} b  End value.
   * @param {number} t  Factor (0 = a, 1 = b).
   * @returns {number}
   */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Parse a hex colour string (#rrggbb) into [r, g, b].
   * @param {string} hex
   * @returns {number[]}
   */
  function hexToRgb(hex) {
    var bigint = parseInt(hex.slice(1), 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
  }

  /**
   * Linearly interpolate between two RGB colours.
   * @param {number[]} c1  [r,g,b]
   * @param {number[]} c2  [r,g,b]
   * @param {number}   t   0-1
   * @returns {string} "rgb(r,g,b)"
   */
  function lerpColor(c1, c2, t) {
    var r = Math.round(lerp(c1[0], c2[0], t));
    var g = Math.round(lerp(c1[1], c2[1], t));
    var b = Math.round(lerp(c1[2], c2[2], t));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // Pre-parsed colour triplets
  var RGB_BOTTOM = hexToRgb(COLOR_BOTTOM);
  var RGB_TOP    = hexToRgb(COLOR_TOP);
  var RGB_PEAK   = hexToRgb(COLOR_PEAK);

  // ─── Visualizer class ─────────────────────────────────────────────

  /**
   * @constructor
   * @param {HTMLCanvasElement} canvas    The <canvas> element to draw on.
   * @param {AnalyserNode}      analyser  A Web Audio API AnalyserNode.
   */
  function Visualizer(canvas, analyser) {
    if (!canvas || !analyser) {
      throw new Error('Visualizer: canvas element and AnalyserNode are required.');
    }

    /** @type {HTMLCanvasElement} */
    this.canvas = canvas;

    /** @type {CanvasRenderingContext2D} */
    this.ctx = canvas.getContext('2d');

    /** @type {AnalyserNode} */
    this.analyser = analyser;

    /** @type {Uint8Array} Raw frequency data buffer */
    this._freqData = new Uint8Array(analyser.frequencyBinCount);

    /** @type {number[]} Smoothed bar heights (0-1, normalised) */
    this._barHeights = new Array(BAR_COUNT);
    for (var i = 0; i < BAR_COUNT; i++) this._barHeights[i] = 0;

    /** @type {number|null} requestAnimationFrame ID */
    this._rafId = null;

    /** @type {boolean} Whether the animation loop is running */
    this._running = false;

    /** @type {number} Frame counter for idle animation phase offsets */
    this._idlePhase = 0;

    /** @type {number[]} Per-bar random phase offsets for idle wobble */
    this._idleOffsets = new Array(BAR_COUNT);
    for (var j = 0; j < BAR_COUNT; j++) {
      this._idleOffsets[j] = Math.random() * Math.PI * 2;
    }

    // ── Responsive canvas sizing ──
    this._resizeObserver = null;
    this._initResize();
    this._fitCanvas();
  }

  // ─── Public API ────────────────────────────────────────────────────

  /**
   * Start the visualisation loop.
   */
  Visualizer.prototype.start = function () {
    if (this._running) return;
    this._running = true;
    this._tick();
  };

  /**
   * Stop the visualisation loop.
   */
  Visualizer.prototype.stop = function () {
    this._running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  };

  /**
   * Clean up observer and animation frame.
   */
  Visualizer.prototype.destroy = function () {
    this.stop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  };

  // ─── Internal — resize handling ────────────────────────────────────

  /**
   * Attach a ResizeObserver (if available) to keep the canvas pixel
   * dimensions in sync with its CSS / layout size.
   */
  Visualizer.prototype._initResize = function () {
    if (typeof ResizeObserver === 'undefined') return;

    var self = this;
    this._resizeObserver = new ResizeObserver(function () {
      self._fitCanvas();
    });

    // Observe the canvas element itself (or its parent for flex layouts)
    var target = this.canvas.parentElement || this.canvas;
    this._resizeObserver.observe(target);
  };

  /**
   * Sync the canvas drawing-buffer size to its displayed size,
   * accounting for devicePixelRatio for crisp rendering on HiDPI
   * screens.
   */
  Visualizer.prototype._fitCanvas = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;

    var w = Math.round(rect.width * dpr);
    var h = Math.round(rect.height * dpr);

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  };

  // ─── Internal — animation loop ────────────────────────────────────

  /**
   * Single animation frame.
   */
  Visualizer.prototype._tick = function () {
    if (!this._running) return;

    var self = this;
    this._rafId = requestAnimationFrame(function () {
      self._tick();
    });

    // Ensure canvas buffer matches layout
    this._fitCanvas();

    // Read frequency data
    this.analyser.getByteFrequencyData(this._freqData);

    // Determine if audio is silent
    var sum = 0;
    for (var s = 0; s < this._freqData.length; s++) sum += this._freqData[s];
    var isSilent = sum < SILENCE_THRESHOLD;

    // Build target heights for each bar
    var targets = this._computeTargets(isSilent);

    // Smooth (lerp) towards targets
    for (var i = 0; i < BAR_COUNT; i++) {
      this._barHeights[i] = lerp(this._barHeights[i], targets[i], LERP_FACTOR);
    }

    // Draw
    this._draw();
  };

  /**
   * Compute the target (un-smoothed) normalised height for each bar.
   *
   * @param {boolean} isSilent  If true, generate idle animation targets.
   * @returns {number[]} Array of length BAR_COUNT with values 0-1.
   */
  Visualizer.prototype._computeTargets = function (isSilent) {
    var targets = new Array(BAR_COUNT);

    if (isSilent) {
      // ── Idle animation: gentle sine-wave bounce ──
      this._idlePhase += IDLE_SPEED;
      for (var i = 0; i < BAR_COUNT; i++) {
        var wave = (Math.sin(this._idlePhase + this._idleOffsets[i]) + 1) / 2; // 0-1
        targets[i] = IDLE_MIN_HEIGHT + wave * (IDLE_MAX_HEIGHT - IDLE_MIN_HEIGHT);
      }
    } else {
      // ── Live audio: sample evenly from frequency bins ──
      var binCount = this._freqData.length;
      for (var j = 0; j < BAR_COUNT; j++) {
        // Map bar index → frequency bin (use lower ~75 % of spectrum
        // to avoid near-empty high bins)
        var binIndex = Math.floor((j / BAR_COUNT) * binCount * 0.75);
        targets[j] = this._freqData[binIndex] / 255;
      }
    }

    return targets;
  };

  // ─── Internal — drawing ────────────────────────────────────────────

  /**
   * Render the current bar heights onto the canvas.
   */
  Visualizer.prototype._draw = function () {
    var ctx = this.ctx;
    var W = this.canvas.width;
    var H = this.canvas.height;

    // Clear the entire canvas
    ctx.clearRect(0, 0, W, H);

    // Usable area: bars sit in the top portion; reflection underneath
    var mainH = H * (1 - REFLECTION_HEIGHT_RATIO);
    var reflH = H * REFLECTION_HEIGHT_RATIO;

    // Bar geometry
    var totalBarWidth = (W - BAR_GAP * (BAR_COUNT + 1)) / BAR_COUNT;
    if (totalBarWidth < 1) totalBarWidth = 1;
    var barW = totalBarWidth;
    var radius = Math.min(CORNER_RADIUS, barW / 2);

    // ── Draw each bar ────────────────────────────────────────────
    for (var i = 0; i < BAR_COUNT; i++) {
      var normH = this._barHeights[i]; // 0-1
      var barH = Math.max(normH * mainH, 2); // at least 2 px
      var x = BAR_GAP + i * (barW + BAR_GAP);
      var y = mainH - barH;

      // Colour: lerp purple → cyan based on height, with pink for peaks
      var isPeak = normH > 0.85;
      var barColor;
      if (isPeak) {
        // Blend towards peak pink
        var peakT = (normH - 0.85) / 0.15; // 0-1 within peak range
        var midRgb = [
          Math.round(lerp(RGB_BOTTOM[0], RGB_TOP[0], normH)),
          Math.round(lerp(RGB_BOTTOM[1], RGB_TOP[1], normH)),
          Math.round(lerp(RGB_BOTTOM[2], RGB_TOP[2], normH))
        ];
        barColor = lerpColor(midRgb, RGB_PEAK, peakT);
      } else {
        barColor = lerpColor(RGB_BOTTOM, RGB_TOP, normH);
      }

      // Create vertical gradient for this bar
      var grad = ctx.createLinearGradient(x, y, x, mainH);
      grad.addColorStop(0, barColor);
      grad.addColorStop(1, COLOR_BOTTOM);

      // Glow effect via shadow
      ctx.shadowColor = barColor;
      ctx.shadowBlur = 12;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;

      // Draw rounded-top bar
      ctx.fillStyle = grad;
      ctx.beginPath();
      this._roundedTopRect(ctx, x, y, barW, barH, radius);
      ctx.fill();

      // ── Reflection (mirror below baseline) ──────────────────
      // Turn off shadow for the reflection to keep it subtle
      ctx.shadowBlur = 0;

      var reflBarH = barH * REFLECTION_HEIGHT_RATIO;
      var reflY = mainH; // starts right at the baseline

      // Gradient fading to transparent
      var reflGrad = ctx.createLinearGradient(x, reflY, x, reflY + reflBarH);
      reflGrad.addColorStop(0, this._colorWithAlpha(barColor, REFLECTION_OPACITY));
      reflGrad.addColorStop(1, this._colorWithAlpha(barColor, 0));

      ctx.fillStyle = reflGrad;
      ctx.beginPath();
      // Reflection is a simple rect (flat top, since it's the mirror)
      ctx.rect(x, reflY, barW, reflBarH);
      ctx.fill();
    }

    // Reset shadow state
    ctx.shadowBlur = 0;
  };

  /**
   * Draw a rectangle with rounded top-left and top-right corners.
   * Bottom corners are square (they sit on the baseline).
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r  Corner radius.
   */
  Visualizer.prototype._roundedTopRect = function (ctx, x, y, w, h, r) {
    // Clamp radius so it never exceeds half the dimension
    var radius = Math.min(r, w / 2, h / 2);

    // Use roundRect if the browser supports it (modern browsers)
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, [radius, radius, 0, 0]);
      return;
    }

    // Fallback: manual arcs
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
  };

  /**
   * Convert an "rgb(r,g,b)" or hex colour to "rgba(r,g,b,a)".
   *
   * @param {string} color  An rgb() or #hex string.
   * @param {number} alpha  Opacity 0-1.
   * @returns {string}
   */
  Visualizer.prototype._colorWithAlpha = function (color, alpha) {
    // If it's already rgb(...)
    if (color.indexOf('rgb(') === 0) {
      return color.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
    }
    // Hex
    var rgb = hexToRgb(color);
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha + ')';
  };

  // ─── Export ────────────────────────────────────────────────────────
  window.Visualizer = Visualizer;

})();
