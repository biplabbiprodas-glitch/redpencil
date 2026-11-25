/* Redpencil Phone — messages, file transfer, group calls, background service & lock-screen ringing.
   Loaded after the main app script; uses its globals (S, db, TS, $, toast, ...). */
'use strict';

/* ================= native bridge (Android app only) ================= */
var RPN = null;
try {
  if (window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) {
    RPN = Capacitor.registerPlugin ? Capacitor.registerPlugin('RPNative') : (Capacitor.Plugins && Capacitor.Plugins.RPNative);
  }
} catch (e) { RPN = null; }
function nat(method, args) { if (!RPN || !RPN[method]) return Promise.resolve(null); return RPN[method](args || {}).catch(function () { return null; }); }

// Show as online for up to ~3 minutes after the last heartbeat (phones slow down background timers).
window.isOnline = function (u) { var t = u.lastSeen && u.lastSeen.toMillis ? u.lastSeen.toMillis() : 0; return !!u.online && Date.now() - t < 200000; };

function beatNow() { if (S.uid && db) db.collection('users').doc(S.uid).update({ online: true, lastSeen: TS() }).catch(function () {}); }
function nameOf(uid) { var u = S.staff.find(function (x) { return x.id === uid; }); return u ? u.name : 'Colleague'; }
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

/* ================= hooks into the main app ================= */
var _startApp = window.startApp;
window.startApp = function () {
  var first = !window.__rpFeat;
  _startApp.apply(this, arguments);
  if (first) { window.__rpFeat = true; initFeatures(); }
};

// Ring on the lock screen / in background, and stop it when the call is handled.
function nativeRing(name, sub) {
  nat('showIncoming', { name: name, sub: sub }).then(function (r) { if (r && r.native) stopTone(); });
}
var _incomingInternal = window.incomingInternal;
window.incomingInternal = function (id, d) {
  _incomingInternal(id, d);
  // Tell the caller the call really reached this device, so their screen shows "Ringing…".
  try { db.collection('calls').doc(id).update({ delivered: TS() }).catch(function () {}); } catch (e) {}
  nativeRing(d.callerName, (d.video ? 'Video call' : 'Voice call') + ' · Ext ' + d.callerExt);
};
// Caller side: show "Ringing…" only once the other device confirms it is ringing,
// instead of guessing from the online dot. Say "may be offline" only after 12 s without a reply.
var _callInternal = window.callInternal;
window.callInternal = function (u, video) {
  var r = _callInternal.apply(this, arguments);
  var c = S.call;
  if (!c || c.kind !== 'internal' || c.dir !== 'out') return r;
  var tries = 0;
  var iv = setInterval(function () {
    if (c.ended || ++tries > 300) { clearInterval(iv); return; }
    if (!c.docReady || !c.ref) return;
    clearInterval(iv);
    var say = function (t) { if (!c.ended && c.status === 'ringing' && S.call === c) $('#callStatus').textContent = t; };
    if (!c.delivered) say('Calling…');
    var late = setTimeout(function () { if (!c.delivered) say('Calling… (may be offline)'); }, 12000);
    c.unsubs.push(c.ref.onSnapshot(function (s) {
      var d = s.data();
      if (d && d.delivered && !c.delivered) { c.delivered = true; clearTimeout(late); say('Ringing…'); }
    }));
  }, 100);
  return r;
};
var _incomingSip = window.incomingSip;
window.incomingSip = function (s) {
  _incomingSip(s);
  if (S.call && S.call.session === s) nativeRing(S.call.name, 'Outside line · ' + S.call.number);
};
var _acceptInternal = window.acceptInternal;
window.acceptInternal = function (c) { nat('cancelIncoming'); return _acceptInternal(c); };
var _markActive = window.markActive;
window.markActive = function (c) { var was = c.status; _markActive(c); if (was !== 'active') { nat('cancelIncoming'); nat('callActive', { on: true }); } };
var _endLocal = window.endLocal;
window.endLocal = function (c, msg, result) { var had = c && !c.ended; _endLocal(c, msg, result); if (had) { nat('cancelIncoming'); nat('callActive', { on: false }); } };

// Accept / decline / end buttons also handle group-call invitations.
(function () {
  var acc = $('#cAccept').onclick, dec = $('#cDecline').onclick, end = $('#cEnd').onclick;
  $('#cAccept').onclick = function () { if (S.call && S.call.kind === 'groupInvite') return acceptInvite(S.call); return acc(); };
  $('#cDecline').onclick = function () { if (S.call && S.call.kind === 'groupInvite') return declineInvite(S.call, 'declined'); return dec(); };
  $('#cEnd').onclick = function () { if (S.call && S.call.kind === 'groupInvite') return declineInvite(S.call, 'declined'); return end(); };
})();

function onCallAction(action) {
  if (!action) return;
  if (action === 'answer') { if (S.call && S.call.status === 'incoming') $('#cAccept').click(); }
  else if (action === 'decline') { if (S.call && S.call.status === 'incoming') $('#cDecline').click(); }
  else if (action.indexOf('chat:') === 0) { var id = action.slice(5); if (id && CH.chats.has(id)) openChat(id); }
}

function initFeatures() {
  listenChats();
  listenInvites();
  if (RPN) {
    nat('start').then(refreshBg);
    try {
      RPN.addListener('callAction', function (a) { onCallAction(a && a.action); });
      RPN.addListener('appState', function (s) { if (s && s.state === 'foreground') { beatNow(); refreshBg(); } });
    } catch (e) {}
    $('#bgCard').classList.remove('hidden');
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) beatNow(); });
}

/* ================= "Stay online & ringing" settings ================= */
function refreshBg() {
  if (!RPN) return;
  nat('status').then(function (st) {
    if (!st) return;
    var rows = [
      ['notifications', 'Notifications', 'Needed to ring and show messages', st.notifications],
      ['fullscreen', 'Ring on lock screen', 'Shows the call screen even when the phone is locked', st.fullScreen],
      ['battery', 'No battery limits', 'Stops Android from putting the app to sleep', st.battery]
    ];
    $('#bgStatus').innerHTML = rows.map(function (r) {
      return '<div class="row" style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="info"><b>' + r[1] + '</b><span>' + r[2] + '</span></div>' +
        (r[3] ? '<span style="color:var(--green);font-weight:700">On ✓</span>' : '<button class="btn small" data-set="' + r[0] + '">Turn on</button>') + '</div>';
    }).join('') + '<p class="muted" style="margin-top:10px">Samsung: also open Recent apps, tap the Redpencil icon → <b>Keep open</b> (or Lock this app). Don\'t swipe the app away.</p>';
  });
}
document.addEventListener('click', function (e) {
  var b = e.target.closest('[data-set]'); if (!b) return;
  nat('openSetting', { which: b.dataset.set });
});

/* ================= people picker ================= */
var pickResolve = null;
function openPicker(opts) {
  opts = opts || {};
  $('#pickTitle').textContent = opts.title || 'Choose people';
  $('#pickSub').textContent = opts.sub || '';
  $('#pickNameWrap').classList.toggle('hidden', !opts.withName);
  $('#pickName').value = '';
  $('#pickOk').textContent = opts.ok || 'Start';
  var ex = opts.exclude || [];
  var list = S.staff.filter(function (u) { return u.approved && u.id !== S.uid && ex.indexOf(u.id) < 0; })
    .sort(function (a, b) { return (isOnline(b) - isOnline(a)) || String(a.name).localeCompare(b.name); });
  $('#pickList').innerHTML = list.length ? list.map(function (u) {
    return '<label class="row"><input type="checkbox" value="' + u.id + '"><div class="av">' + esc(initials(u.name)) + '<span class="dot ' + (isOnline(u) ? 'on' : '') + '"></span></div>' +
      '<div class="info"><b>' + esc(u.name) + '</b><span>Ext ' + esc(u.ext) + (u.dept ? ' · ' + esc(u.dept) : '') + (isOnline(u) ? '' : ' · offline') + '</span></div></label>';
  }).join('') : '<div class="empty">No other staff to add.</div>';
  $('#picker').classList.remove('hidden');
  return new Promise(function (res) { pickResolve = res; });
}
function closePicker(val) { $('#picker').classList.add('hidden'); var r = pickResolve; pickResolve = null; if (r) r(val); }
$('#pickBack').onclick = function () { closePicker(null); };
$('#pickOk').onclick = function () {
  var uids = $$('#pickList input:checked').map(function (i) { return i.value; });
  if (!uids.length) return toast('Choose at least one person');
  var name = $('#pickName').value.trim();
  if (!$('#pickNameWrap').classList.contains('hidden') && !name) name = [S.me.name.split(' ')[0]].concat(uids.slice(0, 2).map(function (u) { return nameOf(u).split(' ')[0]; })).join(', ') + (uids.length > 2 ? ' +' + (uids.length - 2) : '');
  closePicker({ uids: uids, name: name });
};

/* ================= chats ================= */
var CH = { chats: new Map(), open: null, unsub: null, started: Date.now(), pending: {}, docs: [] };
var CHUNK = 600 * 1024, MAX_FILE = 15 * 1024 * 1024;

function chatTitle(c) {
  if (c.group) return c.name || 'Group';
  var other = (c.members || []).find(function (m) { return m !== S.uid; });
  return nameOf(other) || (c.names && c.names[other]) || 'Chat';
}
function unreadOf(c) { return c.lastFrom && c.lastFrom !== S.uid && (c.lastT || 0) > ((c.reads && c.reads[S.uid]) || 0); }

function listenChats() {
  db.collection('chats').where('members', 'array-contains', S.uid).onSnapshot(function (snap) {
    snap.docChanges().forEach(function (ch) {
      var id = ch.doc.id;
      if (ch.type === 'removed') { CH.chats.delete(id); return; }
      var d = ch.doc.data(), prev = CH.chats.get(id);
      CH.chats.set(id, d);
      var prevT = prev ? (prev.lastT || 0) : CH.started;
      if (d.lastFrom && d.lastFrom !== S.uid && (d.lastT || 0) > prevT && CH.open !== id) {
        var who = d.group ? (nameOf(d.lastFrom).split(' ')[0] + ' @ ' + chatTitle(d)) : chatTitle(d);
        toast('💬 ' + who + ': ' + (d.lastText || ''), 3500);
        chime();
        nat('notifyMessage', { title: who, body: d.lastText || 'New message', tag: id });
      }
    });
    renderChats();
    if (CH.open && CH.chats.has(CH.open)) renderChatHeader(CH.open);
  }, function (e) { toast('Chats: ' + e.message, 5000); });
}
function chime() {
  try {
    var ctx = getCtx(), t = ctx.currentTime;
    [[880, 0], [1318.5, 0.12]].forEach(function (p) {
      var o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = p[0]; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + p[1]); g.gain.exponentialRampToValueAtTime(0.35, t + p[1] + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + p[1] + 0.5);
      o.connect(g); g.connect(ctx.destination); o.start(t + p[1]); o.stop(t + p[1] + 0.55);
    });
  } catch (e) {}
}
function renderChats() {
  var arr = Array.from(CH.chats.entries()).sort(function (a, b) { return (b[1].lastT || 0) - (a[1].lastT || 0); });
  var unreadCount = arr.filter(function (e) { return unreadOf(e[1]); }).length;
  var badge = $('#chatBadge'); badge.textContent = unreadCount; badge.classList.toggle('hidden', !unreadCount);
  if (!arr.length) { $('#chatList').innerHTML = '<div class="empty">No chats yet.<br>Tap the blue message button next to a colleague in <b>Staff</b>, or create a <b>group chat</b> there.</div>'; return; }
  $('#chatList').innerHTML = '<div class="list">' + arr.map(function (e) {
    var id = e[0], c = e[1], un = unreadOf(c);
    var prefix = c.lastFrom === S.uid ? 'You: ' : (c.group && c.lastFrom ? nameOf(c.lastFrom).split(' ')[0] + ': ' : '');
    return '<div class="row tap" data-chat="' + id + '"><div class="av">' + (c.group ? '👥' : esc(initials(chatTitle(c)))) + '</div>' +
      '<div class="info"><b' + (un ? ' style="font-weight:800"' : '') + '>' + esc(chatTitle(c)) + '</b><span>' + esc(prefix + (c.lastText || '')) + '</span></div>' +
      '<div class="meta">' + (c.lastT ? esc(fmtWhen(c.lastT)) : '') + (un ? '<span class="unread">•</span>' : '') + '</div></div>';
  }).join('') + '</div>';
}
$('#chatList').addEventListener('click', function (e) { var r = e.target.closest('[data-chat]'); if (r) openChat(r.dataset.chat); });

$('#staffList').addEventListener('click', function (e) {
  var b = e.target.closest('[data-msg]'); if (!b) return;
  var u = S.staff.find(function (x) { return x.id === b.dataset.msg; }); if (u) openDM(u);
});
function openDM(u) {
  var id = 'dm_' + [S.uid, u.id].sort().join('_');
  var ref = db.collection('chats').doc(id);
  if (CH.chats.has(id)) return openChat(id);
  ref.get().then(function (s) {
    if (s.exists) { CH.chats.set(id, s.data()); return; }
    var names = {}; names[S.uid] = S.me.name; names[u.id] = u.name;
    var d = { members: [S.uid, u.id], group: false, names: names, createdAt: TS(), lastT: 0, lastText: '', lastFrom: '', reads: {} };
    return ref.set(d).then(function () { CH.chats.set(id, d); });
  }).then(function () { openChat(id); }).catch(function (e) { toast('Could not open chat: ' + e.message, 4500); });
}
$('#btnNewGroup').onclick = function () {
  openPicker({ title: 'New group chat', sub: 'Choose members', withName: true, ok: 'Create group' }).then(function (r) {
    if (!r) return;
    var ref = db.collection('chats').doc(), names = {};
    var members = [S.uid].concat(r.uids);
    members.forEach(function (m) { names[m] = m === S.uid ? S.me.name : nameOf(m); });
    var d = { members: members, group: true, name: r.name, createdBy: S.uid, names: names, createdAt: TS(), lastT: Date.now(), lastText: S.me.name.split(' ')[0] + ' created the group', lastFrom: S.uid, reads: {} };
    ref.set(d).then(function () { CH.chats.set(ref.id, d); openChat(ref.id); }).catch(function (e) { toast(e.message, 4500); });
  });
};

function renderChatHeader(id) {
  var c = CH.chats.get(id); if (!c) return;
  $('#chatTitle').textContent = chatTitle(c);
  $('#chatAv').textContent = c.group ? '👥' : initials(chatTitle(c));
  if (c.group) {
    $('#chatSub').textContent = c.members.length + ' members · ' + c.members.filter(function (m) { return m !== S.uid; }).map(function (m) { return nameOf(m).split(' ')[0]; }).join(', ');
  } else {
    var other = S.staff.find(function (x) { return c.members.indexOf(x.id) >= 0 && x.id !== S.uid; });
    $('#chatSub').textContent = other ? ('Ext ' + other.ext + ' · ' + (isOnline(other) ? 'online' : 'offline')) : '';
  }
  $('#chatCall').innerHTML = c.group ? '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>' : ICON_CALL;
  $('#chatVideo').innerHTML = ICON_VID;
  $('#chatVideo').classList.toggle('hidden', !!c.group);
}
function openChat(id) {
  var c = CH.chats.get(id); if (!c) return;
  if (CH.unsub) { CH.unsub(); CH.unsub = null; }
  CH.open = id; CH.docs = [];
  renderChatHeader(id);
  $('#msgs').innerHTML = '<div class="empty">Loading…</div>';
  $('#chatv').classList.remove('hidden');
  var ref = db.collection('chats').doc(id);
  CH.unsub = ref.collection('messages').orderBy('t').limitToLast(300).onSnapshot(function (snap) {
    CH.docs = snap.docs.map(function (d) { var x = d.data(); x.id = d.id; return x; });
    renderMsgs(true);
    markRead(id);
  }, function (e) { $('#msgs').innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; });
  markRead(id);
}
function markRead(id) {
  var u = {}; u['reads.' + S.uid] = Date.now();
  db.collection('chats').doc(id).update(u).catch(function () {});
  var c = CH.chats.get(id); if (c) { c.reads = c.reads || {}; c.reads[S.uid] = Date.now(); renderChats(); }
}
function closeChat() { if (CH.unsub) { CH.unsub(); CH.unsub = null; } CH.open = null; $('#chatv').classList.add('hidden'); renderChats(); }
$('#chatBack').onclick = closeChat;
$('#chatCall').onclick = function () {
  var c = CH.chats.get(CH.open); if (!c) return;
  var others = c.members.filter(function (m) { return m !== S.uid; });
  if (c.group) return startGroupCall(others, c.name);
  var u = S.staff.find(function (x) { return x.id === others[0]; }); if (u) callInternal(u, false);
};
$('#chatVideo').onclick = function () {
  var c = CH.chats.get(CH.open); if (!c || c.group) return;
  var u = S.staff.find(function (x) { return c.members.indexOf(x.id) >= 0 && x.id !== S.uid; }); if (u) callInternal(u, true);
};

function renderMsgs(scroll) {
  var box = $('#msgs');
  var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  var c = CH.chats.get(CH.open) || {};
  var html = '', lastDay = '';
  CH.docs.forEach(function (m) {
    var day = new Date(m.t).toDateString();
    if (day !== lastDay) { lastDay = day; html += '<div class="day">' + esc(new Date(m.t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })) + '</div>'; }
    var me = m.from === S.uid;
    var who = (c.group && !me) ? '<div class="who">' + esc(m.name || nameOf(m.from)) + '</div>' : '';
    var tm = '<div class="tm">' + esc(new Date(m.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) + '</div>';
    var body = (m.file && (m.file.kind === 'voice' || m.file.kind === 'video'))
      ? '<div class="media" data-mid="' + esc(m.file.id) + '" data-kind="' + m.file.kind + '" data-mime="' + esc(m.file.mime || '') + '" data-dur="' + (m.file.dur || 0) + '"></div>'
      : m.file
      ? '<div class="file" data-fid="' + esc(m.file.id) + '" data-fname="' + esc(m.file.name) + '" data-fmime="' + esc(m.file.mime || '') + '"><div class="fi"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></div><div><b>' + esc(m.file.name) + '</b><span>' + fmtSize(m.file.size || 0) + ' · tap to open</span></div></div>' + (m.text ? '<div style="margin-top:6px">' + esc(m.text) + '</div>' : '')
      : esc(m.text);
    html += '<div class="bub' + (me ? ' me' : '') + '">' + who + body + tm + '</div>';
  });
  Object.keys(CH.pending).forEach(function (k) {
    var p = CH.pending[k]; if (p.chat !== CH.open) return;
    html += '<div class="bub me"><div class="file"><div class="fi"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></div><div><b>' + esc(p.name) + '</b><span>Sending… ' + p.pct + '%</span></div></div><div class="progress"><i style="width:' + p.pct + '%"></i></div></div>';
  });
  box.innerHTML = html || '<div class="empty">No messages yet. Say hello 👋</div>';
  hydrateMedia(box);
  if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function sendText() {
  var ta = $('#chatInput'), text = ta.value.trim(), id = CH.open;
  if (!text || !id) return;
  ta.value = ''; ta.style.height = '42px';
  var t = Date.now(), ref = db.collection('chats').doc(id);
  ref.collection('messages').add({ from: S.uid, name: S.me.name, text: text, t: t, at: TS() }).then(function () {
    var u = { lastText: text.slice(0, 140), lastT: t, lastFrom: S.uid }; u['reads.' + S.uid] = t;
    return ref.update(u);
  }).catch(function (e) { toast('Not sent: ' + e.message, 4500); ta.value = text; });
}
$('#chatSend').onclick = sendText;
$('#chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); sendText(); } });
$('#chatInput').addEventListener('input', function () { this.style.height = '42px'; this.style.height = Math.min(120, this.scrollHeight) + 'px'; });

/* ================= file transfer (stored in Firestore in 600 KB pieces) ================= */
$('#chatAttach').onclick = function () { $('#fileInput').value = ''; $('#fileInput').click(); };
$('#fileInput').onchange = function () { var f = this.files && this.files[0]; if (f) sendFile(f); };
function abToB64(buf) {
  var bytes = new Uint8Array(buf), s = '', step = 0x8000;
  for (var i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}
function sendFile(f, meta, toChat) {
  meta = meta || {};
  var chatId = toChat || CH.open, c = CH.chats.get(chatId); if (!c) return;
  if (f.size > MAX_FILE) return toast('Files up to 15 MB can be sent (this one is ' + fmtSize(f.size) + ')', 4500);
  var key = 'p' + Date.now(); CH.pending[key] = { chat: chatId, name: meta.kind ? mediaLabel(meta.kind) : f.name, pct: 0 }; renderMsgs(true);
  var fref = db.collection('files').doc(), n = Math.max(1, Math.ceil(f.size / CHUNK));
  var mime = f.type || 'application/octet-stream';
  fref.set({ name: f.name, size: f.size, mime: mime, chunks: n, owner: S.uid, members: c.members, chatId: chatId, t: Date.now(), done: false })
    .then(function () {
      var i = 0;
      function next() {
        if (i >= n) return Promise.resolve();
        var part = f.slice(i * CHUNK, Math.min(f.size, (i + 1) * CHUNK));
        return part.arrayBuffer().then(function (buf) {
          return fref.collection('chunks').doc(String(i).padStart(4, '0')).set({ i: i, d: abToB64(buf) });
        }).then(function () { i++; CH.pending[key].pct = Math.round(i / n * 100); if (CH.open === chatId) renderMsgs(false); return next(); });
      }
      return next();
    })
    .then(function () { return fref.update({ done: true }); })
    .then(function () {
      var t = Date.now(), ref = db.collection('chats').doc(chatId);
      return ref.collection('messages').add({ from: S.uid, name: S.me.name, text: '', file: Object.assign({ id: fref.id, name: f.name, size: f.size, mime: mime }, meta), t: t, at: TS() })
        .then(function () { var u = { lastText: meta.kind ? (meta.kind === 'voice' ? '🎤 ' : '🎥 ') + mediaLabel(meta.kind) : '📎 ' + f.name, lastT: t, lastFrom: S.uid }; u['reads.' + S.uid] = t; return ref.update(u); });
    })
    .then(function () { delete CH.pending[key]; if (CH.open === chatId) renderMsgs(true); })
    .catch(function (e) { delete CH.pending[key]; renderMsgs(false); toast('File not sent: ' + e.message, 5000); });
}
$('#msgs').addEventListener('click', function (e) {
  var el = e.target.closest('[data-fid]'); if (!el) return;
  openFile(el.dataset.fid, el.dataset.fname, el.dataset.fmime || 'application/octet-stream');
});
var opening = {};
function openFile(fid, name, mime) {
  if (opening[fid]) return; opening[fid] = true;
  toast('Downloading ' + name + '…', 6000);
  db.collection('files').doc(fid).collection('chunks').get().then(function (snap) {
    var parts = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return a.i - b.i; });
    if (!parts.length) throw new Error('file is empty or still uploading');
    if (RPN) {
      var tmp = fid, k = 0;
      var chain = Promise.resolve();
      parts.forEach(function (p, idx) { chain = chain.then(function () { return RPN.fileChunk({ id: tmp, data: p.d, first: idx === 0 }); }); });
      return chain.then(function () { return RPN.fileFinish({ id: tmp, name: name, mime: mime }); })
        .then(function (r) { toast('Saved to ' + r.where, 3500); return RPN.openFile({ uri: r.uri, mime: mime }).catch(function (e) { toast(e.message || 'Saved — open it from Downloads', 4000); }); });
    }
    var blobs = parts.map(function (p) { var bin = atob(p.d), arr = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j); return arr; });
    var url = URL.createObjectURL(new Blob(blobs, { type: mime }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (/^image\//.test(mime)) window.open(url, '_blank');
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }).catch(function (e) { toast('Could not open file: ' + e.message, 5000); })
    .then(function () { delete opening[fid]; });
}

/* ================= voice & video messages ================= */
var MEDIA = {}, MEDIA_LOADING = {}, REC = null, COMPOSER = $('#chatSend').parentNode;
var VOICE_MAX = 300, VIDEO_MAX = 60;
function mediaLabel(kind) { return kind === 'voice' ? 'Voice message' : 'Video message'; }
function fmtSec(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
function pickMime(video) {
  if (!window.MediaRecorder) return null;
  var list = video ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (var i = 0; i < list.length; i++) { try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {} }
  return '';
}
function extOf(mime) { return /mp4/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : 'webm'; }
function b64ToArr(b64) { var bin = atob(b64), arr = new Uint8Array(bin.length); for (var j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j); return arr; }

(function addMediaUI() {
  var css = document.createElement('style');
  css.textContent = [
    '.bub .media{min-width:200px}',
    '.mplay{display:flex;align-items:center;gap:10px;cursor:pointer;padding:2px 0}',
    '.mplay .pb{width:38px;height:38px;border-radius:50%;background:var(--red);color:#fff;display:grid;place-items:center;flex:none}',
    '.mplay .pb svg{width:18px;height:18px;fill:currentColor;stroke:none;margin-left:2px}',
    '.mplay b{display:block;font-size:13.5px}.mplay span{font-size:12px;color:var(--ink-3)}',
    '.mplay.vid{flex-direction:column;align-items:stretch;gap:6px}',
    '.mplay.vid .vbox{width:220px;max-width:100%;height:140px;border-radius:10px;background:#1E1A1A;display:grid;place-items:center}',
    '.bub audio{width:250px;max-width:100%;display:block;height:40px}',
    '.bub video.vm{width:250px;max-width:100%;max-height:340px;border-radius:10px;display:block;background:#000}',
    '#recBar{display:flex;align-items:center;gap:10px;padding:8px 10px calc(8px + var(--safe-b));background:var(--card);border-top:1px solid var(--line)}',
    '#recBar .rdot{width:12px;height:12px;border-radius:50%;background:var(--red);animation:rpblink 1s infinite;flex:none}',
    '#recBar .rt{font-weight:700;font-variant-numeric:tabular-nums}',
    '#recBar .rl{flex:1;font-size:13px;color:var(--ink-3)}',
    '@keyframes rpblink{50%{opacity:.2}}',
    '#vrec{position:fixed;inset:0;z-index:60;background:#000;display:flex;flex-direction:column}',
    '#vrec video{flex:1;width:100%;min-height:0;object-fit:contain;background:#000}',
    '#vrec .vbar{display:flex;align-items:center;justify-content:space-around;padding:16px 10px calc(16px + var(--safe-b));background:#111}',
    '#vrec .vbar button{color:#fff;font-weight:600;padding:10px 14px;border-radius:22px;background:#ffffff26;min-width:90px}',
    '#vrec .vbar button.go{background:var(--green)}',
    '#vrec .vrbtn{width:66px;height:66px;min-width:0!important;border-radius:50%!important;background:#fff!important;display:grid;place-items:center;padding:0!important}',
    '#vrec .vrbtn i{display:block;width:28px;height:28px;border-radius:50%;background:var(--red);transition:all .2s}',
    '#vrec .vrbtn.on i{border-radius:6px;width:22px;height:22px}',
    '#vrec .vtime{position:absolute;top:calc(14px + env(safe-area-inset-top));left:12px;right:12px;text-align:center;color:#fff;font-weight:700;text-shadow:0 1px 4px #000;z-index:2}'
  ].join('\n');
  document.head.appendChild(css);
  var send = $('#chatSend');
  function mk(id, label, svg) {
    var b = document.createElement('button'); b.className = 'ib'; b.id = id; b.title = label; b.setAttribute('aria-label', label);
    b.style.cssText = 'background:none;color:var(--ink-2)'; b.innerHTML = svg; COMPOSER.insertBefore(b, send); return b;
  }
  mk('chatVidMsg', 'Record a video message', '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>').onclick = startVideoMsg;
  mk('chatMic', 'Record a voice message', '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></svg>').onclick = startVoice;
  var bar = document.createElement('div'); bar.id = 'recBar'; bar.className = 'hidden';
  bar.innerHTML = '<button class="ib" id="recCancel" aria-label="Delete recording" title="Delete" style="background:none;color:var(--ink-2)"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/></svg></button>' +
    '<span class="rdot"></span><span class="rt" id="recTime">0:00</span><span class="rl">Recording voice message…</span>' +
    '<button class="ib g" id="recSend" aria-label="Send voice message" title="Send"><svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg></button>';
  COMPOSER.parentNode.insertBefore(bar, COMPOSER.nextSibling);
  $('#recCancel').onclick = function () { stopVoice(false); };
  $('#recSend').onclick = function () { stopVoice(true); };
  $('#chatInput').addEventListener('input', toggleMediaBtns);
  $('#chatInput').addEventListener('keydown', function () { setTimeout(toggleMediaBtns, 0); });
  send.addEventListener('click', function () { setTimeout(toggleMediaBtns, 0); });
  $('#chatBack').addEventListener('click', function () {
    if (REC && REC.kind === 'voice') stopVoice(false);
    Object.keys(MEDIA).forEach(function (k) { var m = MEDIA[k].firstChild; if (m && m.pause) m.pause(); });
  });
  // only one voice/video message plays at a time
  document.addEventListener('play', function (e) {
    Object.keys(MEDIA).forEach(function (k) { var m = MEDIA[k].firstChild; if (m && m !== e.target && m.pause) m.pause(); });
  }, true);
})();
function toggleMediaBtns() { var has = !!$('#chatInput').value.trim(); $('#chatMic').classList.toggle('hidden', has); $('#chatVidMsg').classList.toggle('hidden', has); }

function mediaErr(e, what) { toast(e && e.name === 'NotAllowedError' ? 'Allow ' + what + ' access to record messages' : 'Could not record: ' + ((e && e.message) || e), 4500); }

/* --- voice --- */
function startVoice() {
  if (REC || !CH.open) return;
  if (S.call) return toast('Finish the call first');
  var mime = pickMime(false);
  if (mime === null) return toast('This device cannot record voice messages');
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (st) {
    if (REC) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
    var opts = { audioBitsPerSecond: 48000 }; if (mime) opts.mimeType = mime;
    var mr = new MediaRecorder(st, opts);
    var r = REC = { kind: 'voice', mr: mr, stream: st, chunks: [], t0: Date.now(), chat: CH.open };
    mr.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.start(1000);
    COMPOSER.classList.add('hidden'); $('#recBar').classList.remove('hidden'); $('#recTime').textContent = '0:00';
    r.timer = setInterval(function () { var s = (Date.now() - r.t0) / 1000; $('#recTime').textContent = fmtSec(s); if (s >= VOICE_MAX) stopVoice(true); }, 250);
  }).catch(function (e) { mediaErr(e, 'microphone'); });
}
function stopVoice(send) {
  var r = REC; if (!r || r.kind !== 'voice') return; REC = null;
  clearInterval(r.timer);
  $('#recBar').classList.add('hidden'); COMPOSER.classList.remove('hidden');
  var dur = (Date.now() - r.t0) / 1000;
  r.mr.onstop = function () {
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    if (!send) return;
    if (dur < 1 || !r.chunks.length) return toast('Too short — tap the mic, speak, then tap send');
    var type = String(r.mr.mimeType || (r.chunks[0] && r.chunks[0].type) || 'audio/webm').split(';')[0] || 'audio/webm';
    sendMediaBlob(r.chat, new Blob(r.chunks, { type: type }), 'voice', dur);
  };
  try { r.mr.stop(); } catch (e) { r.mr.onstop(); }
}

/* --- video --- */
function startVideoMsg() {
  if (REC || !CH.open) return;
  if (S.call) return toast('Finish the call first');
  var mime = pickMime(true);
  if (mime === null) return toast('This device cannot record video messages');
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
  }).then(function (st) {
    if (REC) { st.getTracks().forEach(function (t) { t.stop(); }); return; }
    var r = REC = { kind: 'video', stream: st, chunks: [], chat: CH.open, mime: mime, blob: null };
    var ov = document.createElement('div'); ov.id = 'vrec';
    ov.innerHTML = '<div class="vtime" id="vrTime">Tap the red button to record (up to 1 minute)</div>' +
      '<video id="vrView" autoplay muted playsinline></video>' +
      '<div class="vbar"><button id="vrCancel">Cancel</button><button class="vrbtn" id="vrBtn" aria-label="Record"><i></i></button><button id="vrSend" class="go" style="visibility:hidden">Send</button></div>';
    document.body.appendChild(ov);
    var v = $('#vrView'); v.srcObject = st; v.style.transform = 'scaleX(-1)'; v.play().catch(function () {});
    $('#vrCancel').onclick = closeVideoMsg;
    $('#vrBtn').onclick = function () { if (r.mr && r.mr.state === 'recording') stopVideoRec(r); else if (!r.mr) startVideoRec(r); };
    $('#vrSend').onclick = function () {
      if (!r.blob) return;
      if (r.dur < 1) return toast('Too short — record a little longer');
      sendMediaBlob(r.chat, r.blob, 'video', r.dur); closeVideoMsg();
    };
  }).catch(function (e) { mediaErr(e, 'camera and microphone'); });
}
function startVideoRec(r) {
  var opts = { videoBitsPerSecond: 900000, audioBitsPerSecond: 48000 }; if (r.mime) opts.mimeType = r.mime;
  var mr = r.mr = new MediaRecorder(r.stream, opts);
  mr.ondataavailable = function (e) { if (e.data && e.data.size) r.chunks.push(e.data); };
  mr.onstop = function () {
    if (REC !== r) return;
    r.dur = (Date.now() - r.t0) / 1000;
    var type = String(mr.mimeType || r.mime || 'video/webm').split(';')[0] || 'video/webm';
    r.blob = new Blob(r.chunks, { type: type });
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    var v = $('#vrView'); if (!v) return;
    v.srcObject = null; v.style.transform = 'none'; v.muted = false; v.loop = true; v.controls = true;
    v.src = r.url = URL.createObjectURL(r.blob); fixDuration(v, true);
    $('#vrBtn').style.visibility = 'hidden'; $('#vrSend').style.visibility = 'visible';
    $('#vrTime').textContent = 'Preview · ' + fmtSec(r.dur) + ' — tap Send';
  };
  r.t0 = Date.now(); mr.start(1000); $('#vrBtn').classList.add('on');
  r.timer = setInterval(function () { var s = (Date.now() - r.t0) / 1000; $('#vrTime').textContent = '● Recording ' + fmtSec(s) + ' / 1:00'; if (s >= VIDEO_MAX) stopVideoRec(r); }, 250);
}
function stopVideoRec(r) { clearInterval(r.timer); $('#vrBtn').classList.remove('on'); try { r.mr.stop(); } catch (e) {} }
function closeVideoMsg() {
  var r = REC;
  if (r && r.kind === 'video') {
    REC = null; clearInterval(r.timer);
    try { if (r.mr && r.mr.state === 'recording') r.mr.stop(); } catch (e) {}
    r.stream.getTracks().forEach(function (t) { t.stop(); });
    if (r.url) setTimeout(function () { URL.revokeObjectURL(r.url); }, 1000);
  }
  var ov = $('#vrec'); if (ov) { var v = ov.querySelector('video'); if (v) v.pause(); ov.remove(); }
}

/* --- sending & playing --- */
function sendMediaBlob(chatId, blob, kind, dur) {
  var mime = blob.type || (kind === 'voice' ? 'audio/webm' : 'video/webm');
  var stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  var f = new File([blob], mediaLabel(kind) + ' ' + stamp + '.' + extOf(mime), { type: mime });
  sendFile(f, { kind: kind, dur: Math.max(1, Math.round(dur)) }, chatId);
}
// Recorded WebM files often don't say how long they are; this makes the progress bar work.
function fixDuration(el, autoplay) {
  el.addEventListener('loadedmetadata', function () {
    if (el.duration === Infinity || isNaN(el.duration)) {
      el.currentTime = 1e101;
      el.addEventListener('timeupdate', function f() { el.removeEventListener('timeupdate', f); el.currentTime = 0; if (autoplay) el.play().catch(function () {}); });
    } else if (autoplay) el.play().catch(function () {});
  });
}
function hydrateMedia(box) {
  box.querySelectorAll('.media[data-mid]').forEach(function (ph) {
    var id = ph.dataset.mid;
    if (MEDIA[id]) { ph.appendChild(MEDIA[id]); return; }
    var kind = ph.dataset.kind, dur = +ph.dataset.dur || 0, busy = MEDIA_LOADING[id];
    var play = '<span class="pb"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>';
    ph.innerHTML = kind === 'video'
      ? '<div class="mplay vid"><div class="vbox">' + play + '</div><span>🎥 Video message · ' + fmtSec(dur) + (busy ? ' · loading…' : '') + '</span></div>'
      : '<div class="mplay">' + play + '<div><b>🎤 Voice message</b><span>' + fmtSec(dur) + (busy ? ' · loading…' : ' · tap to play') + '</span></div></div>';
  });
}
$('#msgs').addEventListener('click', function (e) {
  var ph = e.target.closest('.media[data-mid]'); if (!ph || MEDIA[ph.dataset.mid]) return;
  loadMedia(ph.dataset.mid, ph.dataset.kind, ph.dataset.mime);
});
function loadMedia(id, kind, mime) {
  if (MEDIA_LOADING[id]) return;
  MEDIA_LOADING[id] = true; renderMsgs(false);
  db.collection('files').doc(id).collection('chunks').get().then(function (snap) {
    var parts = snap.docs.map(function (d) { return d.data(); }).sort(function (a, b) { return a.i - b.i; });
    if (!parts.length) throw new Error('it is still being sent');
    var url = URL.createObjectURL(new Blob(parts.map(function (p) { return b64ToArr(p.d); }), { type: mime || (kind === 'voice' ? 'audio/webm' : 'video/webm') }));
    var el = document.createElement(kind === 'video' ? 'video' : 'audio');
    el.controls = true; el.preload = 'auto'; el.setAttribute('playsinline', '');
    if (kind === 'video') el.className = 'vm';
    fixDuration(el, true); el.src = url;
    var wrap = document.createElement('div'); wrap.appendChild(el);
    MEDIA[id] = wrap; delete MEDIA_LOADING[id];
    var ph = document.querySelector('.media[data-mid="' + id + '"]'); if (ph) { ph.innerHTML = ''; ph.appendChild(wrap); }
  }).catch(function (e) { delete MEDIA_LOADING[id]; renderMsgs(false); toast('Could not play: ' + e.message, 4500); });
}

/* ================= group calls (everyone connects to everyone, audio) ================= */
var G = null;
$('#btnGroupCall').onclick = function () {
  if (S.call) return toast('You are already on a call');
  openPicker({ title: 'Group call', sub: 'Choose who to call (up to 7)', withName: false, ok: 'Call' }).then(function (r) {
    if (!r) return;
    if (r.uids.length > 7) return toast('Choose up to 7 people for a group call');
    startGroupCall(r.uids, '');
  });
};
function startGroupCall(uids, name) {
  if (S.call) return toast('You are already on a call');
  uids = uids.slice(0, 7);
  if (!name) name = [S.me.name.split(' ')[0]].concat(uids.map(function (u) { return nameOf(u).split(' ')[0]; })).join(', ');
  unlockAudio();
  getMedia(false).then(function (stream) {
    var ref = db.collection('rooms').doc();
    var members = [S.uid].concat(uids);
    return ref.set({ name: name, createdBy: S.uid, members: members, active: true, t: Date.now(), createdAt: TS() }).then(function () {
      sendInvites(ref.id, uids, name, members.length);
      joinRoom(ref.id, name, stream, 'out');
    });
  }).catch(function (e) { toast(e && e.name === 'NotAllowedError' ? 'Allow microphone access to make calls' : 'Could not start: ' + (e.message || e), 4500); });
}
function sendInvites(roomId, uids, name, count) {
  uids.forEach(function (u) {
    db.collection('users').doc(u).collection('invites').doc(roomId).set({ roomId: roomId, from: S.uid, fromName: S.me.name, name: name, count: count, t: Date.now() }).catch(function () {});
  });
}
function joinRoom(roomId, name, stream, dir) {
  var p = stream ? Promise.resolve(stream) : getMedia(false);
  p.then(function (st) {
    var ref = db.collection('rooms').doc(roomId);
    G = { kind: 'group', status: 'active', dir: dir || 'in', roomId: roomId, ref: ref, name: name, stream: st, peers: new Map(), preQ: {}, joinedAt: Date.now(), unsubs: [], parts: {}, startedAt: null, everPeer: false };
    S.call = G;
    $('#gTitle').textContent = name || 'Group call';
    $('#gSub').textContent = 'Connecting…';
    $('#gMute').classList.remove('on');
    $('#gcall').classList.remove('hidden');
    nat('callActive', { on: true });
    ref.collection('participants').doc(S.uid).set({ name: S.me.name, ext: S.me.ext, joinedAt: G.joinedAt, left: false });
    G.unsubs.push(ref.collection('participants').onSnapshot(function (snap) {
      if (!G || G.roomId !== roomId) return;
      snap.docs.forEach(function (d) {
        var uid = d.id, x = d.data(); G.parts[uid] = x;
        if (uid === S.uid) return;
        if (x.left) { closePeer(uid); return; }
        if (!G.peers.has(uid)) {
          var iStart = x.joinedAt < G.joinedAt || (x.joinedAt === G.joinedAt && uid < S.uid);
          if (iStart) createPeer(uid, true);
        }
      });
      renderTiles();
    }));
    G.unsubs.push(ref.collection('signals').where('to', '==', S.uid).onSnapshot(function (snap) {
      snap.docChanges().forEach(function (ch) {
        if (ch.type !== 'added') return;
        var s = ch.doc.data();
        ch.doc.ref.delete().catch(function () {});
        if (!G || G.roomId !== roomId || (s.t || 0) < G.joinedAt - 3000) return;
        handleSignal(s);
      });
    }));
    G.timer = setInterval(function () {
      if (!G) return;
      var live = Array.from(G.peers.values()).filter(function (pp) { return pp.state === 'connected'; }).length;
      if (live && !G.startedAt) G.startedAt = Date.now();
      $('#gSub').textContent = live ? (live + 1) + ' on call · ' + fmtDur((Date.now() - G.startedAt) / 1000) : (G.everPeer ? 'Everyone else has left' : 'Ringing colleagues…');
      levelTick();
    }, 500);
    renderTiles();
  }).catch(function (e) { toast(e && e.name === 'NotAllowedError' ? 'Allow microphone access to join' : 'Could not join: ' + (e.message || e), 4500); });
}
function sendSignal(to, type, data) {
  if (!G) return;
  G.ref.collection('signals').add({ from: S.uid, to: to, type: type, data: JSON.stringify(data), t: Date.now() }).catch(function () {});
}
function createPeer(uid, initiator) {
  var pc = new RTCPeerConnection({ iceServers: iceServers() });
  var audio = document.createElement('audio'); audio.autoplay = true; audio.setAttribute('playsinline', ''); $('#gAudio').appendChild(audio);
  var peer = { uid: uid, pc: pc, q: (G.preQ[uid] || []), audio: audio, state: 'connecting', level: 0, an: null };
  delete G.preQ[uid];
  G.peers.set(uid, peer); G.everPeer = true;
  G.stream.getTracks().forEach(function (t) { pc.addTrack(t, G.stream); });
  pc.onicecandidate = function (e) { if (e.candidate) sendSignal(uid, 'candidate', e.candidate.toJSON()); };
  pc.ontrack = function (e) {
    var st = e.streams[0] || new MediaStream([e.track]);
    audio.srcObject = st; audio.play().catch(function () {});
    try { var ctx = getCtx(); var src = ctx.createMediaStreamSource(st); var an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an); peer.an = an; } catch (er) {}
  };
  pc.onconnectionstatechange = function () {
    peer.state = pc.connectionState === 'connected' ? 'connected' : pc.connectionState === 'failed' ? 'failed' : pc.connectionState === 'disconnected' ? 'reconnecting' : peer.state;
    renderTiles();
  };
  if (initiator) {
    pc.createOffer().then(function (o) { return pc.setLocalDescription(o).then(function () { sendSignal(uid, 'offer', { type: o.type, sdp: o.sdp }); }); }).catch(function () {});
  }
  renderTiles();
  return peer;
}
function flushQ(peer) { peer.q.forEach(function (c) { peer.pc.addIceCandidate(c).catch(function () {}); }); peer.q = []; }
function handleSignal(s) {
  var data; try { data = JSON.parse(s.data); } catch (e) { return; }
  var peer = G.peers.get(s.from);
  if (s.type === 'offer') {
    if (!peer) peer = createPeer(s.from, false);
    var pc = peer.pc;
    pc.setRemoteDescription(data).then(function () { flushQ(peer); return pc.createAnswer(); })
      .then(function (a) { return pc.setLocalDescription(a).then(function () { sendSignal(s.from, 'answer', { type: a.type, sdp: a.sdp }); }); })
      .catch(function () {});
  } else if (s.type === 'answer') {
    if (peer && !peer.pc.currentRemoteDescription) peer.pc.setRemoteDescription(data).then(function () { flushQ(peer); }).catch(function () {});
  } else if (s.type === 'candidate') {
    var cand = new RTCIceCandidate(data);
    if (peer && peer.pc.remoteDescription) peer.pc.addIceCandidate(cand).catch(function () {});
    else if (peer) peer.q.push(cand);
    else (G.preQ[s.from] = G.preQ[s.from] || []).push(cand);
  }
}
function closePeer(uid) {
  var p = G && G.peers.get(uid); if (!p) return;
  try { p.pc.close(); } catch (e) {}
  if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
  G.peers.delete(uid);
  renderTiles();
}
function renderTiles() {
  if (!G) return;
  var tiles = ['<div class="tile" data-t="me"><div class="av2">' + esc(initials(S.me.name)) + '</div><b>You</b><span>' + (G.muted ? 'muted' : 'on call') + '</span></div>'];
  Object.keys(G.parts).forEach(function (uid) {
    var x = G.parts[uid]; if (uid === S.uid || x.left) return;
    var p = G.peers.get(uid);
    var st = p ? ({ connected: 'connected', failed: 'connection failed', reconnecting: 'reconnecting…' }[p.state] || 'connecting…') : 'joining…';
    tiles.push('<div class="tile" data-t="' + uid + '"><div class="av2">' + esc(initials(x.name)) + '</div><b>' + esc(x.name) + '</b><span>' + st + '</span></div>');
  });
  $('#gTiles').innerHTML = tiles.join('');
}
function levelTick() {
  if (!G) return;
  G.peers.forEach(function (p, uid) {
    if (!p.an) return;
    var buf = new Uint8Array(p.an.fftSize); p.an.getByteTimeDomainData(buf);
    var peak = 0; for (var i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    var el = document.querySelector('.tile[data-t="' + uid + '"]'); if (el) el.classList.toggle('talk', peak > 10);
  });
}
function leaveGroup() {
  if (!G) return;
  var g = G; G = null;
  clearInterval(g.timer);
  g.unsubs.forEach(function (u) { try { u(); } catch (e) {} });
  g.peers.forEach(function (p) { try { p.pc.close(); } catch (e) {} if (p.audio) p.audio.remove(); });
  g.stream.getTracks().forEach(function (t) { t.stop(); });
  g.ref.collection('participants').doc(S.uid).set({ name: S.me.name, ext: S.me.ext, joinedAt: g.joinedAt, left: true }).catch(function () {});
  var others = Object.keys(g.parts).filter(function (u) { return u !== S.uid && !g.parts[u].left; });
  if (!others.length) g.ref.update({ active: false }).catch(function () {});
  addLog({ kind: 'group', dir: g.dir, name: g.name || 'Group call', number: '', result: g.startedAt ? 'answered' : 'no-answer', dur: g.startedAt ? (Date.now() - g.startedAt) / 1000 : 0 });
  if (S.call === g) S.call = null;
  $('#gcall').classList.add('hidden');
  playTone('end');
  nat('callActive', { on: false });
}
$('#gLeave').onclick = leaveGroup;
$('#gMute').onclick = function () {
  if (!G) return; G.muted = !G.muted;
  G.stream.getAudioTracks().forEach(function (t) { t.enabled = !G.muted; });
  $('#gMute').classList.toggle('on', G.muted); renderTiles();
};
$('#gAdd').onclick = function () {
  if (!G) return;
  var g = G;
  var current = Object.keys(g.parts);
  openPicker({ title: 'Add to call', sub: g.name, ok: 'Add', exclude: current }).then(function (r) {
    if (!r || !G || G !== g) return;
    g.ref.update({ members: firebase.firestore.FieldValue.arrayUnion.apply(null, r.uids) }).then(function () {
      sendInvites(g.roomId, r.uids, g.name, current.length + r.uids.length);
      toast('Calling ' + r.uids.map(function (u) { return nameOf(u).split(' ')[0]; }).join(', '));
    }).catch(function (e) { toast(e.message, 4000); });
  });
};

/* incoming group-call invitations */
function listenInvites() {
  db.collection('users').doc(S.uid).collection('invites').onSnapshot(function (snap) {
    snap.docChanges().forEach(function (ch) {
      if (ch.type !== 'added') return;
      var d = ch.doc.data(), ref = ch.doc.ref;
      if (Date.now() - (d.t || 0) > 60000) { ref.delete().catch(function () {}); return; }
      if (S.call) { ref.delete().catch(function () {}); addLog({ kind: 'group', dir: 'in', name: d.name || d.fromName, number: '', result: 'missed' }); return; }
      var c = { kind: 'groupInvite', status: 'incoming', dir: 'in', name: d.fromName, number: '', invite: d, ref: ref };
      S.call = c;
      openCallUI(c, 'Incoming group call');
      $('#callSub').textContent = 'Group call · ' + (d.count || 2) + ' people · ' + (d.name || '');
      playTone('ring');
      nativeRing(d.fromName, 'Group call · ' + (d.count || 2) + ' people');
      c.timeout = setTimeout(function () { if (S.call === c) declineInvite(c, 'missed'); }, 45000);
    });
  }, function () {});
}
function acceptInvite(c) {
  clearTimeout(c.timeout); stopTone(); nat('cancelIncoming');
  c.ref.delete().catch(function () {});
  $('#call').classList.add('hidden');
  S.call = null;
  joinRoom(c.invite.roomId, c.invite.name, null, 'in');
}
function declineInvite(c, result) {
  clearTimeout(c.timeout); stopTone(); nat('cancelIncoming'); nat('callActive', { on: false });
  c.ref.delete().catch(function () {});
  addLog({ kind: 'group', dir: 'in', name: c.invite.name || c.name, number: '', result: result });
  if (S.call === c) S.call = null;
  $('#callStatus').textContent = result === 'missed' ? 'Missed group call' : 'Declined';
  setTimeout(function () { if (!S.call) $('#call').classList.add('hidden'); }, 900);
}
