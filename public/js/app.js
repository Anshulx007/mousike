/**
 * ============================================================================
 * App Controller — Mousike Main Application Logic (Improved)
 * ============================================================================
 *
 * Improvements:
 *   - Tap-to-copy room code
 *   - Toasts with icons
 *   - Manual sync offset slider
 *   - Auto-navigate guest to player
 *   - Better connection state management
 *   - Smoother screen transitions
 *   - Reconnection handling
 * ============================================================================
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════
  // State
  // ═══════════════════════════════════════════════════════════════════════

  var state = {
    socket: null,
    clockSync: null,
    audioEngine: null,
    visualizer: null,
    roomCode: null,
    isHost: false,
    otherConnected: false,
    musicLoaded: false,
    musicFile: null,
    musicArrayBuffer: null,
    receivedChunks: [],
    receivedSize: 0,
    expectedSize: 0,
    volume: 0.8,
    syncOffset: 0,         // Manual sync offset in ms
    seekBarDragging: false,
    updateInterval: null
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DOM References
  // ═══════════════════════════════════════════════════════════════════════

  var $ = function (id) { return document.getElementById(id); };

  var dom = {
    // Screens
    landingScreen: $('landingScreen'),
    roomScreen: $('roomScreen'),
    playerScreen: $('playerScreen'),

    // Landing
    btnCreateRoom: $('btnCreateRoom'),
    btnJoinRoom: $('btnJoinRoom'),
    joinInput: $('joinInput'),
    roomCodeInput: $('roomCodeInput'),
    btnSubmitJoin: $('btnSubmitJoin'),

    // Room
    btnLeaveRoom: $('btnLeaveRoom'),
    roomCodeDisplay: $('roomCodeDisplay'),
    roomCodeHint: $('roomCodeHint'),
    syncIndicator: $('syncIndicator'),
    userRole: $('userRole'),
    otherUserLabel: $('otherUserLabel'),
    otherUserBadge: $('otherUserBadge'),
    otherAvatar: $('otherAvatar'),
    connectionDot: $('connectionDot'),
    
    // Search & Upload
    searchSection: $('searchSection'),
    searchInput: $('searchInput'),
    btnSearch: $('btnSearch'),
    searchResults: $('searchResults'),
    uploadDivider: $('uploadDivider'),
    
    uploadSection: $('uploadSection'),
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    btnBrowse: $('btnBrowse'),
    transferSection: $('transferSection'),
    transferFileName: $('transferFileName'),
    transferProgress: $('transferProgress'),
    transferStatus: $('transferStatus'),
    btnCancelTransfer: $('btnCancelTransfer'),
    readySection: $('readySection'),
    btnGoToPlayer: $('btnGoToPlayer'),
    btnChangeSongReady: $('btnChangeSongReady'),

    // Player
    btnBackToRoom: $('btnBackToRoom'),
    playerSyncIndicator: $('playerSyncIndicator'),
    playerSyncDot: $('playerSyncDot'),
    playerSyncLabel: $('playerSyncLabel'),
    playerRoomCode: $('playerRoomCode'),
    visualizerCanvas: $('visualizerCanvas'),
    songTitle: $('songTitle'),
    songArtist: $('songArtist'),
    currentTime: $('currentTime'),
    totalTime: $('totalTime'),
    seekBar: $('seekBar'),
    btnPlayPause: $('btnPlayPause'),
    iconPlay: $('iconPlay'),
    iconPause: $('iconPause'),
    btnRewind: $('btnRewind'),
    btnForward: $('btnForward'),
    btnVolDown: $('btnVolDown'),
    btnVolUp: $('btnVolUp'),
    volumeSlider: $('volumeSlider'),
    syncOffsetSlider: $('syncOffsetSlider'),
    syncOffsetValue: $('syncOffsetValue'),
    toastContainer: $('toastContainer')
  };

  // ═══════════════════════════════════════════════════════════════════════
  // Utility functions
  // ═══════════════════════════════════════════════════════════════════════

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // SVG icons for toasts
  var TOAST_ICONS = {
    success: '<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#22c55e" stroke-width="1.5"/><path d="M6 10.5l2.5 2.5 5-5" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#ef4444" stroke-width="1.5"/><line x1="7" y1="7" x2="13" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/><line x1="13" y1="7" x2="7" y2="13" stroke="#ef4444" stroke-width="1.5" stroke-linecap="round"/></svg>',
    warning: '<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><path d="M10 2 L18.66 17 H1.34 Z" stroke="#f59e0b" stroke-width="1.5" stroke-linejoin="round" fill="none"/><line x1="10" y1="8" x2="10" y2="12" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14.5" r="0.8" fill="#f59e0b"/></svg>',
    info: '<svg class="toast__icon" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="9" stroke="#06b6d4" stroke-width="1.5"/><line x1="10" y1="9" x2="10" y2="14" stroke="#06b6d4" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="6.5" r="0.8" fill="#06b6d4"/></svg>'
  };

  /**
   * Show a toast notification with an icon.
   */
  function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 3000;

    var toast = document.createElement('div');
    toast.className = 'toast toast--' + type;
    toast.innerHTML = (TOAST_ICONS[type] || '') + '<span>' + message + '</span>';
    dom.toastContainer.appendChild(toast);

    setTimeout(function () {
      toast.classList.add('hide');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 400);
    }, duration);
  }

  /**
   * Switch to a screen with smooth transition.
   */
  function showScreen(screen) {
    var screens = [dom.landingScreen, dom.roomScreen, dom.playerScreen];
    screens.forEach(function (s) {
      s.classList.remove('active');
    });
    // Double rAF ensures the 'remove' has taken effect before we add 'active',
    // so the CSS transition actually runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        screen.classList.add('active');
      });
    });
  }

  /**
   * Update the sync status indicators on both screens.
   */
  function updateSyncStatus(status) {
    var labels = { synced: 'Synced', syncing: 'Syncing…', disconnected: 'Disconnected' };
    var classMap = { synced: 'sync-status--synced', syncing: 'sync-status--syncing', disconnected: 'sync-status--disconnected' };
    var cls = 'sync-status ' + (classMap[status] || '');

    dom.syncIndicator.className = cls;
    if (dom.playerSyncIndicator) dom.playerSyncIndicator.className = cls;

    var label = labels[status] || status;
    var syncLabels = document.querySelectorAll('.sync-label');
    syncLabels.forEach(function (el) { el.textContent = label; });
    if (dom.playerSyncLabel) dom.playerSyncLabel.textContent = label;
  }

  /**
   * Copy text to clipboard.
   */
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  /**
   * Set connection state UI.
   */
  function setConnectionState(connected) {
    state.otherConnected = connected;
    if (connected) {
      dom.connectionDot.classList.add('connected');
      dom.otherAvatar.classList.remove('user-badge__avatar--waiting');
      dom.otherAvatar.classList.add('user-badge__avatar--connected');
    } else {
      dom.connectionDot.classList.remove('connected');
      dom.otherAvatar.classList.add('user-badge__avatar--waiting');
      dom.otherAvatar.classList.remove('user-badge__avatar--connected');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Socket.IO Connection
  // ═══════════════════════════════════════════════════════════════════════

  function initSocket() {
    state.socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });

    state.socket.on('disconnect', function () {
      console.log('[App] Socket disconnected');
      updateSyncStatus('disconnected');
    });

    // In Socket.io v4, 'connect' fires on reconnects
    state.socket.on('connect', function () {
      console.log('[App] Socket connected:', state.socket.id);
      showToast('Connected to server', 'success');
      
      // If we were in a room, rejoin it without resetting UI
      if (state.roomCode) {
        state.socket.emit('room:rejoin', { code: state.roomCode, isHost: state.isHost }, function (response) {
          if (!response.success) {
            showToast('Room expired. Please create a new one.', 'warning');
            resetState();
            showScreen(dom.landingScreen);
          } else {
            console.log('[App] Successfully rejoined room');
          }
        });
      }
    });

    state.socket.on('connect_error', function () {
      updateSyncStatus('disconnected');
    });

    // ── Room events ──────────────────────────────────────────
    state.socket.on('room:userJoined', function () {
      setConnectionState(true);
      dom.otherUserLabel.textContent = 'Connected';
      showToast('A device joined your room!', 'success');

      if (state.isHost && state.musicArrayBuffer) {
        sendMusicToGuest();
      }
    });

    state.socket.on('room:guestLeft', function () {
      setConnectionState(false);
      dom.otherUserLabel.textContent = 'Waiting...';
      showToast('The other device left', 'warning');
    });

    state.socket.on('room:hostLeft', function () {
      showToast('Host left. Returning home.', 'error');
      resetState();
      showScreen(dom.landingScreen);
    });

    // ── Music events ────────────────────────────────────────
    state.socket.on('music:meta', function (meta) {
      if (state.isHost) return;
      console.log('[App] Received music meta:', meta.name);
      state.expectedSize = meta.size;
      state.receivedChunks = [];
      state.receivedSize = 0;

      dom.songTitle.textContent = meta.name.replace(/\.[^/.]+$/, '');
      dom.songArtist.textContent = 'Loading…';

      dom.uploadSection.classList.add('hidden');
      dom.transferSection.classList.remove('hidden');
      dom.transferFileName.textContent = meta.name;
      dom.transferStatus.textContent = 'Receiving…';
      dom.transferProgress.style.width = '0%';
    });

    state.socket.on('music:chunk', function (data) {
      if (state.isHost) return;
      state.receivedChunks.push(data.chunk);
      state.receivedSize += data.chunk.byteLength;

      var progress = Math.round((state.receivedSize / state.expectedSize) * 100);
      dom.transferProgress.style.width = progress + '%';
      dom.transferStatus.textContent = 'Receiving… ' + progress + '%';
    });

    state.socket.on('music:complete', function () {
      if (state.isHost) return;
      console.log('[App] Music transfer complete. Decoding…');
      dom.transferStatus.textContent = 'Decoding audio…';

      var totalSize = 0;
      state.receivedChunks.forEach(function (c) { totalSize += c.byteLength; });
      var combined = new Uint8Array(totalSize);
      var offset = 0;
      state.receivedChunks.forEach(function (c) {
        combined.set(new Uint8Array(c), offset);
        offset += c.byteLength;
      });

      ensureAudioEngine();
      state.audioEngine.loadArrayBuffer(combined.buffer).then(function (info) {
        state.musicLoaded = true;
        dom.transferStatus.textContent = 'Ready!';
        dom.totalTime.textContent = formatTime(info.duration);
        dom.songArtist.textContent = formatTime(info.duration);

        state.socket.emit('music:ready');
        showToast('Music loaded and ready!', 'success');
      }).catch(function (err) {
        console.error('[App] Guest decode error:', err);
        dom.transferStatus.textContent = 'Decode failed!';
        showToast('Failed to decode audio', 'error');
      });
    });

    state.socket.on('music:allReady', function () {
      console.log('[App] Both devices ready!');
      dom.readySection.classList.remove('hidden');
      showToast('Both devices ready. Let\'s go! 🎵', 'success');

      // Auto-navigate to player after a short delay
      setTimeout(function () {
        showScreen(dom.playerScreen);
        initVisualizer();
      }, 1200);
    });

    // ── Playback events ─────────────────────────────────────
    state.socket.on('playback:play', function (data) {
      console.log('[App] Play at server time:', data.serverTimestamp);
      ensureAudioEngine();

      if (data.position !== undefined && data.position > 0) {
        state.audioEngine.pausedAt = data.position;
      }

      // Apply manual sync offset
      var adjustedTimestamp = data.serverTimestamp + state.syncOffset;

      state.audioEngine.playAt(adjustedTimestamp).then(function () {
        updatePlayPauseUI(true);
        startUIUpdater();
      }).catch(function (err) {
        console.error('[App] Play error:', err);
        showToast('Playback error', 'error');
      });
    });

    state.socket.on('playback:pause', function (data) {
      ensureAudioEngine();
      state.audioEngine.pausedAt = data.position;
      state.audioEngine._stopSource();
      state.audioEngine.isPlaying = false;
      updatePlayPauseUI(false);
      stopUIUpdater();
      dom.currentTime.textContent = formatTime(data.position);
      updateSeekBar(data.position);
    });

    state.socket.on('playback:seek', function (data) {
      ensureAudioEngine();
      var adjustedTimestamp = data.serverTimestamp + state.syncOffset;
      state.audioEngine.seekTo(data.position, adjustedTimestamp);
    });

    // ── Clock sync ──────────────────────────────────────────
    state.clockSync = new ClockSync(state.socket);
    state.clockSync.start();
    updateSyncStatus('syncing');

    state.clockSync.onReady(function () {
      updateSyncStatus('synced');
      console.log('[App] Clock sync ready. Offset:', state.clockSync.getOffset().toFixed(2), 'ms');
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Audio Engine
  // ═══════════════════════════════════════════════════════════════════════

  function ensureAudioEngine() {
    if (!state.audioEngine) {
      state.audioEngine = new AudioEngine(state.clockSync);
      state.audioEngine.setVolume(state.volume);
    }
  }

  function initVisualizer() {
    if (state.visualizer) {
      state.visualizer.destroy();
    }
    ensureAudioEngine();
    state.visualizer = new Visualizer(
      dom.visualizerCanvas,
      state.audioEngine.getAnalyser()
    );
    state.visualizer.start();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Music file handling (Host)
  // ═══════════════════════════════════════════════════════════════════════

  function handleFileSelect(file) {
    if (!file) return;

    if (file.size > 15 * 1024 * 1024) {
      showToast('File too large. Max 15MB.', 'error');
      return;
    }

    if (!file.type.startsWith('audio/')) {
      showToast('Please select an audio file.', 'error');
      return;
    }

    state.musicFile = file;
    var displayName = file.name.replace(/\.[^/.]+$/, '');
    dom.songTitle.textContent = displayName;
    dom.songArtist.textContent = 'Loading…';

    dom.uploadSection.classList.add('hidden');
    dom.transferSection.classList.remove('hidden');
    dom.transferFileName.textContent = file.name;
    dom.transferStatus.textContent = 'Decoding…';
    dom.transferProgress.style.width = '0%';

    var reader = new FileReader();
    reader.onload = function () {
      state.musicArrayBuffer = reader.result;

      ensureAudioEngine();
      state.audioEngine.loadArrayBuffer(reader.result.slice(0)).then(function (info) {
        state.musicLoaded = true;
        dom.totalTime.textContent = formatTime(info.duration);
        dom.transferStatus.textContent = 'Loaded!';
        dom.transferProgress.style.width = '100%';
        dom.songArtist.textContent = formatTime(info.duration) + ' • ' + info.numberOfChannels + 'ch';

        state.socket.emit('music:meta', {
          name: file.name,
          size: state.musicArrayBuffer.byteLength,
          type: file.type,
          duration: info.duration
        });

        if (state.otherConnected) {
          sendMusicToGuest();
        } else {
          showToast('Waiting for another device…', 'info');
        }
      }).catch(function (err) {
        console.error('[App] Host decode error:', err);
        dom.transferStatus.textContent = 'Decode failed!';
        showToast('Failed to decode audio', 'error');
      });
    };
    reader.readAsArrayBuffer(file);
  }

  function sendMusicToGuest() {
    if (!state.musicArrayBuffer) return;

    console.log('[App] Sending music to guest…');
    dom.transferStatus.textContent = 'Sending to partner…';

    var CHUNK_SIZE = 64 * 1024;
    var buffer = state.musicArrayBuffer;
    var totalChunks = Math.ceil(buffer.byteLength / CHUNK_SIZE);
    var chunkIndex = 0;

    function sendNextChunk() {
      if (chunkIndex >= totalChunks) {
        state.socket.emit('music:complete');
        dom.transferStatus.textContent = 'Sent! Waiting…';
        return;
      }

      var start = chunkIndex * CHUNK_SIZE;
      var end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
      var chunk = buffer.slice(start, end);

      state.socket.emit('music:chunk', { chunk: chunk, index: chunkIndex });

      chunkIndex++;
      var progress = Math.round((chunkIndex / totalChunks) * 100);
      dom.transferProgress.style.width = progress + '%';
      dom.transferStatus.textContent = 'Sending… ' + progress + '%';

      setTimeout(sendNextChunk, 10);
    }

    sendNextChunk();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Player UI Updates
  // ═══════════════════════════════════════════════════════════════════════

  function updatePlayPauseUI(playing) {
    dom.iconPlay.classList.toggle('hidden', playing);
    dom.iconPause.classList.toggle('hidden', !playing);
  }

  function updateSeekBar(position) {
    if (!state.audioEngine || !state.audioEngine.duration) return;
    var pct = (position / state.audioEngine.duration) * 100;
    dom.seekBar.value = pct;
    dom.seekBar.style.background =
      'linear-gradient(90deg, #7c3aed 0%, #06b6d4 ' + pct + '%, rgba(255,255,255,0.08) ' + pct + '%)';
  }

  function startUIUpdater() {
    stopUIUpdater();
    state.updateInterval = setInterval(function () {
      if (!state.audioEngine || !state.audioEngine.isPlaying) return;
      var pos = state.audioEngine.getCurrentTime();
      dom.currentTime.textContent = formatTime(pos);

      if (!state.seekBarDragging) {
        updateSeekBar(pos);
      }

      if (pos >= state.audioEngine.duration - 0.1) {
        updatePlayPauseUI(false);
        stopUIUpdater();
      }
    }, 200);
  }

  function stopUIUpdater() {
    if (state.updateInterval) {
      clearInterval(state.updateInterval);
      state.updateInterval = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // State Reset
  // ═══════════════════════════════════════════════════════════════════════

  function resetState() {
    state.roomCode = null;
    state.isHost = false;
    state.otherConnected = false;
    state.musicLoaded = false;
    state.musicFile = null;
    state.musicArrayBuffer = null;
    state.receivedChunks = [];
    state.receivedSize = 0;
    state.expectedSize = 0;
    state.seekBarDragging = false;
    stopUIUpdater();

    if (state.visualizer) {
      state.visualizer.destroy();
      state.visualizer = null;
    }

    dom.joinInput.classList.add('hidden');
    dom.uploadSection.classList.remove('hidden');
    
    if (dom.searchSection) dom.searchSection.classList.remove('hidden');
    if (dom.uploadDivider) dom.uploadDivider.classList.remove('hidden');
    if (dom.searchResults) {
      dom.searchResults.innerHTML = '';
      dom.searchResults.classList.add('hidden');
    }
    if (dom.searchInput) dom.searchInput.value = '';
    
    dom.transferSection.classList.add('hidden');
    dom.readySection.classList.add('hidden');
    dom.transferProgress.style.width = '0%';
    dom.roomCodeDisplay.textContent = '----';
    dom.otherUserLabel.textContent = 'Waiting...';
    setConnectionState(false);
    dom.songTitle.textContent = 'No song loaded';
    dom.songArtist.textContent = 'Select a track to play';
    dom.currentTime.textContent = '0:00';
    dom.totalTime.textContent = '0:00';
    updateSeekBar(0);
    updatePlayPauseUI(false);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Handlers
  // ═══════════════════════════════════════════════════════════════════════

  function bindEvents() {

    // ── Landing ───────────────────────────────────────────────

    dom.btnCreateRoom.addEventListener('click', function () {
      state.socket.emit('room:create', function (response) {
        if (response.success) {
          state.roomCode = response.code;
          state.isHost = true;
          dom.roomCodeDisplay.textContent = response.code;
          dom.userRole.textContent = '(host)';
          dom.playerRoomCode.textContent = 'Room: ' + response.code;
          showScreen(dom.roomScreen);
          showToast('Room created!', 'success');
        } else {
          showToast('Failed to create room', 'error');
        }
      });
    });

    dom.btnJoinRoom.addEventListener('click', function () {
      dom.joinInput.classList.toggle('hidden');
      if (!dom.joinInput.classList.contains('hidden')) {
        setTimeout(function () { dom.roomCodeInput.focus(); }, 100);
      }
    });

    dom.btnSubmitJoin.addEventListener('click', submitJoin);
    dom.roomCodeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitJoin();
    });

    function submitJoin() {
      var code = dom.roomCodeInput.value.trim();
      if (code.length !== 4) {
        showToast('Enter a 4-digit room code', 'warning');
        return;
      }

      state.socket.emit('room:join', { code: code }, function (response) {
        if (response.success) {
          state.roomCode = response.code;
          state.isHost = false;
          dom.roomCodeDisplay.textContent = response.code;
          dom.userRole.textContent = '(guest)';
          dom.playerRoomCode.textContent = 'Room: ' + response.code;
          dom.uploadSection.classList.add('hidden');
          dom.otherUserLabel.textContent = 'Host';
          setConnectionState(true);
          showScreen(dom.roomScreen);
          showToast('Joined room ' + code + '!', 'success');
        } else {
          showToast(response.error || 'Failed to join', 'error');
          dom.roomCodeInput.value = '';
          dom.roomCodeInput.focus();
        }
      });
    }

    // ── Room ─────────────────────────────────────────────────

    // Tap to copy room code
    dom.roomCodeDisplay.addEventListener('click', function () {
      if (state.roomCode) {
        copyToClipboard(state.roomCode).then(function () {
          dom.roomCodeDisplay.classList.add('copied');
          dom.roomCodeHint.textContent = 'Copied!';
          showToast('Room code copied!', 'success', 1500);
          setTimeout(function () {
            dom.roomCodeDisplay.classList.remove('copied');
            dom.roomCodeHint.textContent = 'Tap the code to copy • Share with your friend';
          }, 2000);
        });
      }
    });

    dom.btnLeaveRoom.addEventListener('click', function () {
      resetState();
      showScreen(dom.landingScreen);
      state.socket.disconnect();
      state.socket.connect();
    });

    // ── Online Search ────────────────────────────────────────
    
    function performSearch() {
      var query = dom.searchInput.value.trim();
      if (!query) return;
      
      dom.searchResults.innerHTML = '<div class="search-loading">Searching...</div>';
      dom.searchResults.classList.remove('hidden');
      
      fetch('/api/search?q=' + encodeURIComponent(query))
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data.results || data.results.length === 0) {
            dom.searchResults.innerHTML = '<div class="search-loading">No results found.</div>';
            return;
          }
          
          dom.searchResults.innerHTML = '';
          data.results.forEach(function (video) {
            var item = document.createElement('div');
            item.className = 'search-result-item';
            
            var img = document.createElement('img');
            img.src = video.image;
            img.loading = 'lazy';
            
            var info = document.createElement('div');
            info.className = 'search-result-info';
            
            var title = document.createElement('div');
            title.className = 'search-result-title';
            title.textContent = video.title;
            title.title = video.title;
            
            var author = document.createElement('div');
            author.className = 'search-result-author';
            author.textContent = video.author + ' • ' + video.duration;
            
            info.appendChild(title);
            info.appendChild(author);
            
            item.appendChild(img);
            item.appendChild(info);
            
            item.addEventListener('click', function () {
              loadOnlineAudio(video);
            });
            
            dom.searchResults.appendChild(item);
          });
        })
        .catch(function (err) {
          console.error(err);
          dom.searchResults.innerHTML = '<div class="search-loading">Search failed.</div>';
          showToast('Failed to fetch search results', 'error');
        });
    }

    dom.btnSearch.addEventListener('click', performSearch);
    dom.searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') performSearch();
    });

    function loadOnlineAudio(video) {
      dom.searchSection.classList.add('hidden');
      dom.uploadDivider.classList.add('hidden');
      dom.uploadSection.classList.add('hidden');
      dom.transferSection.classList.remove('hidden');
      
      dom.songTitle.textContent = video.title;
      dom.songArtist.textContent = video.author;
      dom.transferFileName.textContent = video.title;
      dom.transferStatus.textContent = 'Downloading stream...';
      dom.transferProgress.style.width = '30%';
      
      fetch('/api/stream?url=' + encodeURIComponent(video.url))
        .then(function(res) {
          if (!res.ok) throw new Error('Network response was not ok');
          dom.transferStatus.textContent = 'Decoding stream...';
          dom.transferProgress.style.width = '70%';
          return res.arrayBuffer();
        })
        .then(function(arrayBuffer) {
          state.musicArrayBuffer = arrayBuffer;
          
          ensureAudioEngine();
          return state.audioEngine.loadArrayBuffer(arrayBuffer.slice(0));
        })
        .then(function(info) {
          state.musicLoaded = true;
          dom.totalTime.textContent = formatTime(info.duration);
          dom.transferStatus.textContent = 'Loaded!';
          dom.transferProgress.style.width = '100%';
          
          state.socket.emit('music:meta', {
            name: video.title,
            size: state.musicArrayBuffer.byteLength,
            type: 'audio/mp4', // yt-dlp bestaudio
            duration: info.duration
          });
          
          if (state.otherConnected) {
            sendMusicToGuest();
          } else {
            showToast('Waiting for another device…', 'info');
          }
        })
        .catch(function(err) {
          console.error('[App] Online audio load error:', err);
          dom.transferStatus.textContent = 'Failed to load audio!';
          dom.transferProgress.style.width = '0%';
          showToast('Could not load online audio.', 'error');
          setTimeout(resetState, 2000);
        });
    }

    // File upload
    dom.btnBrowse.addEventListener('click', function () {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener('change', function (e) {
      if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
      }
    });

    // Drag and drop
    dom.dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dom.dropZone.classList.add('dragover');
    });
    dom.dropZone.addEventListener('dragleave', function () {
      dom.dropZone.classList.remove('dragover');
    });
    dom.dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dom.dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });

    // Also allow clicking the upload area itself (not just the button)
    dom.dropZone.addEventListener('click', function (e) {
      if (e.target === dom.btnBrowse || dom.btnBrowse.contains(e.target)) return;
      dom.fileInput.click();
    });

    // Go to player
    dom.btnGoToPlayer.addEventListener('click', function () {
      showScreen(dom.playerScreen);
      initVisualizer();
    });

    // Change Song
    function handleChangeSong() {
      // Hide transfer and ready sections
      dom.transferSection.classList.add('hidden');
      dom.readySection.classList.add('hidden');
      
      // Show upload and search sections
      if (dom.searchSection) dom.searchSection.classList.remove('hidden');
      if (dom.uploadDivider) dom.uploadDivider.classList.remove('hidden');
      dom.uploadSection.classList.remove('hidden');
      
      // Clear current state
      state.musicLoaded = false;
      state.musicFile = null;
      state.musicArrayBuffer = null;
      
      // We don't notify the guest directly since there's no music:cancel event, 
      // but they will just overwrite their buffer when we upload a new one.
      showToast('You can now select a different song.', 'info');
    }
    
    if (dom.btnCancelTransfer) dom.btnCancelTransfer.addEventListener('click', handleChangeSong);
    if (dom.btnChangeSongReady) dom.btnChangeSongReady.addEventListener('click', handleChangeSong);

    // ── Player ───────────────────────────────────────────────

    dom.btnBackToRoom.addEventListener('click', function () {
      showScreen(dom.roomScreen);
    });

    // Play / Pause
    dom.btnPlayPause.addEventListener('click', function () {
      ensureAudioEngine();

      if (state.audioEngine.audioContext.state === 'suspended') {
        state.audioEngine.audioContext.resume();
      }

      if (!state.audioEngine.isLoaded()) {
        showToast('No song loaded yet', 'warning');
        return;
      }

      if (state.audioEngine.isPlaying) {
        var position = state.audioEngine.pause();
        state.socket.emit('playback:pause', { position: position });
      } else {
        var serverTimestamp = state.clockSync.getSyncedTime() + 500;
        state.socket.emit('playback:play', {
          serverTimestamp: serverTimestamp,
          position: state.audioEngine.pausedAt
        });
      }
    });

    // Seek bar
    dom.seekBar.addEventListener('input', function () {
      state.seekBarDragging = true;
      var pct = parseFloat(dom.seekBar.value);
      if (state.audioEngine && state.audioEngine.duration) {
        dom.currentTime.textContent = formatTime((pct / 100) * state.audioEngine.duration);
        dom.seekBar.style.background =
          'linear-gradient(90deg, #7c3aed 0%, #06b6d4 ' + pct + '%, rgba(255,255,255,0.08) ' + pct + '%)';
      }
    });

    dom.seekBar.addEventListener('change', function () {
      state.seekBarDragging = false;
      if (!state.audioEngine || !state.audioEngine.duration) return;
      var pct = parseFloat(dom.seekBar.value);
      var position = (pct / 100) * state.audioEngine.duration;
      var serverTimestamp = state.clockSync.getSyncedTime() + 500;
      state.socket.emit('playback:seek', { position: position, serverTimestamp: serverTimestamp });
    });

    // Rewind / Forward 10s
    dom.btnRewind.addEventListener('click', function () {
      if (!state.audioEngine || !state.audioEngine.isLoaded()) return;
      var pos = Math.max(0, state.audioEngine.getCurrentTime() - 10);
      var ts = state.clockSync.getSyncedTime() + 500;
      state.socket.emit('playback:seek', { position: pos, serverTimestamp: ts });
    });

    dom.btnForward.addEventListener('click', function () {
      if (!state.audioEngine || !state.audioEngine.isLoaded()) return;
      var pos = Math.min(state.audioEngine.duration, state.audioEngine.getCurrentTime() + 10);
      var ts = state.clockSync.getSyncedTime() + 500;
      state.socket.emit('playback:seek', { position: pos, serverTimestamp: ts });
    });

    // Volume
    dom.volumeSlider.addEventListener('input', function () {
      state.volume = parseInt(dom.volumeSlider.value) / 100;
      if (state.audioEngine) state.audioEngine.setVolume(state.volume);
    });

    dom.btnVolDown.addEventListener('click', function () {
      state.volume = Math.max(0, state.volume - 0.1);
      dom.volumeSlider.value = Math.round(state.volume * 100);
      if (state.audioEngine) state.audioEngine.setVolume(state.volume);
    });

    dom.btnVolUp.addEventListener('click', function () {
      state.volume = Math.min(1, state.volume + 0.1);
      dom.volumeSlider.value = Math.round(state.volume * 100);
      if (state.audioEngine) state.audioEngine.setVolume(state.volume);
    });

    // Manual sync offset
    dom.syncOffsetSlider.addEventListener('input', function () {
      state.syncOffset = parseInt(dom.syncOffsetSlider.value);
      var sign = state.syncOffset >= 0 ? '+' : '';
      dom.syncOffsetValue.textContent = sign + state.syncOffset + 'ms';
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Initialize
  // ═══════════════════════════════════════════════════════════════════════

  function init() {
    initSocket();
    bindEvents();
    updateSeekBar(0);
    dom.volumeSlider.value = Math.round(state.volume * 100);
    dom.syncOffsetSlider.value = 0;
    console.log('[App] Mousike initialized.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
