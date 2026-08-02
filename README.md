# AS watch-together

Watch anything together with one link — synchronized playback, screen-share fallback for anything that can't be embedded, voice/video chat, moderation, a dashboard, subtitles, and an AI assistant.

## What's working

**Core watching experience**
- Rooms — create/join with a shareable link, optional password, optional waiting room (host approval to join).
- Smart Mode — paste a link; YouTube/direct video files sync automatically, anything else (Netflix, Prime Video, local VLC, desktop apps) falls back to screen share.
- Synchronized playback — host/moderator controls (play/pause/seek/speed) broadcast to everyone; late joiners sync on entry; a background heartbeat quietly corrects drift over long sessions.
- Screen sharing, voice chat, and video chat (WebRTC mesh — good for small-to-medium rooms).
- Real-time chat with @mentions (mentioning a signed-in user notifies them).
- An in-room "up next" queue anyone can add to; host/moderators control what plays and when.
- Subtitles — upload .srt/.vtt, multiple tracks, delay offset, font size/color, and one-click AI translation into several languages (Groq).

**Accounts & social**
- Google sign-in (guests can still do everything above without an account).
- Friends — search, request, accept, invite a friend straight into your current room.
- Profiles — bio, favorite genres, watch stats, simple rule-based achievement badges, recent watch history.
- Personal library — saved playlists (with "add entire playlist to this room's queue") and bookmarks.
- Notifications — friend requests/accepts, room invites, chat mentions, watch-party invites and "starting soon" reminders. Bell icon with unread badge + toast on new ones (polled every 20s).
- Dashboard (landing page, signed-in only) — continue watching / recent rooms, friends + online status, what your friends are watching, trending videos (real aggregate of the last 7 days across all users), and scheduled watch parties.
- Scheduled watch parties — pick a time, invite friends, they get notified; the host can "Start" the exact room at the scheduled code, invitees can "Join" once it's live.

**Moderation & permissions**
- Room passwords and an optional waiting room (host approves/denies each join request).
- Moderators — host can promote/demote signed-in users; moderators get playback control and can kick/force-mute, same as the host.
- Kick and force-mute.

**Reliability**
- Reconnect handling, drift correction, mobile layout (chat/queue/AI collapse into a slide-in drawer), and clear error states (room not found, wrong password, mic/camera permission denied, screen-share failures).
- Room persistence — chat, current video, queue, password, and moderator list are snapshotted to SQLite, so a server restart doesn't erase an active room (though live connections obviously still drop and everyone needs to reopen the link).

## Setup

```bash
npm install
```

`better-sqlite3` compiles a small native module on install — if that fails, you're missing basic build tools (Debian/Ubuntu: `apt install build-essential python3`; macOS: Xcode command line tools; Windows: use WSL, or `npm install --global windows-build-tools`).

**Groq (AI assistant + subtitle translation):** open `.env` and set:
```
GROQ_API_KEY=gsk_your_key_here
```
Get a key at [console.groq.com/keys](https://console.groq.com/keys). Nothing else in the code touches this value — it's read only in `server/ai.js`, server-side, and is never sent to the browser.

**Google sign-in (optional but recommended — friends/profiles/history/parties all need it):**
1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) → Create OAuth Client ID → Web application.
2. Authorized redirect URI: `http://localhost:3000/auth/google/callback`.
3. In `.env`, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to the values Google gives you.

Without Google configured, the app still runs fully as a guest experience — rooms, sync, screen share, voice/video, chat, and subtitles all work with no account.

```bash
npm start
```

Open `http://localhost:3000` in a couple of tabs (or devices) to try it with more than one "person." Requires Node 18+. A `data.sqlite` file appears on first run — delete it any time to reset everything.

## Architecture

- `server/index.js` — Socket.io: rooms, chat + mentions, playback sync + drift heartbeat, WebRTC signaling relay, moderation (kick/mute/promote), passwords/waiting room, in-room queue, room snapshot persistence, online-friends tracking, and the scheduled-party "starting soon" check.
- `server/db.js` — SQLite (`better-sqlite3`): users/profiles, friends, watch history, room snapshots, notifications, playlists/bookmarks, scheduled parties. This is the single place to port to Postgres/MySQL if you outgrow one file (e.g. multiple server instances).
- `server/auth.js` — Google OAuth (Passport), session (shared with Socket.io), friends REST API, profile, notifications.
- `server/ai.js` — `/api/ai/generate` (ask / summarize / explain scene / trivia / discussion questions) and `/api/subtitles/translate`, both via Groq.
- `server/playlists.js` — personal playlists + bookmarks REST API.
- `server/dashboard.js` — dashboard aggregation + scheduled parties REST API.
- `public/` — plain HTML/CSS/JS, no build step. `app.js` is sectioned by comment header (auth/dashboard, room entry, presence/moderation, playback, queue, subtitles, WebRTC, Ask AI, and each side panel).

WebRTC uses a **mesh** topology — fine for small rooms; swap for an SFU (LiveKit/mediasoup) if you need many simultaneous cameras in one room.

## Known limitations (honest, not hidden)

- **Moderator status doesn't survive a reconnect for guests** — it's tracked by Google account id, so signed-in moderators keep their role across reconnects; guests would need re-promoting (guests have no stable id to persist against).
- **Waiting room re-triggers on reconnect** — a dropped/reconnecting non-host participant in a waiting-room-enabled room will be asked for approval again, since the server can't tell "reconnecting" apart from "new join" today.
- **Trending/recommendations are real aggregates, not a recommendation engine** — "Trending" is genuinely the most-watched URLs across all users in the last 7 days; there's no content catalog, so genre-based recommendations aren't implemented (favorite genres are stored on the profile but not yet used to filter anything).
- **AI features are honest about their limits by design** — the prompts explicitly tell the model to say "I don't know this specific title" rather than invent plot/trivia, since Groq has no actual access to the video.
- **No production deployment config** (HTTPS, reverse proxy, process manager, horizontal scaling) — this is a local/dev-ready build.

## Suggested next milestone

Everything from the original feature list is now implemented in some working form. From here, the highest-value next steps are probably: (1) a real content catalog so recommendations/genres mean something, (2) an SFU for larger voice/video rooms, or (3) production deployment (HTTPS, process manager, moving SQLite to Postgres if you expect concurrent server instances).
