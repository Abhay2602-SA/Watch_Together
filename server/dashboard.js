/**
 * Dashboard data + scheduled watch parties.
 *
 * `onlineAccountIds` is injected from server/index.js (it's the one place
 * that actually knows which accounts have a live socket connected).
 */

const { nanoid } = require("nanoid");
const db = require("./db");
const { requireLogin } = require("./auth");

function registerDashboardRoutes(app, { onlineAccountIds }) {
  app.get("/api/dashboard", requireLogin, (req, res) => {
    const userId = req.user.id;

    const friends = db.listFriends(userId).map((f) => ({
      ...f,
      online: onlineAccountIds().has(f.id),
    }));

    const recentRooms = db.recentRoomsForUser(userId, 8).map((r) => ({
      ...r,
      video: r.video_json ? JSON.parse(r.video_json) : null,
    }));

    res.json({
      recentRooms,
      friendsWatching: db.friendsRecentWatches(userId, 8),
      trending: db.trendingVideos(Date.now() - 7 * 24 * 60 * 60 * 1000, 5),
      friends,
      parties: db.listPartiesForUser(userId),
    });
  });

  app.post("/api/parties", requireLogin, (req, res) => {
    const { roomId, title, scheduledTime, inviteeIds } = req.body || {};
    if (!roomId || !scheduledTime) {
      return res.status(400).json({ error: "roomId and scheduledTime are required" });
    }
    const id = nanoid(10);
    db.createParty(id, req.user.id, roomId, (title || "Watch party").slice(0, 80), scheduledTime, inviteeIds || []);
    (inviteeIds || []).forEach((friendId) => {
      db.addNotification(friendId, "party_invite", {
        byUserId: req.user.id,
        byName: req.user.name,
        title,
        scheduledTime,
        roomId,
      });
    });
    res.json({ id });
  });

  app.get("/api/parties", requireLogin, (req, res) => {
    res.json({ parties: db.listPartiesForUser(req.user.id) });
  });
}

// Call periodically from index.js to notify people ~10 minutes before a
// scheduled party starts.
function checkPartiesStartingSoon() {
  const parties = db.partiesStartingSoon(10 * 60 * 1000);
  parties.forEach((party) => {
    const recipients = new Set([party.host_id, ...party.invitee_ids]);
    recipients.forEach((userId) => {
      db.addNotification(userId, "party_starting", {
        title: party.title,
        roomId: party.room_id,
        scheduledTime: party.scheduled_time,
      });
    });
    db.markPartyNotified(party.id);
  });
}

module.exports = { registerDashboardRoutes, checkPartiesStartingSoon };
