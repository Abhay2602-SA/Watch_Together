/**
 * AS watch-together — server
 *
 * Responsibilities:
 *  - Serve the static client
 *  - Manage rooms in memory, with durable snapshots in SQLite (server/db.js)
 *    so chat/video/queue survive a restart
 *  - Relay chat messages, detect @mentions and notify
 *  - Keep playback state in sync across everyone in a room (host/moderator
 *    authoritative)
 *  - Enforce room passwords, an optional waiting room, and moderator
 *    permissions (kick / force-mute / promote)
 *  - Relay WebRTC signaling for voice / video / screen share (mesh topology)
 */

require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");
const db = require("./db");
const { registerAuthRoutes, sessionMiddleware } = require("./auth");
const { registerAiRoutes } = require("./ai");
const { registerPlaylistRoutes } = require("./playlists");
const { registerDashboardRoutes, checkPartiesStartingSoon } = require("./dashboard");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
registerAuthRoutes(app); // mounts session + passport + /auth/* + /api/me + /api/friends* + /api/profile + /api/notifications
registerAiRoutes(app); // mounts /api/ai/generate + /api/subtitles/translate
registerPlaylistRoutes(app); // mounts /api/playlists* + /api/bookmarks*
registerDashboardRoutes(app, { onlineAccountIds: () => onlineAccountIds }); // mounts /api/dashboard + /api/parties
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// Share the same session (and therefore logged-in user) between Express
// and Socket.io, so a socket connection knows who it belongs to.
io.engine.use(sessionMiddleware);

// In-memory live rooms. Durable fields (chat, video, playlist, password,
// waiting-room flag, moderators) are mirrored to SQLite via
// db.saveRoomSnapshot so a server restart doesn't erase them — see
// rehydrateRoomIfNeeded below.
const rooms = new Map();

// accountId -> number of currently-connected sockets for that account.
// Used for "friends online" on the dashboard.
const onlineAccountIds = new Set();
const onlineAccountSocketCounts = new Map();

function markOnline(accountId) {
  if (!accountId) return;
  onlineAccountSocketCounts.set(accountId, (onlineAccountSocketCounts.get(accountId) || 0) + 1);
  onlineAccountIds.add(accountId);
}
function markOffline(accountId) {
  if (!accountId) return;
  const n = (onlineAccountSocketCounts.get(accountId) || 1) - 1;
  if (n <= 0) {
    onlineAccountSocketCounts.delete(accountId);
    onlineAccountIds.delete(accountId);
  } else {
    onlineAccountSocketCounts.set(accountId, n);
  }
}

function makeRoom(id, hostSocketId, hostUsername, hostAccountId, opts = {}) {
  const room = {
    id,
    hostSocketId,
    hostAccountId: hostAccountId || null,
    name: opts.name || null,
    password: opts.password || null,
    waitingRoomEnabled: !!opts.waitingRoomEnabled,
    moderatorAccountIds: new Set(opts.moderatorAccountIds || []),
    pending: new Map(), // socketId -> { socket, username, accountId }
    users: new Map(), // socketId -> { id, username, accountId, avatarUrl }
    chat: opts.chat || [],
    playlist: opts.playlist || [], // [{ url, title, addedBy }]
    video: opts.video || {
      url: null,
      type: "none",
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1,
      lastUpdate: Date.now(),
    },
    screenShare: { active: false, socketId: null, username: null },
  };
  rooms.set(id, room);
  return room;
}

function roomUserList(room) {
  return Array.from(room.users.values()).map((u) => ({
    ...u,
    isModerator: !!(u.accountId && room.moderatorAccountIds.has(u.accountId)),
  }));
}

function publicState(room) {
  return {
    roomId: room.id,
    hostId: room.hostSocketId,
    waitingRoomEnabled: room.waitingRoomEnabled,
    hasPassword: !!room.password,
    users: roomUserList(room),
    chat: room.chat.slice(-100),
    video: room.video,
    screenShare: room.screenShare,
    playlist: room.playlist,
  };
}

function persist(room) {
  try {
    db.saveRoomSnapshot(room);
  } catch (err) {
    console.error("[db] failed to save room snapshot:", err);
  }
}

function detectVideoType(url) {
  const youtubeRegex =
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/i;
  const match = url.match(youtubeRegex);
  if (match) return { type: "youtube", videoId: match[1] };

  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(url)) {
    return { type: "file" };
  }

  // Anything else (Netflix, Prime Video, local VLC, desktop apps) can't be
  // embedded or remote-controlled from the browser — fall back to screen share.
  return { type: "screenshare-required" };
}

function socketUser(socket) {
  const passportUser = socket.request.session?.passport?.user;
  return passportUser ? db.getUser(passportUser) : null;
}

function canModerate(room, socket) {
  if (socket.id === room.hostSocketId) return true;
  const u = room.users.get(socket.id);
  return !!(u?.accountId && room.moderatorAccountIds.has(u.accountId));
}

// If a room isn't live in memory (e.g. after a server restart) but we have
// a durable snapshot for it, rehydrate it so the link keeps working.
function rehydrateRoomIfNeeded(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);
  const snapshot = db.loadRoomSnapshot(roomId);
  if (!snapshot) return null;
  return makeRoom(roomId, null, null, snapshot.hostAccountId, {
    name: snapshot.name,
    password: snapshot.password,
    waitingRoomEnabled: snapshot.waitingRoomEnabled,
    moderatorAccountIds: snapshot.moderatorAccountIds,
    chat: snapshot.chat,
    playlist: snapshot.playlist,
    video: snapshot.video,
  });
}

function applyVideoUrl(room, roomId, url) {
  const detected = detectVideoType(url);
  if (detected.type === "screenshare-required") return { screenshareRequired: true };

  room.video = {
    url,
    type: detected.type,
    videoId: detected.videoId || null,
    isPlaying: false,
    currentTime: 0,
    playbackRate: 1,
    lastUpdate: Date.now(),
  };
  io.to(roomId).emit("video-changed", room.video);
  room.users.forEach((u) => {
    if (u.accountId) db.recordWatchHistory(u.accountId, roomId, url);
  });
  persist(room);
  return { ok: true };
}

function finalizeJoin(socket, room, { username, account }) {
  room.users.set(socket.id, {
    id: socket.id,
    username: account?.name || (username || "Guest").slice(0, 24),
    accountId: account?.id || null,
    avatarUrl: account?.avatar_url || null,
  });
  socket.join(room.id);
  markOnline(account?.id);

  if (!room.hostSocketId) room.hostSocketId = socket.id; // rehydrated room with nobody in it yet

  socket.emit("joined-room", {
    userId: socket.id,
    isHost: socket.id === room.hostSocketId,
    isModerator: canModerate(room, socket),
    state: publicState(room),
  });

  socket.to(room.id).emit("user-joined", { user: room.users.get(socket.id) });
  persist(room);
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ username, password, waitingRoomEnabled, roomId }) => {
    const account = socketUser(socket);
    const id = roomId && !rooms.has(roomId) && !db.loadRoomSnapshot(roomId) ? roomId : nanoid(8);
    const room = makeRoom(id, socket.id, account?.name, account?.id, {
      password: password ? String(password).slice(0, 100) : null,
      waitingRoomEnabled: !!waitingRoomEnabled,
    });
    room.users.set(socket.id, {
      id: socket.id,
      username: account?.name || (username || "Host").slice(0, 24),
      accountId: account?.id || null,
      avatarUrl: account?.avatar_url || null,
    });
    socket.join(room.id);
    markOnline(account?.id);
    persist(room);

    socket.emit("room-created", { roomId: room.id });
    socket.emit("joined-room", {
      userId: socket.id,
      isHost: true,
      isModerator: true,
      state: publicState(room),
    });
  });

  socket.on("join-room", ({ roomId, username, password }) => {
    const room = rehydrateRoomIfNeeded(roomId);
    if (!room) {
      socket.emit("error-message", { message: "That room doesn't exist." });
      return;
    }

    // Already in the room (e.g. duplicate event) — no-op.
    if (room.users.has(socket.id)) return;

    if (room.password && room.password !== password) {
      socket.emit("password-required", { message: password ? "Incorrect password." : "This room requires a password." });
      return;
    }

    const account = socketUser(socket);

    if (room.waitingRoomEnabled && room.hostSocketId && socket.id !== room.hostSocketId) {
      room.pending.set(socket.id, { socket, username, account });
      socket.emit("waiting-approval");
      if (room.hostSocketId) {
        io.to(room.hostSocketId).emit("join-request", {
          socketId: socket.id,
          username: account?.name || username || "Guest",
        });
      }
      return;
    }

    finalizeJoin(socket, room, { username, account });
  });

  socket.on("approve-join", ({ roomId, socketId }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    const pending = room.pending.get(socketId);
    if (!pending) return;
    room.pending.delete(socketId);
    pending.socket.emit("join-approved");
    finalizeJoin(pending.socket, room, { username: pending.username, account: pending.account });
  });

  socket.on("deny-join", ({ roomId, socketId }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    const pending = room.pending.get(socketId);
    if (!pending) return;
    room.pending.delete(socketId);
    pending.socket.emit("join-denied");
  });

  socket.on("set-room-security", ({ roomId, password, waitingRoomEnabled }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    room.password = password ? String(password).slice(0, 100) : null;
    room.waitingRoomEnabled = !!waitingRoomEnabled;
    persist(room);
    socket.emit("room-security-updated", { hasPassword: !!room.password, waitingRoomEnabled: room.waitingRoomEnabled });
  });

  socket.on("set-moderator", ({ roomId, targetSocketId, isModerator }) => {
    const room = rooms.get(roomId);
    if (!room || socket.id !== room.hostSocketId) return;
    const target = room.users.get(targetSocketId);
    if (!target) return;
    if (!target.accountId) {
      socket.emit("error-message", { message: "Only signed-in users can be made moderators." });
      return;
    }
    if (isModerator) room.moderatorAccountIds.add(target.accountId);
    else room.moderatorAccountIds.delete(target.accountId);
    persist(room);
    io.to(roomId).emit("moderators-updated", { users: roomUserList(room) });
  });

  socket.on("kick-user", ({ roomId, targetSocketId }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket) || targetSocketId === room.hostSocketId) return;
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit("kicked");
      targetSocket.leave(roomId);
    }
    room.users.delete(targetSocketId);
    io.to(roomId).emit("user-left", { userId: targetSocketId });
    persist(room);
  });

  socket.on("force-mute", ({ roomId, targetSocketId }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    io.to(targetSocketId).emit("force-mute");
  });

  socket.on("invite-friend", ({ roomId, friendAccountId }) => {
    const room = rooms.get(roomId);
    const account = socketUser(socket);
    if (!room || !account || !friendAccountId) return;
    db.addNotification(friendAccountId, "room_invite", {
      fromUserId: account.id,
      fromName: account.name,
      roomId,
    });
    socket.emit("invite-sent");
  });

  socket.on("chat-message", ({ roomId, message }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id)) return;
    const user = room.users.get(socket.id);
    const text = String(message).slice(0, 1000);
    const entry = {
      id: nanoid(10),
      userId: socket.id,
      username: user.username,
      message: text,
      timestamp: Date.now(),
    };
    room.chat.push(entry);
    if (room.chat.length > 500) room.chat.shift();
    io.to(roomId).emit("chat-message", entry);

    // @mentions -> notify signed-in mentioned users.
    const mentioned = text.match(/@(\w[\w-]*)/g) || [];
    if (mentioned.length) {
      const names = new Set(mentioned.map((m) => m.slice(1).toLowerCase()));
      room.users.forEach((u) => {
        if (u.id !== socket.id && u.accountId && names.has(u.username.toLowerCase())) {
          db.addNotification(u.accountId, "mention", {
            byName: user.username,
            roomId,
            message: text.slice(0, 200),
          });
        }
      });
    }

    persist(room);
  });

  socket.on("set-video-url", ({ roomId, url }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    const result = applyVideoUrl(room, roomId, url);
    if (result.screenshareRequired) socket.emit("screenshare-required", { url });
  });

  socket.on("playback-control", ({ roomId, action, time, rate }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;

    if (action === "play") {
      room.video.isPlaying = true;
      room.video.currentTime = time ?? room.video.currentTime;
    } else if (action === "pause") {
      room.video.isPlaying = false;
      room.video.currentTime = time ?? room.video.currentTime;
    } else if (action === "seek") {
      room.video.currentTime = time ?? room.video.currentTime;
    } else if (action === "rate") {
      room.video.playbackRate = rate ?? room.video.playbackRate;
    }
    room.video.lastUpdate = Date.now();

    socket.to(roomId).emit("playback-update", {
      action,
      time: room.video.currentTime,
      rate: room.video.playbackRate,
      serverTime: room.video.lastUpdate,
    });
  });

  socket.on("request-state", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    socket.emit("room-state", publicState(room));
  });

  // ---------------- in-room "up next" queue ----------------

  socket.on("playlist-add", ({ roomId, url, title }) => {
    const room = rooms.get(roomId);
    if (!room || !room.users.has(socket.id) || !url) return;
    const user = room.users.get(socket.id);
    room.playlist.push({ url, title: (title || url).slice(0, 120), addedBy: user.username });
    io.to(roomId).emit("playlist-updated", room.playlist);
    persist(room);
  });

  socket.on("playlist-remove", ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    room.playlist.splice(index, 1);
    io.to(roomId).emit("playlist-updated", room.playlist);
    persist(room);
  });

  socket.on("playlist-play", ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room || !canModerate(room, socket)) return;
    const item = room.playlist[index];
    if (!item) return;
    const result = applyVideoUrl(room, roomId, item.url);
    if (result.screenshareRequired) socket.emit("screenshare-required", { url: item.url });
  });

  // ---------------- screen share ----------------

  socket.on("start-screen-share", ({ roomId, streamId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.screenShare.active) {
      socket.emit("error-message", { message: "Someone is already sharing their screen in this room." });
      return;
    }
    const user = room.users.get(socket.id);
    room.screenShare = { active: true, socketId: socket.id, username: user?.username, streamId };
    room.video.type = "screenshare";
    io.to(roomId).emit("screen-share-started", { socketId: socket.id, username: user?.username, streamId });
  });

  socket.on("stop-screen-share", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.screenShare.socketId !== socket.id) return;
    room.screenShare = { active: false, socketId: null, username: null };
    io.to(roomId).emit("screen-share-stopped");
  });

  // Generic WebRTC signaling relay (mesh topology).
  socket.on("webrtc-signal", ({ roomId, targetId, signal }) => {
    if (!rooms.has(roomId)) return;
    io.to(targetId).emit("webrtc-signal", { fromId: socket.id, signal });
  });

  socket.on("media-state", ({ roomId, kind, on }) => {
    if (!rooms.has(roomId)) return;
    socket.to(roomId).emit("media-state", { fromId: socket.id, kind, on });
  });

  socket.on("leave-room", ({ roomId }) => handleLeave(socket, roomId));

  socket.on("disconnecting", () => {
    for (const roomId of socket.rooms) {
      if (rooms.has(roomId)) handleLeave(socket, roomId);
    }
  });
});

function handleLeave(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const leavingUser = room.users.get(socket.id);
  room.users.delete(socket.id);
  room.pending.delete(socket.id);
  markOffline(leavingUser?.accountId);

  if (room.screenShare.socketId === socket.id) {
    room.screenShare = { active: false, socketId: null, username: null };
    io.to(roomId).emit("screen-share-stopped");
  }

  if (room.hostSocketId === socket.id) {
    const nextHostId = room.users.keys().next().value || null;
    room.hostSocketId = nextHostId;
    if (nextHostId) io.to(roomId).emit("host-changed", { newHostId: nextHostId });
  }

  io.to(roomId).emit("user-left", { userId: socket.id });
  persist(room); // keep the snapshot even at zero users, so the room/link survives
}

// Drift correction heartbeat (see README) — nudges non-host players back in
// sync every few seconds if they've drifted more than ~0.75s.
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.video.type === "none" || room.video.type === "screenshare") continue;
    if (!room.video.isPlaying) continue;
    const elapsed = ((now - room.video.lastUpdate) / 1000) * room.video.playbackRate;
    const expectedTime = room.video.currentTime + elapsed;
    io.to(room.id).emit("sync-heartbeat", { expectedTime, serverTime: now });
  }
}, 5000);

// Notify people ~10 minutes before a scheduled watch party starts.
setInterval(() => {
  try {
    checkPartiesStartingSoon();
  } catch (err) {
    console.error("[parties] check failed:", err);
  }
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`AS watch-together running at http://localhost:${PORT}`);
});
