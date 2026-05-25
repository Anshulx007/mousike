const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ─── Create Express + Socket.IO server ────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50 * 1024 * 1024, // 50MB max for music file transfer
  pingTimeout: 120000,    // 2 min — survives mobile file picker dialog
  pingInterval: 30000,    // 30s between pings
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Enable JSON body parsing for POST endpoints
app.use(express.json());

const ytSearch = require('yt-search');
const youtubedl = require('youtube-dl-exec');

// ─── YouTube APIs ─────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  try {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Query required' });
    const r = await ytSearch(query);
    const videos = r.videos.slice(0, 10).map(v => ({
      title: v.title,
      url: v.url,
      author: v.author.name,
      duration: v.timestamp,
      image: v.image
    }));
    res.json({ results: videos });
  } catch (err) {
    console.error('[API] Search error:', err);
    res.status(500).json({ error: 'Failed to search' });
  }
});

app.get('/api/stream', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL required' });

  console.log(`[API] Streaming audio for: ${url}`);
  
  // Try to hint to the browser that it's audio
  res.setHeader('Content-Type', 'audio/mp4');
  
  const subprocess = youtubedl.exec(url, {
    f: 'bestaudio',
    o: '-' // Write to stdout
  });

  subprocess.stdout.pipe(res);

  subprocess.on('close', (code) => {
    if (code !== 0) console.error(`[API] Stream closed with code ${code}`);
  });
  
  subprocess.on('error', (err) => {
    console.error('[API] yt-dlp stream error:', err);
    if (!res.headersSent) res.status(500).send('Error streaming');
  });
});

// ─── Room Management ──────────────────────────────────────────────────
const rooms = new Map(); // roomCode -> { host, guest, musicMeta, chunks[] }

/**
 * Generate a random 4-digit room code that isn't already in use.
 */
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  } while (rooms.has(code));
  return code;
}

/**
 * Get the room a socket belongs to (if any).
 */
function getSocketRoom(socket) {
  for (const [code, room] of rooms.entries()) {
    if (room.host === socket.id || room.guest === socket.id) {
      return { code, room };
    }
  }
  return null;
}

// ─── Socket.IO Connection Handler ─────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Clock Synchronization (NTP-style) ─────────────────────────────
  // Client sends t0 (its local time), server responds with t1 (server time).
  // Client records t2 on receipt, calculates offset.
  socket.on('clock:ping', (data) => {
    socket.emit('clock:pong', {
      t0: data.t0,           // echo back client's send time
      t1: Date.now()         // server's current time
    });
  });

  // ── Room: Create ──────────────────────────────────────────────────
  socket.on('room:create', (callback) => {
    // Leave any existing room first
    leaveCurrentRoom(socket);

    const code = generateRoomCode();
    rooms.set(code, {
      host: socket.id,
      guest: null,
      musicMeta: null,
      musicChunks: [],
      musicReady: false
    });

    socket.join(code);
    console.log(`[Room] Created: ${code} by ${socket.id}`);

    callback({ success: true, code });
  });

  // ── Room: Join ────────────────────────────────────────────────────
  socket.on('room:join', (data, callback) => {
    const code = data.code;
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, error: 'Room not found' });
    }
    if (room.guest) {
      return callback({ success: false, error: 'Room is full' });
    }

    // Leave any existing room first
    leaveCurrentRoom(socket);

    room.guest = socket.id;
    socket.join(code);
    console.log(`[Room] ${socket.id} joined room ${code}`);

    // Notify the host that someone joined
    io.to(room.host).emit('room:userJoined', { userId: socket.id });

    callback({ success: true, code });

    // If music was already loaded, send metadata to the new guest
    if (room.musicMeta) {
      socket.emit('music:meta', room.musicMeta);
    }
  });

  // ── Music: Host uploads metadata ──────────────────────────────────
  socket.on('music:meta', (meta) => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code, room } = found;
    room.musicMeta = meta;
    room.musicChunks = [];
    room.musicReady = false;

    // Forward metadata to the other device in the room
    socket.to(code).emit('music:meta', meta);
    console.log(`[Music] Meta received in room ${code}: ${meta.name} (${(meta.size / 1024 / 1024).toFixed(1)}MB)`);
  });

  // ── Music: File transfer in chunks ────────────────────────────────
  socket.on('music:chunk', (data) => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code, room } = found;

    // Forward chunk to the other device
    socket.to(code).emit('music:chunk', data);
  });

  // ── Music: Transfer complete ──────────────────────────────────────
  socket.on('music:complete', () => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code, room } = found;
    room.musicReady = true;

    socket.to(code).emit('music:complete');
    console.log(`[Music] Transfer complete in room ${code}`);
  });

  // ── Music: Guest acknowledges ready ───────────────────────────────
  socket.on('music:ready', () => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code } = found;

    // Tell everyone in the room that both are ready
    io.to(code).emit('music:allReady');
    console.log(`[Music] All ready in room ${code}`);
  });

  // ── Playback: Play ────────────────────────────────────────────────
  // Host sends play command with a future server timestamp
  socket.on('playback:play', (data) => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code } = found;

    // Broadcast to everyone in room (including sender for consistency)
    io.to(code).emit('playback:play', {
      serverTimestamp: data.serverTimestamp || (Date.now() + 500), // play 500ms from now
      position: data.position || 0
    });

    console.log(`[Playback] Play in room ${code} at server time ${data.serverTimestamp}`);
  });

  // ── Playback: Pause ───────────────────────────────────────────────
  socket.on('playback:pause', (data) => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code } = found;
    io.to(code).emit('playback:pause', {
      position: data.position
    });

    console.log(`[Playback] Pause in room ${code} at position ${data.position}`);
  });

  // ── Playback: Seek ────────────────────────────────────────────────
  socket.on('playback:seek', (data) => {
    const found = getSocketRoom(socket);
    if (!found) return;

    const { code } = found;
    io.to(code).emit('playback:seek', {
      position: data.position,
      serverTimestamp: data.serverTimestamp || (Date.now() + 500)
    });

    console.log(`[Playback] Seek in room ${code} to ${data.position}s`);
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    leaveCurrentRoom(socket);
  });
});

/**
 * Remove a socket from its current room and notify the other user.
 */
function leaveCurrentRoom(socket) {
  const found = getSocketRoom(socket);
  if (!found) return;

  const { code, room } = found;

  if (room.host === socket.id) {
    // Host left — notify guest and destroy room
    if (room.guest) {
      io.to(room.guest).emit('room:hostLeft');
    }
    rooms.delete(code);
    console.log(`[Room] Destroyed: ${code} (host left)`);
  } else if (room.guest === socket.id) {
    // Guest left — notify host
    room.guest = null;
    room.musicReady = false;
    io.to(room.host).emit('room:guestLeft');
    console.log(`[Room] Guest left room ${code}`);
  }

  socket.leave(code);
}

// ─── Start Server ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Get local network IP for mobile access
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  const localIP = getLocalIP();
  console.log('');
  console.log('  🎵  Mousike — Synchronized Music Player');
  console.log('  ────────────────────────────────────────');
  console.log(`  Local:    http://localhost:${PORT}`);
  console.log(`  Network:  http://${localIP}:${PORT}`);
  console.log('');
  console.log('  Open the Network URL on both phones to start!');
  console.log('');
});
