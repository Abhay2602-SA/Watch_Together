/**
 * Personal, persisted playlists + bookmarks (distinct from a room's
 * ephemeral "up next" queue, which lives in server/index.js room state).
 */

const { nanoid } = require("nanoid");
const db = require("./db");
const { requireLogin } = require("./auth");

function registerPlaylistRoutes(app) {
  app.get("/api/playlists", requireLogin, (req, res) => {
    res.json({ playlists: db.listPlaylists(req.user.id) });
  });

  app.post("/api/playlists", requireLogin, (req, res) => {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "name required" });
    const id = nanoid(10);
    db.createPlaylist(id, req.user.id, name.trim().slice(0, 60));
    res.json({ id });
  });

  app.delete("/api/playlists/:id", requireLogin, (req, res) => {
    db.deletePlaylist(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  app.post("/api/playlists/:id/items", requireLogin, (req, res) => {
    const { url, title } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    db.addPlaylistItem(req.params.id, url, title);
    res.json({ ok: true });
  });

  app.delete("/api/playlists/items/:itemId", requireLogin, (req, res) => {
    db.removePlaylistItem(req.params.itemId);
    res.json({ ok: true });
  });

  app.get("/api/bookmarks", requireLogin, (req, res) => {
    res.json({ bookmarks: db.listBookmarks(req.user.id) });
  });

  app.post("/api/bookmarks", requireLogin, (req, res) => {
    const { url, title } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });
    db.addBookmark(req.user.id, url, title);
    res.json({ ok: true });
  });

  app.delete("/api/bookmarks/:id", requireLogin, (req, res) => {
    db.removeBookmark(req.params.id, req.user.id);
    res.json({ ok: true });
  });
}

module.exports = { registerPlaylistRoutes };
