/**
 * AS watch-together — client
 *
 * Sections:
 *   1. State, socket setup, small helpers (toast, panels)
 *   2. Auth + dashboard (landing screen, signed-in users only)
 *   3. Room entry: create/join, passwords, waiting room, reconnect
 *   4. Presence, moderation (promote/kick/mute), chat + mentions
 *   5. Smart Mode playback (YouTube / file / screen-share fallback) + drift correction
 *   6. In-room queue ("up next")
 *   7. Subtitles (upload/parse/render/translate)
 *   8. Voice/video/screen share over WebRTC (mesh)
 *   9. Ask AI
 *  10. Friends / Profile / Library / Notifications / Scheduled parties panels
 */

// ---------------------------------------------------------------------
// 0. Universal panel/modal close — registered FIRST, before anything
// below that could throw. Closing any panel (Friends, Profile, Library,
// Notifications, Room settings, Join requests) or the schedule-party
// modal always works via: its own Close/Cancel button, clicking outside
// it, or pressing Escape — regardless of what else on the page is doing.
// ---------------------------------------------------------------------
document.addEventListener("click", (e) => {
  const closeBtn = e.target.closest(".close-panel-btn");
  if (closeBtn) {
    const panel = closeBtn.closest(".side-panel");
    if (panel) panel.hidden = true;
  }
  if (e.target.classList && e.target.classList.contains("modal-backdrop")) {
    e.target.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".side-panel:not([hidden])").forEach((p) => (p.hidden = true));
  document.querySelectorAll(".modal-backdrop:not([hidden])").forEach((m) => (m.hidden = true));
});

window.addEventListener("error", (e) => {
  console.error("[AS watch-together] script error:", e.error || e.message);
  if (document.getElementById("__js-error-banner")) return;
  const banner = document.createElement("div");
  banner.id = "__js-error-banner";
  banner.textContent =
    "Something went wrong loading part of the page. Press F12, open the Console tab, and copy any red error text.";
  banner.style.cssText =
    "position:fixed;top:0;left:0;right:0;background:#ff6b6b;color:#0f1117;padding:10px;font:14px sans-serif;z-index:99999;text-align:center;";
  document.body.prepend(banner);
});

const socket = io();
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  roomId: null,
  userId: null,
  isHost: false,
  isModerator: false,
  users: new Map(),
  peers: new Map(),
  localAudioTrack: null,
  localVideoTrack: null,
  screenStream: null,
  micOn: false,
  camOn: false,
  pinnedId: null,
  youtubePlayer: null,
  youtubeReady: false,
  suppressNextEvent: false,
  account: null,
  playlist: [],
  subtitleTracks: [], // { label, cues: [{start,end,text}] }
  activeSubtitleTrackIndex: -1,
  subtitleOffset: 0,
  seenNotifIds: new Set(),
  notifPolled: false,
};

let lastUsername = "Guest";
let lastPassword = "";

// ---------------------------------------------------------------------
// 1. Small shared helpers
// ---------------------------------------------------------------------

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

function toast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  $("#toast-container").appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function openPanel(id) {
  document.getElementById(id).hidden = false;
}
function closePanel(id) {
  document.getElementById(id).hidden = true;
}
$$(".close-panel-btn").forEach((btn) => {
  btn.addEventListener("click", () => closePanel(btn.dataset.close));
});

function showRoomError(msg) {
  const el = $("#room-error-banner");
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function showLandingError(msg) {
  const el = $("#landing-error");
  el.textContent = msg;
  el.hidden = false;
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------
// 2. Auth + dashboard
// ---------------------------------------------------------------------

async function loadAuth() {
  try {
    const res = await fetch("/api/me");
    const data = await res.json();
    state.account = data.user;
    renderAuthArea(data.user, data.googleConfigured);
  } catch {
    renderAuthArea(null, false);
  }
}

function renderAuthArea(user, googleConfigured) {
  const el = $("#auth-area");
  if (user) {
    el.innerHTML = `
      <button id="notif-bell-landing" class="btn btn-ghost icon-btn">🔔<span id="notif-badge-landing" class="notif-badge" hidden>0</span></button>
      <button id="library-btn-landing" class="btn btn-ghost">Library</button>
      <button id="profile-btn-landing" class="btn btn-ghost">Profile</button>
      <div class="auth-profile">
        ${user.avatar_url ? `<img class="auth-avatar" src="${user.avatar_url}" alt="">` : ""}
        <span>${escapeHtml(user.name || user.email || "Signed in")}</span>
      </div>
      <button id="sign-out-btn" class="btn btn-ghost">Sign out</button>
    `;
    $("#sign-out-btn").addEventListener("click", async () => {
      await fetch("/auth/logout", { method: "POST" });
      window.location.reload();
    });
    $("#notif-bell-landing").addEventListener("click", () => openNotifications());
    $("#library-btn-landing").addEventListener("click", () => openLibrary());
    $("#profile-btn-landing").addEventListener("click", () => openProfile());
    $("#create-username").value = user.name || "";
    $("#join-username").value = user.name || "";

    $("#dashboard").hidden = false;
    loadDashboard();
    pollNotifications();
    setInterval(pollNotifications, 20000);
  } else if (googleConfigured) {
    el.innerHTML = `<a class="btn btn-secondary" href="/auth/google">Sign in with Google</a>`;
  } else {
    el.innerHTML = "";
  }
}

async function loadDashboard() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) return;
  const data = await res.json();

  renderRows(
    "#dash-recent-rooms",
    data.recentRooms,
    (r) => `<div class="dash-row"><span>${escapeHtml(r.name || r.id)} <span class="muted">${r.video?.url ? escapeHtml(r.video.url).slice(0, 30) : ""}</span></span>
      <button class="btn btn-secondary btn-sm" data-rejoin="${r.id}">Rejoin</button></div>`,
    "Nothing yet — start watching something!"
  );

  renderRows(
    "#dash-friends",
    data.friends,
    (f) => `<div class="dash-row"><span>${f.online ? "🟢" : "⚪"} ${escapeHtml(f.name)}</span></div>`,
    "No friends yet — add some from the Friends panel."
  );

  renderRows(
    "#dash-friends-watching",
    data.friendsWatching,
    (w) => `<div class="dash-row"><span>${escapeHtml(w.name)} <span class="muted">${escapeHtml((w.video_url || "").slice(0, 30))}</span></span><span class="muted">${timeAgo(w.watched_at)}</span></div>`,
    "Nothing from friends yet."
  );

  renderRows(
    "#dash-trending",
    data.trending,
    (t) => `<div class="dash-row"><span>${escapeHtml((t.video_url || "").slice(0, 40))}</span><span class="muted">${t.watches}× this week</span></div>`,
    "Nothing trending yet."
  );

  renderRows(
    "#dash-parties",
    data.parties,
    (p) => {
      const isHostOfParty = state.account && p.host_id === state.account.id;
      return `<div class="dash-row"><span>${escapeHtml(p.title)} <span class="muted">${new Date(p.scheduled_time).toLocaleString()}</span></span>
        <button class="btn btn-secondary btn-sm" data-party-join="${p.room_id}" data-party-host="${isHostOfParty}">${isHostOfParty ? "Start" : "Join"}</button></div>`;
    },
    "No parties scheduled."
  );

  $$("[data-rejoin]").forEach((btn) =>
    btn.addEventListener("click", () => {
      lastUsername = state.account?.name || "Guest";
      socket.emit("join-room", { roomId: btn.dataset.rejoin, username: lastUsername });
    })
  );
  $$("[data-party-join]").forEach((btn) =>
    btn.addEventListener("click", () => {
      lastUsername = state.account?.name || "Guest";
      if (btn.dataset.partyHost === "true") {
        socket.emit("create-room", { username: lastUsername, roomId: btn.dataset.partyJoin });
      } else {
        socket.emit("join-room", { roomId: btn.dataset.partyJoin, username: lastUsername });
      }
    })
  );
}

function renderRows(containerSel, items, rowFn, emptyText) {
  const el = $(containerSel);
  if (!items || !items.length) {
    el.innerHTML = `<p class="dash-empty">${emptyText}</p>`;
    return;
  }
  el.innerHTML = items.map(rowFn).join("");
}

loadAuth();

// ---------------------------------------------------------------------
// 3. Room entry: create / join, passwords, waiting room, reconnect
// ---------------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
if (params.get("room")) $("#join-room-id").value = params.get("room");

$("#create-room-btn").addEventListener("click", () => {
  lastUsername = $("#create-username").value.trim() || "Host";
  const password = $("#create-password").value.trim();
  const waitingRoomEnabled = $("#create-waiting-room").checked;
  socket.emit("create-room", { username: lastUsername, password, waitingRoomEnabled });
});

$("#join-room-btn").addEventListener("click", () => {
  lastUsername = $("#join-username").value.trim() || "Guest";
  lastPassword = $("#join-password").value.trim();
  const roomId = $("#join-room-id").value.trim();
  if (!roomId) return showLandingError("Enter a room code to join.");
  showLandingError("");
  socket.emit("join-room", { roomId, username: lastUsername, password: lastPassword });
});

socket.on("connect", () => {
  if (state.roomId) {
    showRoomError("");
    socket.emit("join-room", { roomId: state.roomId, username: lastUsername, password: lastPassword });
  }
});
socket.on("disconnect", () => {
  if (state.roomId) showRoomError("Connection lost — reconnecting…");
});

socket.on("error-message", ({ message }) => showLandingError(message));
socket.on("password-required", ({ message }) => {
  showLandingError(message);
  $("#join-password").focus();
});
socket.on("waiting-approval", () => {
  showLandingError("Waiting for the host to let you in…");
});
socket.on("join-approved", () => showLandingError(""));
socket.on("join-denied", () => showLandingError("The host didn't approve your request to join."));
socket.on("kicked", () => {
  toast("You were removed from the room.");
  window.location.href = window.location.pathname;
});

socket.on("room-created", ({ roomId }) => history.replaceState(null, "", `?room=${roomId}`));

socket.on("joined-room", ({ userId, isHost, isModerator, state: roomState }) => {
  state.roomId = roomState.roomId;
  state.userId = userId;
  state.isHost = isHost;
  state.isModerator = isModerator;
  enterRoom(roomState);
});

function enterRoom(roomState) {
  $("#landing").hidden = true;
  $("#room").hidden = false;

  $("#copy-room-link").textContent = roomState.roomId;
  $("#host-badge").hidden = !state.isHost;
  $("#friends-btn").hidden = !state.account;
  $("#room-security-btn").hidden = !state.isHost;
  $("#join-requests-btn").hidden = !(state.isHost || state.isModerator);
  updateMoreMenuVisibility();
  $("#notif-bell-btn").hidden = !state.account;
  $("#bookmark-video-btn").hidden = !state.account;

  state.users.clear();
  roomState.users.forEach((u) => state.users.set(u.id, u));
  renderPresence();

  state.playlist = roomState.playlist || [];
  renderQueue();

  $("#chat-log").innerHTML = "";
  if (roomState.chat.length) {
    roomState.chat.forEach(renderChatMessage);
  } else {
    $("#chat-log").innerHTML = `<div class="chat-msg system chat-empty-state">No messages yet — say hi!</div>`;
  }

  if (roomState.video && roomState.video.type !== "none") applyVideoChanged(roomState.video);

  initLocalMediaControls();
  roomState.users.forEach((u) => {
    if (u.id !== state.userId && !state.peers.has(u.id)) callPeer(u.id);
  });

  if (state.account) pollNotifications();
}

$("#copy-room-link").addEventListener("click", () => {
  const url = `${window.location.origin}${window.location.pathname}?room=${state.roomId}`;
  navigator.clipboard?.writeText(url);
  const el = $("#copy-room-link");
  const original = el.textContent;
  el.textContent = "Link copied!";
  setTimeout(() => (el.textContent = original), 1200);
});

$("#leave-room-btn").addEventListener("click", () => {
  socket.emit("leave-room", { roomId: state.roomId });
  window.location.href = window.location.pathname;
});

// ---------------------------------------------------------------------
// 4. Presence, moderation, chat + mentions
// ---------------------------------------------------------------------

socket.on("user-joined", ({ user }) => {
  state.users.set(user.id, user);
  renderPresence();
  renderChatMessage({ system: true, message: `${user.username} joined` });
  callPeer(user.id);
});

socket.on("user-left", ({ userId }) => {
  const user = state.users.get(userId);
  state.users.delete(userId);
  renderPresence();
  closePeer(userId);
  if (user) renderChatMessage({ system: true, message: `${user.username} left` });
});

socket.on("host-changed", ({ newHostId }) => {
  state.isHost = newHostId === state.userId;
  $("#host-badge").hidden = !state.isHost;
  $("#room-security-btn").hidden = !state.isHost;
  updateMoreMenuVisibility();
  if (state.isHost) renderChatMessage({ system: true, message: "You are now the host." });
  renderPresence();
});

socket.on("moderators-updated", ({ users }) => {
  users.forEach((u) => state.users.set(u.id, u));
  if (state.userId) {
    const me = state.users.get(state.userId);
    state.isModerator = !!me?.isModerator || state.isHost;
    $("#join-requests-btn").hidden = !(state.isHost || state.isModerator);
    updateMoreMenuVisibility();
  }
  renderPresence();
});

socket.on("force-mute", () => {
  if (state.micOn) toggleMic();
  toast("The host muted your microphone.");
});

function renderPresence() {
  updatePeopleGridColumns();
  const el = $("#presence-list");
  el.innerHTML = "";
  state.users.forEach((u) => {
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    wrap.style.display = "inline-block";

    const div = document.createElement("div");
    div.className = "presence-avatar" + (u.isModerator ? " is-mod" : "");
    div.title = u.username + (u.id === state.hostId ? " (host)" : "");
    div.textContent = u.username.slice(0, 2).toUpperCase();

    const canManage = (state.isHost || state.isModerator) && u.id !== state.userId;
    if (canManage) {
      div.style.cursor = "pointer";
      div.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePresenceMenu(wrap, u);
      });
    }
    wrap.appendChild(div);
    el.appendChild(wrap);
  });
}

function togglePresenceMenu(wrap, u) {
  const existing = wrap.querySelector(".presence-menu");
  document.querySelectorAll(".presence-menu").forEach((m) => m.remove());
  if (existing) return; // was already open -> just closed it above

  const menu = document.createElement("div");
  menu.className = "presence-menu";

  if (state.isHost) {
    const modBtn = document.createElement("button");
    modBtn.textContent = u.isModerator ? "Remove moderator" : "Make moderator";
    modBtn.addEventListener("click", () => {
      socket.emit("set-moderator", { roomId: state.roomId, targetSocketId: u.id, isModerator: !u.isModerator });
      menu.remove();
    });
    menu.appendChild(modBtn);
  }

  const muteBtn = document.createElement("button");
  muteBtn.textContent = "Force mute";
  muteBtn.addEventListener("click", () => {
    socket.emit("force-mute", { roomId: state.roomId, targetSocketId: u.id });
    menu.remove();
  });
  menu.appendChild(muteBtn);

  const kickBtn = document.createElement("button");
  kickBtn.textContent = "Kick";
  kickBtn.addEventListener("click", () => {
    socket.emit("kick-user", { roomId: state.roomId, targetSocketId: u.id });
    menu.remove();
  });
  menu.appendChild(kickBtn);

  wrap.appendChild(menu);
}
document.addEventListener("click", () => document.querySelectorAll(".presence-menu").forEach((m) => m.remove()));

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("chat-message", { roomId: state.roomId, message });
  input.value = "";
});

socket.on("chat-message", renderChatMessage);

function renderChatMessage(entry) {
  const log = $("#chat-log");
  log.querySelector(".chat-empty-state")?.remove();
  const div = document.createElement("div");
  if (entry.system) {
    div.className = "chat-msg system";
    div.textContent = entry.message;
  } else {
    const isOwn = entry.userId === state.userId;
    const initials = (entry.username || "?").slice(0, 2).toUpperCase();
    const time = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
    div.className = "chat-row" + (isOwn ? " own" : "");
    div.innerHTML = `
      <div class="chat-avatar">${initials}</div>
      <div class="chat-bubble">
        <span class="who">${escapeHtml(entry.username)}</span>
        <span class="msg-text">${escapeHtml(entry.message)}</span>
        <span class="msg-time">${time}</span>
      </div>`;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// ---------------------------------------------------------------------
// 5. Smart Mode playback + drift correction
// ---------------------------------------------------------------------

$("#load-video-btn").addEventListener("click", () => {
  const url = $("#video-url-input").value.trim();
  if (!url) return;
  socket.emit("set-video-url", { roomId: state.roomId, url });
});

$("#bookmark-video-btn").addEventListener("click", async () => {
  const url = $("#video-url-input").value.trim();
  if (!url) return toast("Load a video first.");
  await fetch("/api/bookmarks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  toast("Bookmarked!");
});

socket.on("screenshare-required", () => {
  renderChatMessage({ system: true, message: "That link can't be embedded — starting screen share instead." });
  startScreenShare();
});

socket.on("video-changed", applyVideoChanged);

function applyVideoChanged(video) {
  $("#stage-empty").hidden = true;
  $("#youtube-player-mount").hidden = true;
  $("#file-player").hidden = true;
  $("#screenshare-player").hidden = true;

  if (video.url) $("#video-url-input").value = video.url;

  if (video.type === "youtube") {
    mountYouTube(video.videoId);
  } else if (video.type === "file") {
    const el = $("#file-player");
    el.hidden = false;
    el.src = video.url;
    wireFilePlayerEvents(el);
  }
}

function mountYouTube(videoId) {
  const mount = $("#youtube-player-mount");
  mount.hidden = false;

  const create = () => {
    if (state.youtubePlayer) {
      state.youtubePlayer.loadVideoById(videoId);
      return;
    }
    state.youtubePlayer = new YT.Player("youtube-player-mount", {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        autoplay: 0,
        controls: state.isHost || state.isModerator ? 1 : 0,
        rel: 0, // don't show related videos from other channels at the end
        modestbranding: 1, // smaller YouTube logo
        iv_load_policy: 3, // no annotations
        fs: 1,
      },
      events: { onReady: () => (state.youtubeReady = true), onStateChange: onYouTubeStateChange },
    });
  };

  if (window.YT && window.YT.Player) {
    create();
  } else {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = create;
  }
}

function onYouTubeStateChange(e) {
  if (!(state.isHost || state.isModerator) || state.suppressNextEvent) {
    state.suppressNextEvent = false;
    return;
  }
  const time = state.youtubePlayer.getCurrentTime();
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("playback-control", { roomId: state.roomId, action: "play", time });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("playback-control", { roomId: state.roomId, action: "pause", time });
  }
}

function wireFilePlayerEvents(el) {
  if (!(state.isHost || state.isModerator)) {
    el.controls = false;
    return;
  }
  el.addEventListener("play", () => {
    if (state.suppressNextEvent) return;
    socket.emit("playback-control", { roomId: state.roomId, action: "play", time: el.currentTime });
  });
  el.addEventListener("pause", () => {
    if (state.suppressNextEvent) return;
    socket.emit("playback-control", { roomId: state.roomId, action: "pause", time: el.currentTime });
  });
  el.addEventListener("seeked", () => {
    if (state.suppressNextEvent) return;
    socket.emit("playback-control", { roomId: state.roomId, action: "seek", time: el.currentTime });
  });
}

socket.on("playback-update", ({ action, time, rate }) => {
  state.suppressNextEvent = true;

  if (state.youtubePlayer && state.youtubeReady) {
    if (action === "play") {
      state.youtubePlayer.seekTo(time, true);
      state.youtubePlayer.playVideo();
    } else if (action === "pause") {
      state.youtubePlayer.seekTo(time, true);
      state.youtubePlayer.pauseVideo();
    } else if (action === "seek") {
      state.youtubePlayer.seekTo(time, true);
    } else if (action === "rate") {
      state.youtubePlayer.setPlaybackRate(rate);
    }
  }

  const fileEl = $("#file-player");
  if (!fileEl.hidden) {
    if (Math.abs(fileEl.currentTime - time) > 0.75) fileEl.currentTime = time;
    if (action === "play") fileEl.play();
    if (action === "pause") fileEl.pause();
    if (action === "rate") fileEl.playbackRate = rate;
  }
});

socket.on("sync-heartbeat", ({ expectedTime }) => {
  if (state.isHost) return;
  if (state.youtubePlayer && state.youtubeReady && typeof state.youtubePlayer.getCurrentTime === "function") {
    const current = state.youtubePlayer.getCurrentTime();
    if (Math.abs(current - expectedTime) > 0.75) {
      state.suppressNextEvent = true;
      state.youtubePlayer.seekTo(expectedTime, true);
    }
  }
  const fileEl = $("#file-player");
  if (!fileEl.hidden && Math.abs(fileEl.currentTime - expectedTime) > 0.75) {
    fileEl.currentTime = expectedTime;
  }
});

function getCurrentPlaybackTime() {
  if (state.youtubePlayer && state.youtubeReady) return state.youtubePlayer.getCurrentTime();
  const fileEl = $("#file-player");
  if (!fileEl.hidden) return fileEl.currentTime;
  return 0;
}

// ---------------------------------------------------------------------
// 6. In-room queue ("up next")
// ---------------------------------------------------------------------

$("#queue-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#queue-url-input");
  const url = input.value.trim();
  if (!url) return;
  socket.emit("playlist-add", { roomId: state.roomId, url, title: url });
  input.value = "";
});

socket.on("playlist-updated", (playlist) => {
  state.playlist = playlist;
  renderQueue();
});

function renderQueue() {
  const el = $("#queue-list");
  if (!state.playlist.length) {
    el.innerHTML = `<div class="chat-msg system">Nothing queued yet — add a link below.</div>`;
    return;
  }
  const canManage = state.isHost || state.isModerator;
  el.innerHTML = state.playlist
    .map(
      (item, i) => `
      <div class="queue-row">
        <span>${escapeHtml(item.title)} <span class="muted" style="color:var(--muted);font-size:0.72rem;">added by ${escapeHtml(item.addedBy)}</span></span>
        ${canManage ? `<div class="queue-actions">
          <button class="btn btn-primary" data-play="${i}">Play</button>
          <button class="btn btn-ghost" data-remove="${i}">✕</button>
        </div>` : ""}
      </div>`
    )
    .join("");

  $$("[data-play]").forEach((btn) => btn.addEventListener("click", () => socket.emit("playlist-play", { roomId: state.roomId, index: Number(btn.dataset.play) })));
  $$("[data-remove]").forEach((btn) => btn.addEventListener("click", () => socket.emit("playlist-remove", { roomId: state.roomId, index: Number(btn.dataset.remove) })));
}

// ---------------------------------------------------------------------
// 7. Subtitles
// ---------------------------------------------------------------------

function parseSubtitles(text, ext) {
  text = text.replace(/\r/g, "");
  if (ext === "vtt") text = text.replace(/^WEBVTT.*\n+/, "");
  const timeRegex = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-?-?>\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;
  const cues = [];
  text.split(/\n\s*\n/).forEach((block) => {
    const lines = block.split("\n").filter(Boolean);
    const timeLineIdx = lines.findIndex((l) => timeRegex.test(l));
    if (timeLineIdx === -1) return;
    const m = lines[timeLineIdx].match(timeRegex);
    const start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
    const end = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
    const text2 = lines
      .slice(timeLineIdx + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "");
    if (text2.trim()) cues.push({ start, end, text: text2.trim() });
  });
  return cues;
}

$("#subtitle-upload").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const ext = file.name.toLowerCase().endsWith(".vtt") ? "vtt" : "srt";
  const cues = parseSubtitles(text, ext);
  if (!cues.length) return toast("Couldn't find any subtitle cues in that file.");
  addSubtitleTrack(file.name.replace(/\.(srt|vtt)$/i, ""), cues);
});

function addSubtitleTrack(label, cues) {
  state.subtitleTracks.push({ label, cues });
  const select = $("#subtitle-track-select");
  const opt = document.createElement("option");
  opt.value = String(state.subtitleTracks.length - 1);
  opt.textContent = label;
  select.appendChild(opt);
  select.value = opt.value;
  state.activeSubtitleTrackIndex = state.subtitleTracks.length - 1;
}

$("#subtitle-track-select").addEventListener("change", (e) => {
  state.activeSubtitleTrackIndex = e.target.value === "" ? -1 : Number(e.target.value);
  if (state.activeSubtitleTrackIndex === -1) $("#subtitle-overlay").hidden = true;
});

$("#subtitle-offset").addEventListener("input", (e) => {
  state.subtitleOffset = Number(e.target.value) || 0;
});
$("#subtitle-size").addEventListener("input", (e) => {
  $("#subtitle-overlay").style.fontSize = e.target.value + "px";
});
$("#subtitle-color").addEventListener("input", (e) => {
  $("#subtitle-overlay").style.color = e.target.value;
});

$("#subtitle-translate-lang").addEventListener("change", async (e) => {
  const lang = e.target.value;
  if (!lang) return;
  if (state.activeSubtitleTrackIndex === -1) {
    toast("Load a subtitle track first, then translate it.");
    e.target.value = "";
    return;
  }
  const track = state.subtitleTracks[state.activeSubtitleTrackIndex];
  toast(`Translating to ${lang}…`);
  try {
    const res = await fetch("/api/subtitles/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cues: track.cues, targetLang: lang }),
    });
    const data = await res.json();
    if (data.cues) {
      addSubtitleTrack(`${track.label} → ${lang}`, data.cues);
      toast("Translation ready.");
    } else {
      toast(data.error || "Translation failed.");
    }
  } catch {
    toast("Translation failed.");
  }
  e.target.value = "";
});

setInterval(() => {
  if (state.activeSubtitleTrackIndex === -1 || !state.roomId) return;
  const track = state.subtitleTracks[state.activeSubtitleTrackIndex];
  if (!track) return;
  const t = getCurrentPlaybackTime() + state.subtitleOffset;
  const cue = track.cues.find((c) => t >= c.start && t <= c.end);
  const overlay = $("#subtitle-overlay");
  if (cue) {
    overlay.textContent = cue.text;
    overlay.hidden = false;
  } else {
    overlay.hidden = true;
  }
}, 250);

// ---------------------------------------------------------------------
// 8. Screen share + voice/video (WebRTC mesh)
// ---------------------------------------------------------------------

// STUN alone frequently fails to connect two devices on different
// networks (mobile carrier NAT especially) — a TURN relay is the
// fallback for exactly that case. Openrelay is a free, publicly
// documented TURN service commonly used for this; fine for testing/small
// scale, but a dedicated TURN provider (Twilio, Metered, or self-hosted
// coturn) is worth it once this has real traffic.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
];

$("#share-screen-btn").addEventListener("click", startScreenShare);
$("#stop-share-btn").addEventListener("click", stopScreenShare);

async function startScreenShare() {
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    if (err.name !== "NotAllowedError") {
      showRoomError("Couldn't start screen sharing: " + err.message);
      setTimeout(() => showRoomError(""), 4000);
    }
    return;
  }
  socket.emit("start-screen-share", { roomId: state.roomId });

  $("#stage-empty").hidden = true;
  $("#youtube-player-mount").hidden = true;
  $("#file-player").hidden = true;
  const el = $("#screenshare-player");
  el.hidden = false;
  el.srcObject = state.screenStream;

  $("#share-screen-btn").hidden = true;
  $("#stop-share-btn").hidden = false;

  state.peers.forEach((pc) => {
    state.screenStream.getTracks().forEach((track) => pc.addTrack(track, state.screenStream));
  });

  state.screenStream.getVideoTracks()[0].addEventListener("ended", stopScreenShare);
}

function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  socket.emit("stop-screen-share", { roomId: state.roomId });
  $("#screenshare-player").hidden = true;
  $("#share-screen-btn").hidden = false;
  $("#stop-share-btn").hidden = true;
}

socket.on("screen-share-started", ({ username }) => {
  renderChatMessage({ system: true, message: `${username} started sharing their screen` });
});
socket.on("screen-share-stopped", () => {
  renderChatMessage({ system: true, message: `Screen share ended` });
});

let mediaControlsInitialized = false;
function initLocalMediaControls() {
  if (mediaControlsInitialized) return;
  mediaControlsInitialized = true;
  $("#toggle-mic-btn").addEventListener("click", toggleMic);
  $("#toggle-cam-btn").addEventListener("click", toggleCam);
  setupTileClick(document.getElementById("local-video-tile"), "local");
  updatePeopleGridColumns();
}

async function toggleMic() {
  state.micOn = !state.micOn;
  setMicButtonState();

  if (state.micOn) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      state.localAudioTrack = stream.getAudioTracks()[0];
    } catch (err) {
      state.micOn = false;
      setMicButtonState();
      const msg =
        err.name === "NotAllowedError"
          ? "Microphone access was denied. Check your browser's site permissions to enable it."
          : "Couldn't access your microphone: " + err.message;
      showRoomError(msg);
      setTimeout(() => showRoomError(""), 5000);
      return;
    }
    state.peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (sender) sender.replaceTrack(state.localAudioTrack);
      else pc.addTrack(state.localAudioTrack);
    });
  } else if (state.localAudioTrack) {
    state.localAudioTrack.stop(); // fully releases the microphone — not just muting it
    state.localAudioTrack = null;
    state.peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "audio");
      if (sender) sender.replaceTrack(null);
    });
  }
  if (state.roomId) socket.emit("media-state", { roomId: state.roomId, kind: "audio", on: state.micOn });
}

function setMicButtonState() {
  $("#toggle-mic-btn").dataset.on = String(state.micOn);
  $("#toggle-mic-btn").querySelector(".av-btn-text").textContent = state.micOn ? "Mic on" : "Mic off";
}

async function toggleCam() {
  state.camOn = !state.camOn;
  setCamButtonState();
  const selfTile = document.getElementById("local-video-tile");

  if (state.camOn) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      state.localVideoTrack = stream.getVideoTracks()[0];
    } catch (err) {
      state.camOn = false;
      setCamButtonState();
      const msg =
        err.name === "NotAllowedError"
          ? "Camera access was denied. Check your browser's site permissions to enable it."
          : "Couldn't access your camera: " + err.message;
      showRoomError(msg);
      setTimeout(() => showRoomError(""), 5000);
      return;
    }
    $("#local-video-preview").srcObject = new MediaStream([state.localVideoTrack]);
    selfTile.classList.add("cam-on");
    state.peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(state.localVideoTrack);
      else pc.addTrack(state.localVideoTrack);
    });
    // If the OS/browser revokes the camera externally (unplugged, another
    // app grabbed it), reflect that in the UI instead of looking frozen.
    state.localVideoTrack.addEventListener("ended", () => {
      if (state.camOn) toggleCam();
    });
  } else if (state.localVideoTrack) {
    state.localVideoTrack.stop(); // fully releases the camera — this is what turns the hardware light off
    state.localVideoTrack = null;
    $("#local-video-preview").srcObject = null;
    selfTile.classList.remove("cam-on");
    state.peers.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
      if (sender) sender.replaceTrack(null);
    });
  }
  if (state.roomId) socket.emit("media-state", { roomId: state.roomId, kind: "video", on: state.camOn });
}

function setCamButtonState() {
  $("#toggle-cam-btn").dataset.on = String(state.camOn);
  $("#toggle-cam-btn").querySelector(".av-btn-text").textContent = state.camOn ? "Camera on" : "Camera off";
}

// A peer's tile reliably reflects their actual on/off choice via this
// explicit signal, rather than inferring it from raw WebRTC track/frame
// presence (which is unreliable once replaceTrack(null) is involved).
socket.on("media-state", ({ fromId, kind, on }) => {
  if (kind !== "video") return;
  document.getElementById(`tile-${fromId}`)?.classList.toggle("cam-on", on);
});

function createPeerConnection(remoteId) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (state.localAudioTrack) pc.addTrack(state.localAudioTrack);
  if (state.localVideoTrack) pc.addTrack(state.localVideoTrack);
  if (state.screenStream) state.screenStream.getTracks().forEach((track) => pc.addTrack(track, state.screenStream));

  // Whenever tracks are added/removed/replaced on this connection (mic or
  // camera toggled on for the first time, screen share started, etc.),
  // the browser fires this automatically — we just need to actually
  // re-offer when it does, which is what makes those changes reach peers.
  pc.onnegotiationneeded = async () => {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-signal", { roomId: state.roomId, targetId: remoteId, signal: { type: "offer", sdp: offer } });
    } catch (err) {
      console.error("renegotiation failed:", err);
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit("webrtc-signal", { roomId: state.roomId, targetId: remoteId, signal: { type: "ice-candidate", candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    let tile = document.getElementById(`tile-${remoteId}`);
    if (!tile) {
      const username = state.users.get(remoteId)?.username || "Guest";
      tile = document.createElement("div");
      tile.id = `tile-${remoteId}`;
      tile.className = "video-tile";
      tile.innerHTML = `<video autoplay playsinline></video><div class="tile-off-icon">🎧</div><div class="tile-label">${escapeHtml(username)}</div>`;
      $("#people-grid").appendChild(tile);
      setupTileClick(tile, remoteId);
      updatePeopleGridColumns();
    }
    tile.querySelector("video").srcObject = e.streams[0];
    if (e.track.kind === "video") tile.classList.add("cam-on");
  };

  state.peers.set(remoteId, pc);
  return pc;
}

function callPeer(remoteId) {
  // No manual offer here — createPeerConnection adding tracks (if any
  // exist yet) triggers onnegotiationneeded automatically, which sends
  // the first offer. Keeps the "initial call" and "renegotiate later"
  // paths as one single code path instead of two that can conflict.
  createPeerConnection(remoteId);
}

socket.on("webrtc-signal", async ({ fromId, signal }) => {
  let pc = state.peers.get(fromId);
  if (signal.type === "offer") {
    if (!pc) pc = createPeerConnection(fromId);
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-signal", { roomId: state.roomId, targetId: fromId, signal: { type: "answer", sdp: answer } });
  } else if (signal.type === "answer") {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
  } else if (signal.type === "ice-candidate") {
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch {
        /* benign */
      }
    }
  }
});

function closePeer(remoteId) {
  const pc = state.peers.get(remoteId);
  if (pc) {
    pc.close();
    state.peers.delete(remoteId);
  }
  const tile = document.getElementById(`tile-${remoteId}`);
  if (tile) tile.remove();
  if (state.pinnedId === remoteId) state.pinnedId = null;
  updatePeopleGridColumns();
}

// ---------------------------------------------------------------------
// Pinning (People tab) — click anyone to make them the large tile,
// click again to go back to the grid, same idea as Meet/Zoom.
// ---------------------------------------------------------------------

function setupTileClick(tileEl, id) {
  if (!tileEl || tileEl.dataset.pinWired) return;
  tileEl.dataset.pinWired = "true";
  tileEl.addEventListener("click", () => {
    state.pinnedId = state.pinnedId === id ? null : id;
    applyPinning();
  });
}

function applyPinning() {
  document.querySelectorAll("#people-grid .video-tile").forEach((t) => t.classList.remove("pinned"));
  if (!state.pinnedId) return;
  const el =
    state.pinnedId === "local" ? document.getElementById("local-video-tile") : document.getElementById(`tile-${state.pinnedId}`);
  el?.classList.add("pinned");
}

// Meet-style adaptive tiling: as more people join, shrink toward more
// columns (smaller tiles) instead of just stacking rows forever; as
// people leave, tiles grow back to use the space.
function updatePeopleGridColumns() {
  const count = document.querySelectorAll("#people-grid .video-tile").length || 1;
  const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
  $("#people-grid").style.setProperty("--people-cols", cols);
}

// ---------------------------------------------------------------------
// Sidebar drawer + tabs (Chat / Queue / Ask AI). People are a permanent
// rail now (see people-rail in the HTML), not one of these on-demand tabs.
// ---------------------------------------------------------------------

$("#chat-toggle-btn").addEventListener("click", () => $("#chat-col").classList.toggle("open"));
$("#drawer-close-btn").addEventListener("click", () => $("#chat-col").classList.remove("open"));

$("#tab-chat-btn").addEventListener("click", () => switchSidebarTab("chat"));
$("#tab-queue-btn").addEventListener("click", () => switchSidebarTab("queue"));
$("#tab-ai-btn").addEventListener("click", () => switchSidebarTab("ai"));

function switchSidebarTab(tab) {
  $("#tab-chat-btn").classList.toggle("active", tab === "chat");
  $("#tab-queue-btn").classList.toggle("active", tab === "queue");
  $("#tab-ai-btn").classList.toggle("active", tab === "ai");
  $("#chat-panel").hidden = tab !== "chat";
  $("#queue-panel").hidden = tab !== "queue";
  $("#ai-panel").hidden = tab !== "ai";
  $("#chat-col").classList.add("open");
}

// ---------------------------------------------------------------------
// 9. Ask AI
// ---------------------------------------------------------------------

function currentVideoUrlForAi() {
  return $("#video-url-input").value.trim() || null;
}

function appendAiMessage(who, text) {
  const log = $("#ai-log");
  const div = document.createElement("div");
  if (who === "system") {
    div.className = "chat-msg system";
    div.textContent = text;
  } else {
    div.className = "chat-msg";
    div.innerHTML = `<span class="who">${who === "you" ? "You" : "AI"}</span>${escapeHtml(text)}`;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function runAiAction(kind, question) {
  switchSidebarTab("ai");
  appendAiMessage("you", question || kind.replace(/_/g, " "));
  const thinking = appendAiMessage("system", "Thinking…");
  try {
    const res = await fetch("/api/ai/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, question, videoUrl: currentVideoUrlForAi() }),
    });
    const data = await res.json();
    thinking.remove();
    appendAiMessage("ai", data.answer || data.error || "No response.");
  } catch {
    thinking.remove();
    appendAiMessage("ai", "Couldn't reach the AI assistant.");
  }
}

$("#ai-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#ai-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  runAiAction("ask", question);
});

$$(".ai-quick").forEach((btn) => btn.addEventListener("click", () => runAiAction(btn.dataset.kind)));

// ---------------------------------------------------------------------
// 10a. Friends panel
// ---------------------------------------------------------------------

$("#friends-btn").addEventListener("click", () => {
  openPanel("friends-panel");
  loadFriends();
});

let searchDebounce = null;
$("#friend-search-input").addEventListener("input", (e) => {
  clearTimeout(searchDebounce);
  const q = e.target.value.trim();
  if (!q) {
    $("#friend-search-results").innerHTML = "";
    return;
  }
  searchDebounce = setTimeout(async () => {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderFriendSearchResults(data.users || []);
  }, 300);
});

function renderFriendSearchResults(users) {
  $("#friend-search-results").innerHTML = "";
  users.forEach((u) => {
    const row = document.createElement("div");
    row.className = "side-row";
    row.innerHTML = `<span>${escapeHtml(u.name || u.email)}</span>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary";
    btn.textContent = "Add";
    btn.addEventListener("click", async () => {
      await fetch("/api/friends/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: u.id }),
      });
      btn.textContent = "Sent";
      btn.disabled = true;
    });
    row.appendChild(btn);
    $("#friend-search-results").appendChild(row);
  });
}

async function loadFriends() {
  const res = await fetch("/api/friends");
  if (!res.ok) return;
  const data = await res.json();

  const reqEl = $("#friend-requests");
  reqEl.innerHTML = data.incoming?.length ? "<h4>Requests</h4>" : "";
  (data.incoming || []).forEach((r) => {
    const row = document.createElement("div");
    row.className = "side-row";
    row.innerHTML = `<span>${escapeHtml(r.name)}</span>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "Accept";
    btn.addEventListener("click", async () => {
      await fetch("/api/friends/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: r.request_id }),
      });
      loadFriends();
    });
    row.appendChild(btn);
    reqEl.appendChild(row);
  });

  const listEl = $("#friend-list");
  listEl.innerHTML = "<h4>Your friends</h4>";
  (data.friends || []).forEach((f) => {
    const row = document.createElement("div");
    row.className = "side-row";
    row.innerHTML = `<span>${escapeHtml(f.name)}</span>`;
    if (state.roomId) {
      const inviteBtn = document.createElement("button");
      inviteBtn.className = "btn btn-secondary";
      inviteBtn.textContent = "Invite here";
      inviteBtn.addEventListener("click", () => {
        socket.emit("invite-friend", { roomId: state.roomId, friendAccountId: f.id });
        toast(`Invited ${f.name}.`);
      });
      row.appendChild(inviteBtn);
    }
    listEl.appendChild(row);
  });
  if (!data.friends?.length) listEl.innerHTML += `<p class="dash-empty">No friends yet — search above to add some.</p>`;
}

// ---------------------------------------------------------------------
// 10b. Profile panel
// ---------------------------------------------------------------------

function openProfile() {
  openPanel("profile-panel");
  loadProfile();
}

async function loadProfile() {
  const res = await fetch("/api/profile");
  if (!res.ok) return;
  const data = await res.json();

  $("#profile-stats").innerHTML = `
    <div class="stat"><b>${data.stats.roomsWatched}</b><span>Rooms watched in</span></div>
    <div class="stat"><b>${data.stats.totalWatches}</b><span>Videos watched</span></div>
    <div class="stat"><b>${data.stats.friendCount}</b><span>Friends</span></div>
  `;
  $("#profile-bio").value = data.profile.bio || "";
  $("#profile-genres").value = data.profile.favorite_genres || "";

  const badges = [];
  if (data.stats.totalWatches >= 1) badges.push("First Watch");
  if (data.stats.totalWatches >= 10) badges.push("Regular");
  if (data.stats.totalWatches >= 50) badges.push("Superfan");
  if (data.stats.friendCount >= 1) badges.push("Making friends");
  if (data.stats.friendCount >= 5) badges.push("Social butterfly");
  if (state.account) badges.push("Host");
  $("#profile-achievements").innerHTML = badges.map((b) => `<span class="achievement-badge">${b}</span>`).join("") || `<p class="dash-empty">Watch something to earn your first badge!</p>`;

  const histRes = await fetch("/api/history");
  const hist = await histRes.json();
  renderRows(
    "#profile-history",
    hist.history,
    (h) => `<div class="side-row"><span>${escapeHtml((h.video_url || "").slice(0, 40))}</span><span class="muted">${timeAgo(h.watched_at)}</span></div>`,
    "Nothing watched yet."
  );
}

$("#profile-save-btn").addEventListener("click", async () => {
  await fetch("/api/profile", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bio: $("#profile-bio").value, favoriteGenres: $("#profile-genres").value }),
  });
  toast("Profile saved.");
});

// ---------------------------------------------------------------------
// 10c. Library panel (personal playlists + bookmarks)
// ---------------------------------------------------------------------

function openLibrary() {
  openPanel("library-panel");
  loadLibrary();
}

async function loadLibrary() {
  const [plRes, bmRes] = await Promise.all([fetch("/api/playlists"), fetch("/api/bookmarks")]);
  const playlists = (await plRes.json()).playlists || [];
  const bookmarks = (await bmRes.json()).bookmarks || [];

  const plEl = $("#playlists-list");
  if (!playlists.length) {
    plEl.innerHTML = `<p class="dash-empty">No playlists yet.</p>`;
  } else {
    plEl.innerHTML = playlists
      .map(
        (p) => `
        <div class="side-row" style="flex-direction:column;align-items:stretch;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <b>${escapeHtml(p.name)}</b>
            <div>
              ${state.roomId ? `<button class="btn btn-secondary btn-sm" data-queue-playlist="${p.id}">Add to queue</button>` : ""}
              <button class="btn btn-ghost btn-sm" data-delete-playlist="${p.id}">Delete</button>
            </div>
          </div>
          ${
            p.items.length
              ? `<div class="playlist-items">${p.items
                  .map(
                    (item) => `
                <div class="playlist-item-row">
                  <span>${escapeHtml((item.title || item.url).slice(0, 40))}</span>
                  <button class="btn btn-ghost btn-sm" data-delete-item="${item.id}">✕</button>
                </div>`
                  )
                  .join("")}</div>`
              : `<span class="dash-empty">No videos in this playlist yet.</span>`
          }
          <form class="inline-form add-item-form" data-playlist-id="${p.id}">
            <input type="text" placeholder="Paste a video URL to add…" class="add-item-input" />
            <button class="btn btn-secondary btn-sm">Add</button>
          </form>
        </div>`
      )
      .join("");

    $$(".add-item-form").forEach((form) =>
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector(".add-item-input");
        const url = input.value.trim();
        if (!url) return;
        await fetch(`/api/playlists/${form.dataset.playlistId}/items`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, title: url }),
        });
        loadLibrary();
      })
    );
    $$("[data-delete-item]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await fetch(`/api/playlists/items/${btn.dataset.deleteItem}`, { method: "DELETE" });
        loadLibrary();
      })
    );
    $$("[data-delete-playlist]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await fetch(`/api/playlists/${btn.dataset.deletePlaylist}`, { method: "DELETE" });
        loadLibrary();
      })
    );
    $$("[data-queue-playlist]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const playlist = playlists.find((p) => p.id === btn.dataset.queuePlaylist);
        playlist.items.forEach((item) => socket.emit("playlist-add", { roomId: state.roomId, url: item.url, title: item.title }));
        toast(`Added "${playlist.name}" to the queue.`);
      })
    );
  }

  renderRows(
    "#bookmarks-list",
    bookmarks,
    (b) => `<div class="side-row"><span>${escapeHtml((b.title || b.url).slice(0, 40))}</span>
      <div><button class="btn btn-secondary btn-sm" data-load-bookmark="${escapeHtml(b.url)}">Load</button>
      <button class="btn btn-ghost btn-sm" data-delete-bookmark="${b.id}">✕</button></div></div>`,
    "No bookmarks yet."
  );
  $$("[data-load-bookmark]").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (!state.roomId) return toast("Join a room first.");
      socket.emit("set-video-url", { roomId: state.roomId, url: btn.dataset.loadBookmark });
      closePanel("library-panel");
    })
  );
  $$("[data-delete-bookmark]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await fetch(`/api/bookmarks/${btn.dataset.deleteBookmark}`, { method: "DELETE" });
      loadLibrary();
    })
  );
}

$("#new-playlist-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#new-playlist-name");
  const name = input.value.trim();
  if (!name) return;
  await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  input.value = "";
  loadLibrary();
});

// ---------------------------------------------------------------------
// 10d. Notifications
// ---------------------------------------------------------------------

function openNotifications() {
  openPanel("notifications-panel");
  fetch("/api/notifications/read", { method: "POST" }).then(() => {
    $("#notif-badge").hidden = true;
    $("#notif-badge-landing").hidden = true;
  });
  renderNotifications();
}
$("#notif-bell-btn").addEventListener("click", openNotifications);

function notificationText(n) {
  switch (n.type) {
    case "friend_request":
      return `${escapeHtml(n.data.fromName || "Someone")} sent you a friend request.`;
    case "friend_accepted":
      return `${escapeHtml(n.data.byName || "Someone")} accepted your friend request.`;
    case "room_invite":
      return `${escapeHtml(n.data.fromName || "Someone")} invited you to a room.`;
    case "mention":
      return `${escapeHtml(n.data.byName || "Someone")} mentioned you: "${escapeHtml(n.data.message || "")}"`;
    case "party_invite":
      return `${escapeHtml(n.data.byName || "Someone")} invited you to a watch party: ${escapeHtml(n.data.title || "")}`;
    case "party_starting":
      return `Watch party "${escapeHtml(n.data.title || "")}" is starting soon.`;
    default:
      return "New notification.";
  }
}

async function pollNotifications() {
  if (!state.account) return;
  const res = await fetch("/api/notifications");
  if (!res.ok) return;
  const data = await res.json();

  data.notifications.forEach((n) => {
    if (!state.seenNotifIds.has(n.id)) {
      state.seenNotifIds.add(n.id);
      if (state.notifPolled) toast(notificationText(n)); // don't toast the initial backlog on first load
    }
  });
  state.notifPolled = true;

  [$("#notif-badge"), $("#notif-badge-landing")].forEach((el) => {
    if (!el) return;
    if (data.unread > 0) {
      el.textContent = data.unread;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  });
}

async function renderNotifications() {
  const res = await fetch("/api/notifications");
  const data = await res.json();
  renderRows(
    "#notifications-list",
    data.notifications,
    (n) => `<div class="side-row"><span>${notificationText(n)}</span><span class="muted">${timeAgo(n.created_at)}</span></div>`,
    "No notifications yet."
  );
}

// ---------------------------------------------------------------------
// 10e. Room security (host) + join requests (host/mod)
// ---------------------------------------------------------------------

$("#room-security-btn").addEventListener("click", () => openPanel("room-security-panel"));

$("#security-save-btn").addEventListener("click", () => {
  socket.emit("set-room-security", {
    roomId: state.roomId,
    password: $("#security-password").value.trim(),
    waitingRoomEnabled: $("#security-waiting-room").checked,
  });
});
socket.on("room-security-updated", () => {
  toast("Room settings saved.");
  closePanel("room-security-panel");
});

const pendingRequests = new Map();
$("#join-requests-btn").addEventListener("click", () => openPanel("join-requests-panel"));

$("#more-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#more-menu-dropdown").hidden = !$("#more-menu-dropdown").hidden;
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".more-menu-wrap")) $("#more-menu-dropdown").hidden = true;
});
$("#more-menu-dropdown").addEventListener("click", (e) => {
  if (e.target.closest("button")) $("#more-menu-dropdown").hidden = true;
});

function updateMoreMenuVisibility() {
  const anyVisible = ["#friends-btn", "#room-security-btn", "#join-requests-btn"].some((sel) => !$(sel).hidden);
  $("#more-menu-btn").hidden = !anyVisible;
}

socket.on("join-request", ({ socketId, username }) => {
  pendingRequests.set(socketId, username);
  updateJoinRequestsBadge();
  renderJoinRequests();
});

function updateJoinRequestsBadge() {
  const badge = $("#join-requests-badge");
  const menuBadge = $("#more-menu-badge");
  if (pendingRequests.size > 0) {
    badge.textContent = pendingRequests.size;
    badge.hidden = false;
    menuBadge.textContent = pendingRequests.size;
    menuBadge.hidden = false;
  } else {
    badge.hidden = true;
    menuBadge.hidden = true;
  }
}

function renderJoinRequests() {
  const el = $("#join-requests-list");
  if (!pendingRequests.size) {
    el.innerHTML = `<p class="dash-empty">No pending requests.</p>`;
    return;
  }
  el.innerHTML = "";
  pendingRequests.forEach((username, socketId) => {
    const row = document.createElement("div");
    row.className = "side-row";
    row.innerHTML = `<span>${escapeHtml(username)}</span>`;
    const approveBtn = document.createElement("button");
    approveBtn.className = "btn btn-primary";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", () => {
      socket.emit("approve-join", { roomId: state.roomId, socketId });
      pendingRequests.delete(socketId);
      updateJoinRequestsBadge();
      renderJoinRequests();
    });
    const denyBtn = document.createElement("button");
    denyBtn.className = "btn btn-ghost";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      socket.emit("deny-join", { roomId: state.roomId, socketId });
      pendingRequests.delete(socketId);
      updateJoinRequestsBadge();
      renderJoinRequests();
    });
    row.appendChild(approveBtn);
    row.appendChild(denyBtn);
    el.appendChild(row);
  });
}

// ---------------------------------------------------------------------
// 10f. Scheduled watch parties are created via the /api/parties endpoint
// (kept server-side for anyone who wants to build a UI for it) — the
// in-app creation modal was removed after it caused a CSS/hidden-state
// bug. The dashboard still lists any parties you're invited to.
// ---------------------------------------------------------------------
