/**
 * Persistence layer (SQLite via better-sqlite3 — a single local file,
 * zero setup).
 */

const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "..", "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    avatar_url TEXT,
    bio TEXT DEFAULT '',
    favorite_genres TEXT DEFAULT '', -- comma-separated, user-entered
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER,
    UNIQUE(requester_id, recipient_id)
  );

  CREATE TABLE IF NOT EXISTS watch_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    video_url TEXT,
    watched_at INTEGER
  );

  -- Snapshot of a room's durable state, so chat/video/queue survive a
  -- server restart even though live sockets obviously don't.
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT,
    host_account_id TEXT,
    password TEXT,
    waiting_room_enabled INTEGER DEFAULT 0,
    video_json TEXT,
    playlist_json TEXT,
    chat_json TEXT,
    moderator_ids_json TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL, -- friend_request | friend_accepted | room_invite | mention | party_invite | party_starting | announcement
    data_json TEXT,
    read INTEGER DEFAULT 0,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    position INTEGER,
    added_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS scheduled_parties (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    title TEXT,
    scheduled_time INTEGER,
    invitee_ids_json TEXT,
    notified_starting INTEGER DEFAULT 0,
    created_at INTEGER
  );
`);

// ---------------------------- users / profiles ----------------------------

function upsertUser(profile) {
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(profile.id);
  if (existing) {
    db.prepare("UPDATE users SET name = ?, avatar_url = ?, email = ? WHERE id = ?").run(
      profile.name, profile.avatarUrl, profile.email, profile.id
    );
  } else {
    db.prepare(
      "INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(profile.id, profile.email, profile.name, profile.avatarUrl, Date.now());
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(profile.id);
}

function getUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function updateProfile(userId, { bio, favoriteGenres }) {
  db.prepare("UPDATE users SET bio = ?, favorite_genres = ? WHERE id = ?").run(
    (bio || "").slice(0, 500),
    (favoriteGenres || "").slice(0, 300),
    userId
  );
  return getUser(userId);
}

function searchUsers(query, excludeId) {
  return db
    .prepare(
      "SELECT id, name, email, avatar_url FROM users WHERE (email LIKE ? OR name LIKE ?) AND id != ? LIMIT 10"
    )
    .all(`%${query}%`, `%${query}%`, excludeId);
}

// ---------------------------- friends ----------------------------

function sendFriendRequest(requesterId, recipientId) {
  const reverse = db
    .prepare("SELECT * FROM friend_requests WHERE requester_id = ? AND recipient_id = ?")
    .get(recipientId, requesterId);
  if (reverse) {
    db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(reverse.id);
    return { autoAccepted: true, row: reverse };
  }
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO friend_requests (requester_id, recipient_id, status, created_at) VALUES (?, ?, 'pending', ?)"
    )
    .run(requesterId, recipientId, Date.now());
  return { autoAccepted: false, info };
}

function acceptFriendRequest(requestId, recipientId) {
  const row = db.prepare("SELECT * FROM friend_requests WHERE id = ?").get(requestId);
  db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ? AND recipient_id = ?").run(
    requestId, recipientId
  );
  return row;
}

function listFriends(userId) {
  return db
    .prepare(
      `SELECT u.id, u.name, u.avatar_url FROM friend_requests fr
       JOIN users u ON u.id = (CASE WHEN fr.requester_id = ? THEN fr.recipient_id ELSE fr.requester_id END)
       WHERE (fr.requester_id = ? OR fr.recipient_id = ?) AND fr.status = 'accepted'`
    )
    .all(userId, userId, userId);
}

function listIncomingRequests(userId) {
  return db
    .prepare(
      `SELECT fr.id as request_id, u.id, u.name, u.avatar_url FROM friend_requests fr
       JOIN users u ON u.id = fr.requester_id
       WHERE fr.recipient_id = ? AND fr.status = 'pending'`
    )
    .all(userId);
}

// ---------------------------- watch history ----------------------------

function recordWatchHistory(userId, roomId, videoUrl) {
  db.prepare(
    "INSERT INTO watch_history (user_id, room_id, video_url, watched_at) VALUES (?, ?, ?, ?)"
  ).run(userId, roomId, videoUrl, Date.now());
}

function listWatchHistory(userId, limit = 20) {
  return db
    .prepare("SELECT * FROM watch_history WHERE user_id = ? ORDER BY watched_at DESC LIMIT ?")
    .all(userId, limit);
}

function countDistinctRoomsWatched(userId) {
  return db
    .prepare("SELECT COUNT(DISTINCT room_id) as n FROM watch_history WHERE user_id = ?")
    .get(userId).n;
}

function friendsRecentWatches(userId, limit = 10) {
  return db
    .prepare(
      `SELECT wh.video_url, wh.room_id, wh.watched_at, u.name, u.avatar_url
       FROM watch_history wh
       JOIN users u ON u.id = wh.user_id
       WHERE wh.user_id IN (
         SELECT CASE WHEN fr.requester_id = ? THEN fr.recipient_id ELSE fr.requester_id END
         FROM friend_requests fr
         WHERE (fr.requester_id = ? OR fr.recipient_id = ?) AND fr.status = 'accepted'
       )
       ORDER BY wh.watched_at DESC LIMIT ?`
    )
    .all(userId, userId, userId, limit);
}

function trendingVideos(sinceMs, limit = 5) {
  return db
    .prepare(
      `SELECT video_url, COUNT(*) as watches FROM watch_history
       WHERE watched_at > ? AND video_url IS NOT NULL
       GROUP BY video_url ORDER BY watches DESC LIMIT ?`
    )
    .all(sinceMs, limit);
}

// ---------------------------- rooms (durable snapshot) ----------------------------

function saveRoomSnapshot(room) {
  const existing = db.prepare("SELECT id FROM rooms WHERE id = ?").get(room.id);
  const payload = {
    name: room.name || null,
    host_account_id: room.hostAccountId || null,
    password: room.password || null,
    waiting_room_enabled: room.waitingRoomEnabled ? 1 : 0,
    video_json: JSON.stringify(room.video),
    playlist_json: JSON.stringify(room.playlist || []),
    chat_json: JSON.stringify(room.chat.slice(-200)),
    moderator_ids_json: JSON.stringify(Array.from(room.moderatorAccountIds || [])),
    updated_at: Date.now(),
  };
  if (existing) {
    db.prepare(
      `UPDATE rooms SET name=@name, host_account_id=@host_account_id, password=@password,
       waiting_room_enabled=@waiting_room_enabled, video_json=@video_json, playlist_json=@playlist_json,
       chat_json=@chat_json, moderator_ids_json=@moderator_ids_json, updated_at=@updated_at WHERE id=@id`
    ).run({ ...payload, id: room.id });
  } else {
    db.prepare(
      `INSERT INTO rooms (id, name, host_account_id, password, waiting_room_enabled, video_json,
       playlist_json, chat_json, moderator_ids_json, created_at, updated_at)
       VALUES (@id, @name, @host_account_id, @password, @waiting_room_enabled, @video_json,
       @playlist_json, @chat_json, @moderator_ids_json, @created_at, @updated_at)`
    ).run({ ...payload, id: room.id, created_at: Date.now() });
  }
}

function loadRoomSnapshot(roomId) {
  const row = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostAccountId: row.host_account_id,
    password: row.password,
    waitingRoomEnabled: !!row.waiting_room_enabled,
    video: JSON.parse(row.video_json || "null"),
    playlist: JSON.parse(row.playlist_json || "[]"),
    chat: JSON.parse(row.chat_json || "[]"),
    moderatorAccountIds: JSON.parse(row.moderator_ids_json || "[]"),
  };
}

function recentRoomsForUser(userId, limit = 8) {
  return db
    .prepare(
      `SELECT r.id, r.name, r.video_json, MAX(wh.watched_at) as last_watched
       FROM watch_history wh JOIN rooms r ON r.id = wh.room_id
       WHERE wh.user_id = ? GROUP BY r.id ORDER BY last_watched DESC LIMIT ?`
    )
    .all(userId, limit);
}

// ---------------------------- notifications ----------------------------

function addNotification(userId, type, data) {
  const info = db
    .prepare("INSERT INTO notifications (user_id, type, data_json, created_at) VALUES (?, ?, ?, ?)")
    .run(userId, type, JSON.stringify(data || {}), Date.now());
  return { id: info.lastInsertRowid, userId, type, data, read: false, createdAt: Date.now() };
}

function listNotifications(userId, limit = 30) {
  return db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit)
    .map((n) => ({ ...n, data: JSON.parse(n.data_json || "{}") }));
}

function markNotificationsRead(userId) {
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(userId);
}

function unreadNotificationCount(userId) {
  return db
    .prepare("SELECT COUNT(*) as n FROM notifications WHERE user_id = ? AND read = 0")
    .get(userId).n;
}

// ---------------------------- playlists / bookmarks ----------------------------

function createPlaylist(id, ownerId, name) {
  db.prepare("INSERT INTO playlists (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)").run(
    id, ownerId, name, Date.now()
  );
}

function listPlaylists(ownerId) {
  const playlists = db.prepare("SELECT * FROM playlists WHERE owner_id = ? ORDER BY created_at DESC").all(ownerId);
  const itemsStmt = db.prepare("SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC");
  return playlists.map((p) => ({ ...p, items: itemsStmt.all(p.id) }));
}

function deletePlaylist(id, ownerId) {
  db.prepare("DELETE FROM playlist_items WHERE playlist_id = ?").run(id);
  db.prepare("DELETE FROM playlists WHERE id = ? AND owner_id = ?").run(id, ownerId);
}

function addPlaylistItem(playlistId, url, title) {
  const count = db.prepare("SELECT COUNT(*) as n FROM playlist_items WHERE playlist_id = ?").get(playlistId).n;
  db.prepare(
    "INSERT INTO playlist_items (playlist_id, url, title, position, added_at) VALUES (?, ?, ?, ?, ?)"
  ).run(playlistId, url, title || url, count, Date.now());
}

function removePlaylistItem(itemId) {
  db.prepare("DELETE FROM playlist_items WHERE id = ?").run(itemId);
}

function addBookmark(userId, url, title) {
  db.prepare("INSERT INTO bookmarks (user_id, url, title, created_at) VALUES (?, ?, ?, ?)").run(
    userId, url, title || url, Date.now()
  );
}

function listBookmarks(userId) {
  return db.prepare("SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC").all(userId);
}

function removeBookmark(id, userId) {
  db.prepare("DELETE FROM bookmarks WHERE id = ? AND user_id = ?").run(id, userId);
}

// ---------------------------- scheduled watch parties ----------------------------

function createParty(id, hostId, roomId, title, scheduledTime, inviteeIds) {
  db.prepare(
    `INSERT INTO scheduled_parties (id, host_id, room_id, title, scheduled_time, invitee_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, hostId, roomId, title, scheduledTime, JSON.stringify(inviteeIds || []), Date.now());
}

function listPartiesForUser(userId) {
  const rows = db.prepare("SELECT * FROM scheduled_parties WHERE scheduled_time > ? ORDER BY scheduled_time ASC").all(
    Date.now() - 60 * 60 * 1000 // include ones that started within the last hour
  );
  return rows
    .filter((r) => r.host_id === userId || JSON.parse(r.invitee_ids_json || "[]").includes(userId))
    .map((r) => ({ ...r, invitee_ids: JSON.parse(r.invitee_ids_json || "[]") }));
}

function partiesStartingSoon(windowMs) {
  const now = Date.now();
  return db
    .prepare(
      "SELECT * FROM scheduled_parties WHERE notified_starting = 0 AND scheduled_time BETWEEN ? AND ?"
    )
    .all(now, now + windowMs)
    .map((r) => ({ ...r, invitee_ids: JSON.parse(r.invitee_ids_json || "[]") }));
}

function markPartyNotified(id) {
  db.prepare("UPDATE scheduled_parties SET notified_starting = 1 WHERE id = ?").run(id);
}

module.exports = {
  upsertUser, getUser, updateProfile, searchUsers,
  sendFriendRequest, acceptFriendRequest, listFriends, listIncomingRequests,
  recordWatchHistory, listWatchHistory, countDistinctRoomsWatched, friendsRecentWatches, trendingVideos,
  saveRoomSnapshot, loadRoomSnapshot, recentRoomsForUser,
  addNotification, listNotifications, markNotificationsRead, unreadNotificationCount,
  createPlaylist, listPlaylists, deletePlaylist, addPlaylistItem, removePlaylistItem,
  addBookmark, listBookmarks, removeBookmark,
  createParty, listPartiesForUser, partiesStartingSoon, markPartyNotified,
};
