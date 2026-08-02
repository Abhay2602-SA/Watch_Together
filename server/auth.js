/**
 * Google OAuth (only sign-in method, per product decision) + friends API.
 *
 * Exports `sessionMiddleware` so server/index.js can share the same
 * express-session instance with Socket.io — that's what lets a socket
 * connection know which logged-in user it belongs to.
 */

const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const db = require("./db");

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "dev-only-insecure-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
});

const googleConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (googleConfigured) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        const user = db.upsertUser({
          id: profile.id,
          email: profile.emails?.[0]?.value || null,
          name: profile.displayName,
          avatarUrl: profile.photos?.[0]?.value || null,
        });
        done(null, user);
      }
    )
  );
} else {
  console.warn(
    "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set in .env — Google sign-in is disabled until you add them. The app still works fully as a guest otherwise."
  );
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => done(null, db.getUser(id) || null));

function registerAuthRoutes(app) {
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  app.get("/auth/google", (req, res, next) => {
    if (!googleConfigured) {
      return res.status(503).send("Google sign-in isn't configured yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.");
    }
    passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  });

  app.get(
    "/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (req, res) => res.redirect("/")
  );

  app.post("/auth/logout", (req, res) => {
    req.logout(() => res.json({ ok: true }));
  });

  app.get("/api/me", (req, res) => {
    res.json({ user: req.user || null, googleConfigured });
  });

  app.get("/api/users/search", requireLogin, (req, res) => {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ users: [] });
    res.json({ users: db.searchUsers(q, req.user.id) });
  });

  app.get("/api/friends", requireLogin, (req, res) => {
    res.json({
      friends: db.listFriends(req.user.id),
      incoming: db.listIncomingRequests(req.user.id),
    });
  });

  app.post("/api/friends/request", requireLogin, (req, res) => {
    const { targetUserId } = req.body || {};
    if (!targetUserId) return res.status(400).json({ error: "targetUserId required" });
    const result = db.sendFriendRequest(req.user.id, targetUserId);
    if (result.autoAccepted) {
      db.addNotification(req.user.id, "friend_accepted", { byUserId: targetUserId, byName: req.user.name });
      db.addNotification(targetUserId, "friend_accepted", { byUserId: req.user.id, byName: req.user.name });
    } else {
      db.addNotification(targetUserId, "friend_request", { fromUserId: req.user.id, fromName: req.user.name });
    }
    res.json({ ok: true });
  });

  app.post("/api/friends/accept", requireLogin, (req, res) => {
    const { requestId } = req.body || {};
    const row = db.acceptFriendRequest(requestId, req.user.id);
    if (row) {
      db.addNotification(row.requester_id, "friend_accepted", { byUserId: req.user.id, byName: req.user.name });
    }
    res.json({ ok: true });
  });

  app.get("/api/history", requireLogin, (req, res) => {
    res.json({ history: db.listWatchHistory(req.user.id) });
  });

  app.get("/api/profile", requireLogin, (req, res) => {
    const userId = req.query.userId || req.user.id;
    const user = db.getUser(userId);
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json({
      profile: user,
      stats: {
        roomsWatched: db.countDistinctRoomsWatched(userId),
        totalWatches: db.listWatchHistory(userId, 10000).length,
        friendCount: db.listFriends(userId).length,
      },
    });
  });

  app.put("/api/profile", requireLogin, (req, res) => {
    const { bio, favoriteGenres } = req.body || {};
    const updated = db.updateProfile(req.user.id, { bio, favoriteGenres });
    res.json({ profile: updated });
  });

  app.get("/api/notifications", requireLogin, (req, res) => {
    res.json({
      notifications: db.listNotifications(req.user.id),
      unread: db.unreadNotificationCount(req.user.id),
    });
  });

  app.post("/api/notifications/read", requireLogin, (req, res) => {
    db.markNotificationsRead(req.user.id);
    res.json({ ok: true });
  });
}

function requireLogin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sign in required" });
  next();
}

module.exports = { registerAuthRoutes, sessionMiddleware, passport, requireLogin };
