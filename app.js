'use strict';

const APP_VERSION = '1.14.0';
const PAGE_SIZE = 20;

// Your own Cloudflare Worker proxy (see cloudflare-worker.js for setup).
// Leave empty to fall back to the free public proxies only.
const PROXY_WORKER_URL = 'https://morning-rice-8af9.sungchoi.workers.dev/';

// ── STATE ─────────────────────────────────────────────────────
const S = {
  user: null,
  folders: [], feeds: [],
  settings: { apiKey: '', globalFilter: '', filterAction: 'mark', model: 'claude-haiku-4-5-20251001' },
  articles: {}, decisions: {}, read: new Set(),
  currentFeed: 'all', editingFeedId: null, editingFolderId: null,
  currentArticles: [], displayedCount: 0, scrollObserver: null, focusedIndex: -1
};

const collapsed = new Set(JSON.parse(localStorage.getItem('rss.collapsed') || '[]'));
const saveCollapsed = () => localStorage.setItem('rss.collapsed', JSON.stringify([...collapsed]));

// Layout used for MIXED views (All Items, folders). Single feeds use their own layout.
let S_viewLayout = localStorage.getItem('rss.viewLayout') || 'list';
function setViewLayout(v) {
  S_viewLayout = v;
  localStorage.setItem('rss.viewLayout', v);
  renderArticles();
}
function isSingleFeedView() {
  return S.currentFeed !== 'all' && !S.currentFeed.startsWith('folder:');
}

let centralAuth, centralDb, userDb;

// ── FIREBASE ─────────────────────────────────────────────────
let ADMIN_EMAIL = null; // loaded from Firebase at runtime — set config/adminEmail in your DB

const CENTRAL_CONFIG = {
  apiKey: "AIzaSyAPEu6PjPCk7fQyomMKzfZfmhnaktz0Tn0",
  authDomain: "fir-reader-5f8bc.firebaseapp.com",
  databaseURL: "https://fir-reader-5f8bc-default-rtdb.firebaseio.com",
  projectId: "fir-reader-5f8bc",
  storageBucket: "fir-reader-5f8bc.firebasestorage.app",
  messagingSenderId: "312335782484",
  appId: "1:312335782484:web:b2edbdff2e90b5de7153c1",
  measurementId: "G-BFCCRH5ZS7"
};

// ── SCREEN MANAGEMENT ─────────────────────────────────────────
const SCREENS = ['screen-signin','screen-request','screen-pending','screen-rejected','app'];

function showScreen(id) {
  SCREENS.forEach(s => document.getElementById(s)?.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

// ── INIT ──────────────────────────────────────────────────────
async function initFirebase() {
  try {
    const centralApp = firebase.apps.length
      ? firebase.apps[0]
      : firebase.initializeApp(CENTRAL_CONFIG);
    centralAuth = firebase.auth(centralApp);
    centralDb   = firebase.database(centralApp);

    // Fetch admin email from DB so it's never in source code
    try {
      const configSnap = await centralDb.ref('config/adminEmail').once('value');
      ADMIN_EMAIL = configSnap.val();
      if (!ADMIN_EMAIL) {
        console.error(
          'config/adminEmail is missing or empty in the database.\n' +
          'Admin features will be unavailable and the admin will be treated as a normal user.\n' +
          'Fix: Firebase Console -> Realtime Database -> Data -> add config/adminEmail = "your@email.com"'
        );
      } else {
        console.log('Admin email loaded:', ADMIN_EMAIL);
      }
    } catch (e) {
      console.error(
        'Could not read config/adminEmail — check that your security rules allow public read on "config".\n',
        e
      );
    }

    centralAuth.onAuthStateChanged(async user => {
      if (user) {
        S.user = user;
        document.getElementById('user-email').textContent = user.email || user.displayName || 'Signed in';
        console.log('Signed in as:', user.email, '| admin match:', user.email === ADMIN_EMAIL);
        if (user.email === ADMIN_EMAIL) document.getElementById('btn-admin').style.display = '';
        recordAnalytics(user);
        await checkApprovalStatus(user);
      } else {
        S.user = null;
        showScreen('screen-signin');
      }
    });
  } catch(e) { toast('Firebase error: ' + e.message); }
}

// ── APPROVAL FLOW ─────────────────────────────────────────────
async function checkApprovalStatus(user) {
  // Admin skips approval and config — uses central Firebase directly
  if (user.email === ADMIN_EMAIL) {
    await initUserFirebase();
    return;
  }

  try {
    const snap = await centralDb.ref(`approvals/${user.uid}`).once('value');
    const approval = snap.val();

    if (!approval) {
      // Pre-fill name from Google account
      document.getElementById('req-name').value = user.displayName || '';
      showScreen('screen-request');
    } else if (approval.status === 'pending') {
      showScreen('screen-pending');
    } else if (approval.status === 'rejected') {
      document.getElementById('rejected-reason').textContent = approval.rejectReason || '';
      showScreen('screen-rejected');
    } else if (approval.status === 'approved') {
      // All approved users share the central database, isolated by the
      // users/{uid} security rules.
      await initUserFirebase();
    }
  } catch(e) {
    toast('Error checking approval: ' + e.message);
  }
}

async function submitAccessRequest() {
  const name   = document.getElementById('req-name').value.trim();
  const reason = document.getElementById('req-reason').value.trim();
  if (!name)              { toast('Please enter your name'); return; }
  if (reason.length < 10) { toast('Please write at least a sentence about why you want access'); return; }

  const btn = document.getElementById('btn-submit-request');
  btn.disabled = true; btn.textContent = 'Submitting…';

  try {
    await centralDb.ref(`approvals/${S.user.uid}`).set({
      email:       S.user.email || '',
      name,
      displayName: S.user.displayName || '',
      photoURL:    S.user.photoURL   || '',
      reason,
      requestedAt: Date.now(),
      status:      'pending'
    });
    showScreen('screen-pending');
  } catch(e) {
    toast('Error submitting request: ' + e.message);
    btn.disabled = false; btn.textContent = 'Submit Request';
  }
}

// All users share the central database. Their data is isolated under
// users/{uid} and enforced by the security rules — a second Firebase app is
// never created, so the connection always carries the signed-in auth session.
async function initUserFirebase() {
  try {
    userDb = centralDb;
    showScreen('app');
    await loadFromFirebase();
    startAutoRefresh();
  } catch(e) {
    console.error('Failed to load user data:', e);
    toast('Could not load your data: ' + e.message);
  }
}

// ── ANALYTICS ─────────────────────────────────────────────────
async function recordAnalytics(user) {
  try {
    const ref = centralDb.ref(`analytics/${user.uid}`);
    const snap = await ref.once('value');
    const prev = snap.val() || {};
    let location = prev.location || null;
    if (!location) {
      try {
        const geo = await fetch('https://ipapi.co/json/');
        if (geo.ok) {
          const g = await geo.json();
          location = { city: g.city || '', region: g.region || '', country: g.country_name || '', ip: g.ip || '' };
        }
      } catch(_) {}
    }
    await ref.set({
      email:      user.email || '',
      name:       user.displayName || '',
      photoURL:   user.photoURL || '',
      firstSeen:  prev.firstSeen || Date.now(),
      lastSeen:   Date.now(),
      visitCount: (prev.visitCount || 0) + 1,
      location:   location || {}
    });
  } catch(_) {}
}

// ── ADMIN PANEL ───────────────────────────────────────────────
async function openAdminPanel() {
  toggleUserMenu();
  openOverlay('overlay-admin');
  switchAdminTab('pending');
}

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('admin-panel-pending').style.display  = tab === 'pending'  ? '' : 'none';
  document.getElementById('admin-panel-visitors').style.display = tab === 'visitors' ? '' : 'none';
  if (tab === 'pending')  loadPendingRequests();
  if (tab === 'visitors') loadVisitorStats();
}

async function loadPendingRequests() {
  const tbody = document.getElementById('admin-pending-body');
  tbody.innerHTML = '<tr><td colspan="4" style="color:#555;text-align:center;padding:24px">Loading…</td></tr>';
  try {
    const snap = await centralDb.ref('approvals').once('value');
    const data = snap.val() || {};
    const all  = Object.entries(data).sort((a, b) => (b[1].requestedAt||0) - (a[1].requestedAt||0));
    if (!all.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="color:#555;text-align:center;padding:24px">No requests yet</td></tr>';
      return;
    }
    tbody.innerHTML = all.map(([uid, r]) => {
      const avatar = r.photoURL ? `<img class="admin-avatar" src="${esc(r.photoURL)}" onerror="this.remove()">` : '';
      const badge = { pending:'<span style="color:#b08830">⏳ Pending</span>', approved:'<span style="color:#4a8a4a">✓ Approved</span>', rejected:'<span style="color:#c06060">✗ Rejected</span>' }[r.status] || r.status;
      const actions = r.status === 'pending'
        ? `<button class="btn" style="font-size:11px;padding:3px 8px;color:#4a8a4a;border-color:#2a4a2a;background:#1a2a1a" onclick="approveUser('${uid}')">Approve</button>
           <button class="btn" style="font-size:11px;padding:3px 8px;color:#c06060;border-color:#4a2020;background:#2a1010;margin-left:4px" onclick="rejectUser('${uid}')">Reject</button>`
        : '';
      return `<tr>
        <td>${avatar}<strong>${esc(r.name||r.displayName||'—')}</strong><span class="admin-email">${esc(r.email||'')}</span></td>
        <td style="max-width:220px;color:#aaa;font-size:12px">${esc(r.reason||'')}</td>
        <td>${badge}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:#c06060;padding:24px">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function approveUser(uid) {
  await centralDb.ref(`approvals/${uid}`).update({ status: 'approved', reviewedAt: Date.now() });
  toast('User approved');
  loadPendingRequests();
}

async function rejectUser(uid) {
  const reason = prompt('Reason for rejection (optional):') || '';
  await centralDb.ref(`approvals/${uid}`).update({ status: 'rejected', rejectReason: reason, reviewedAt: Date.now() });
  toast('User rejected');
  loadPendingRequests();
}

async function loadVisitorStats() {
  const tbody   = document.getElementById('admin-visitors-body');
  const statsEl = document.getElementById('admin-stats');
  tbody.innerHTML = '<tr><td colspan="5" style="color:#555;text-align:center;padding:24px">Loading…</td></tr>';
  try {
    const snap  = await centralDb.ref('analytics').once('value');
    const data  = snap.val() || {};
    const users = Object.values(data).sort((a, b) => (b.lastSeen||0) - (a.lastSeen||0));
    const totalVisits = users.reduce((s, u) => s + (u.visitCount||0), 0);
    statsEl.innerHTML = `
      <span class="admin-stat"><span class="admin-stat-num">${users.length}</span><span class="admin-stat-label">Total users</span></span>
      <span class="admin-stat"><span class="admin-stat-num">${totalVisits}</span><span class="admin-stat-label">Total visits</span></span>`;
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:#555;text-align:center;padding:24px">No visitors yet</td></tr>';
      return;
    }
    tbody.innerHTML = users.map(u => {
      const avatar = u.photoURL ? `<img class="admin-avatar" src="${esc(u.photoURL)}" onerror="this.remove()">` : '';
      const loc = u.location ? [u.location.city,u.location.region,u.location.country].filter(Boolean).join(', ') : '—';
      const ip  = u.location?.ip ? `<span class="admin-email">${esc(u.location.ip)}</span>` : '';
      return `<tr>
        <td>${avatar}<strong>${esc(u.name||'—')}</strong><span class="admin-email">${esc(u.email||'')}</span></td>
        <td>${esc(loc)}${ip}</td>
        <td>${u.visitCount||0}</td>
        <td>${u.lastSeen ? relDate(new Date(u.lastSeen).toISOString()) : '—'}</td>
        <td>${u.firstSeen ? relDate(new Date(u.firstSeen).toISOString()) : '—'}</td>
      </tr>`;
    }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#c06060;padding:24px">Error: ${esc(e.message)}</td></tr>`;
  }
}

async function signIn() {
  try { await centralAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch(e) { if (e.code !== 'auth/popup-closed-by-user') toast('Sign-in failed: ' + e.message); }
}
async function signOut() { await centralAuth.signOut(); toast('Signed out'); }
function toggleUserMenu() { document.getElementById('user-menu').classList.toggle('hidden'); }

// ── FIREBASE DATA ─────────────────────────────────────────────
const AUTO_REFRESH_MS = 15 * 60 * 1000;
let autoRefreshTimer = null;

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(async () => {
    if (!S.user || !S.feeds.length) return;
    await fetchAllFeeds(S.feeds);
    renderSidebar(); // update unread counts only — don't disrupt reading
  }, AUTO_REFRESH_MS);
}

async function loadFromFirebase() {
  const snap = await userDb.ref(`users/${S.user.uid}`).once('value');
  const data = snap.val() || {};
  if (data.settings) S.settings = { ...S.settings, ...data.settings };
  S.folders   = data.folders   ? Object.values(data.folders)   : [];
  S.feeds     = data.feeds     ? Object.values(data.feeds)     : [];
  S.read      = data.read      ? new Set(Object.keys(data.read)) : new Set();
  S.decisions = data.decisions || {};
  const vl = document.getElementById('view-layout');
  if (vl) vl.value = S_viewLayout;
  renderSidebar();
  if (S.feeds.length > 0) {
    renderArticles();
    await fetchAllFeeds(S.feeds);
    renderSidebar(); renderArticles();
  }
}

const fbRef        = path => userDb.ref(`users/${S.user.uid}/${path}`);
const saveFeeds    = () => { const o = {}; S.feeds.forEach(f => { o[f.id] = f; }); return fbRef('feeds').set(Object.keys(o).length ? o : null); };
const saveFolders  = () => { const o = {}; S.folders.forEach(f => { o[f.id] = f; }); return fbRef('folders').set(Object.keys(o).length ? o : null); };
const saveSettings = () => fbRef('settings').set(S.settings);
const markReadDB   = id => fbRef(`read/${id}`).set(true);
const saveDecsBatch = map => {
  const u = {};
  Object.entries(map).forEach(([id, d]) => { u[`users/${S.user.uid}/decisions/${id}`] = d; });
  return userDb.ref().update(u);
};

// ── RSS FETCHING ──────────────────────────────────────────────
const enc = s => encodeURIComponent(s);
const proxyCache = {};

const PROXIES = [
  // Your own Cloudflare Worker — no rate limits, no size caps. Skipped if unset.
  async (feed) => {
    if (!PROXY_WORKER_URL) return false;
    const r = await fetchTimeout(`${PROXY_WORKER_URL}?url=${enc(feed.url)}`);
    if (!r.ok) return false;
    const p = parseXML(await r.text(), feed);
    if (!p || !p.items.length) return false;
    applyParsed(p, feed); return true;
  },
  // corsproxy.io
  async (feed) => {
    const r = await fetchTimeout(`https://corsproxy.io/?url=${enc(feed.url)}`);
    if (!r.ok) return false;
    const p = parseXML(await r.text(), feed);
    if (!p || !p.items.length) return false;
    applyParsed(p, feed); return true;
  },
  // codetabs
  async (feed) => {
    const r = await fetchTimeout(`https://api.codetabs.com/v1/proxy?quest=${enc(feed.url)}`);
    if (!r.ok) return false;
    const p = parseXML(await r.text(), feed);
    if (!p || !p.items.length) return false;
    applyParsed(p, feed); return true;
  },
  // allorigins (raw) — currently unreliable (frequent 408/500), kept as fallback
  async (feed) => {
    const r = await fetchTimeout(`https://api.allorigins.win/raw?url=${enc(feed.url)}`);
    if (!r.ok) return false;
    const p = parseXML(await r.text(), feed);
    if (!p || !p.items.length) return false;
    applyParsed(p, feed); return true;
  },
  // allorigins (JSON wrapper)
  async (feed) => {
    const r = await fetchTimeout(`https://api.allorigins.win/get?url=${enc(feed.url)}`);
    if (!r.ok) return false;
    const d = await r.json();
    const p = parseXML(d.contents, feed);
    if (!p || !p.items.length) return false;
    applyParsed(p, feed); return true;
  },
  // rss2json — heavily rate-limited on free tier, so last resort
  async (feed) => {
    const r = await fetchTimeout(`https://api.rss2json.com/v1/api.json?rss_url=${enc(feed.url)}&count=50`);
    if (!r.ok) return false;
    const d = await r.json();
    if (d.status !== 'ok') return false;
    if (!feed.name && d.feed?.title) { feed.name = d.feed.title; saveFeeds(); }
    S.articles[feed.id] = (d.items || []).map((item, i) => normalize(item, feed, i));
    return true;
  },
];

async function fetchAllFeeds(feeds) {
  const CONCURRENCY = 4;
  const failed = [];
  for (let i = 0; i < feeds.length; i += CONCURRENCY) {
    const chunk = feeds.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(f => fetchFeed(f)));
    results.forEach((ok, j) => { if (!ok) failed.push(chunk[j]); });
  }
  if (failed.length) {
    console.warn('Feeds that failed to load: ' + failed.map(f => f.name || f.url).join(', '));
    toast(`⚠ ${failed.length} of ${feeds.length} feed${feeds.length!==1?'s':''} failed to load (see console)`, 5000);
  }
  return failed;
}

// Fetch with a timeout so a hanging proxy doesn't block the cascade
async function fetchTimeout(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(`timed out after ${ms}ms`), ms);
  try { return await fetch(url, { signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function fetchFeed(feed) {
  const start = proxyCache[feed.id] ?? 0;
  const order = [...Array(PROXIES.length).keys()].map(i => (i + start) % PROXIES.length);
  const errors = [];
  for (const i of order) {
    try {
      if (await PROXIES[i](feed)) { proxyCache[feed.id] = i; return true; }
      errors.push(`proxy${i}: returned no data`);
    } catch(e) {
      errors.push(`proxy${i}: ${e.message}`);
    }
  }
  console.warn(`Failed: ${feed.name || feed.url}\n  ` + errors.join('\n  '));
  delete proxyCache[feed.id]; // reset so next attempt starts fresh
  return false;
}

function applyParsed(parsed, feed) {
  if (!feed.name && parsed.title) { feed.name = parsed.title; saveFeeds(); }
  S.articles[feed.id] = parsed.items;
}

function extractImage(raw) {
  if (raw.thumbnail && typeof raw.thumbnail === 'string' && raw.thumbnail.startsWith('http')) return raw.thumbnail;
  const encUrl = raw.enclosure?.link || raw.enclosure?.url || '';
  if (encUrl && /\.(jpe?g|png|gif|webp)/i.test(encUrl)) return encUrl;
  if (raw.mediaUrl) return raw.mediaUrl;
  const html = raw.content || raw.description || '';
  const m = html.match(/<img[^>]+src=["']([^"']{10,})["']/i);
  return m ? m[1] : null;
}

function normalize(raw, feed, idx) {
  const id = makeId(feed.id, raw.guid || raw.link || String(idx));
  return {
    id, feedId: feed.id, feedName: feed.name || feed.url,
    title:       raw.title       || 'Untitled',
    link:        raw.link        || raw.url || '',
    pubDate:     raw.pubDate     || raw.published || raw.updated || '',
    description: stripHtml(raw.description || raw.summary || '').slice(0, 300),
    content:     raw.content     || raw.description || '',
    author:      raw.author      || '',
    image:       extractImage(raw) || null
  };
}

function parseXML(xmlStr, feed) {
  try {
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    // Detect Atom only by the ROOT element, not by any descendant named "feed".
    // Many RSS feeds include <atom:link> which was falsely matching before.
    const root = doc.documentElement;
    const isAtom = !!root && root.nodeName.toLowerCase().replace(/^.*:/, '') === 'feed';
    const title  = (isAtom ? doc.querySelector('feed > title') : doc.querySelector('channel > title'))?.textContent || '';
    const nodes  = isAtom ? [...doc.querySelectorAll('entry')] : [...doc.querySelectorAll('item')];
    return { title, items: nodes.map((e, i) => {
      const mediaUrl =
        e.querySelector('media\\:thumbnail')?.getAttribute('url') ||
        e.querySelector('media\\:content')?.getAttribute('url')   ||
        (() => { const enc = e.querySelector('enclosure'); return (enc && /image/i.test(enc.getAttribute('type')||'')) ? enc.getAttribute('url') : null; })() ||
        null;
      const raw = isAtom ? {
        guid: e.querySelector('id')?.textContent, link: e.querySelector('link')?.getAttribute('href'),
        title: e.querySelector('title')?.textContent, pubDate: e.querySelector('published,updated')?.textContent,
        description: e.querySelector('summary,content')?.textContent, content: e.querySelector('content')?.innerHTML,
        author: e.querySelector('author name')?.textContent, mediaUrl
      } : {
        guid: e.querySelector('guid')?.textContent, link: e.querySelector('link')?.textContent,
        title: e.querySelector('title')?.textContent, pubDate: e.querySelector('pubDate')?.textContent,
        description: e.querySelector('description')?.textContent,
        content: e.querySelector('content\\:encoded,encoded')?.textContent || e.querySelector('description')?.textContent,
        author: e.querySelector('author,dc\\:creator,creator')?.textContent,
        enclosure: { url: e.querySelector('enclosure')?.getAttribute('url'), type: e.querySelector('enclosure')?.getAttribute('type') },
        mediaUrl
      };
      return normalize(raw, feed, i);
    })};
  } catch { return null; }
}

// FNV-1a hash over the FULL string.
// The old version base64'd the URL and kept the first 32 chars, which on any
// single site is just the shared "https://www.domain.com/" prefix — so every
// article in a feed produced an identical ID and shared one read-state.
function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function makeId(feedId, raw) {
  const s = String(raw || '');
  // Two independent hashes (forward + reversed) to make collisions vanishingly unlikely
  return feedId + '_' + hashString(s) + hashString([...s].reverse().join('')) + s.length.toString(36);
}
function stripHtml(html) { const d = document.createElement('div'); d.innerHTML = html; return d.textContent || ''; }

// ── SIDEBAR ───────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById('feed-list');
  const allUnread = allArticles().filter(a => !S.read.has(a.id)).length;
  document.title = allUnread > 0 ? `(${allUnread}) S Reader` : 'S Reader';
  const badge = document.getElementById('all-unread');
  badge.textContent = allUnread;
  badge.classList.toggle('hidden', allUnread === 0);
  document.querySelector('[data-id="all"]').classList.toggle('active', S.currentFeed === 'all');
  [...list.querySelectorAll('li:not([data-id="all"]), li.folder-section')].forEach(el => el.remove());
  S.feeds.filter(f => !f.folderId).forEach(feed => list.appendChild(makeFeedLi(feed, false)));
  S.folders.forEach(folder => {
    const folderFeeds  = S.feeds.filter(f => f.folderId === folder.id);
    const folderUnread = folderFeeds.flatMap(f => S.articles[f.id]||[]).filter(a => !S.read.has(a.id)).length;
    const isCollapsed  = collapsed.has(folder.id);
    const isActive     = S.currentFeed === `folder:${folder.id}`;
    const header = document.createElement('li');
    header.className = 'folder-header' + (isActive ? ' active' : '');
    header.innerHTML = `
      <span class="folder-arrow ${isCollapsed ? '' : 'open'}">▶</span>
      <span class="folder-name">${esc(folder.name)}</span>
      ${folderUnread > 0 ? `<span class="unread-badge">${folderUnread}</span>` : ''}
      <span class="folder-btns">
        <button title="Rename" onclick="event.stopPropagation();openEditFolder('${folder.id}')">✏️</button>
        <button title="Delete" onclick="event.stopPropagation();deleteFolder('${folder.id}')">🗑</button>
      </span>`;
    header.addEventListener('click', e => { if (e.target.closest('.folder-btns')) return; selectFeed(`folder:${folder.id}`); });
    const feedsWrap = document.createElement('li');
    feedsWrap.style.cssText = isCollapsed ? 'display:none' : '';
    feedsWrap.dataset.folderFeeds = folder.id;
    const toggleCollapse = () => {
      if (collapsed.has(folder.id)) { collapsed.delete(folder.id); feedsWrap.style.display=''; header.querySelector('.folder-arrow').classList.add('open'); }
      else { collapsed.add(folder.id); feedsWrap.style.display='none'; header.querySelector('.folder-arrow').classList.remove('open'); }
      saveCollapsed();
    };
    header.querySelector('.folder-arrow').addEventListener('click', e => { e.stopPropagation(); toggleCollapse(); });
    const innerUl = document.createElement('ul');
    innerUl.style.listStyle = 'none';
    folderFeeds.forEach(feed => innerUl.appendChild(makeFeedLi(feed, true)));
    feedsWrap.appendChild(innerUl);
    list.appendChild(header);
    list.appendChild(feedsWrap);
  });
}

function makeFeedLi(feed, nested) {
  const arts   = S.articles[feed.id] || [];
  const unread = arts.filter(a => !S.read.has(a.id)).length;
  const li = document.createElement('li');
  li.className = (nested ? 'folder-feed-item' : 'feed-item') + (S.currentFeed === feed.id ? ' active' : '');
  li.dataset.id = feed.id;
  li.innerHTML = `
    <span class="feed-title" title="${esc(feed.url)}">${esc(feed.name||feed.url)}</span>
    ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}
    <span class="feed-btns">
      <button title="Edit"   onclick="event.stopPropagation();openEditFeed('${feed.id}')">✏️</button>
      <button title="Delete" onclick="event.stopPropagation();deleteFeed('${feed.id}')">🗑</button>
    </span>`;
  li.onclick = () => selectFeed(feed.id);
  return li;
}

// ── ARTICLES ─────────────────────────────────────────────────
function allArticles() { return S.feeds.flatMap(f => S.articles[f.id]||[]).sort((a,b) => new Date(b.pubDate||0)-new Date(a.pubDate||0)); }

function visibleArticles() {
  let feedIds;
  if (S.currentFeed === 'all') feedIds = S.feeds.map(f => f.id);
  else if (S.currentFeed.startsWith('folder:')) { const fid = S.currentFeed.slice(7); feedIds = S.feeds.filter(f => f.folderId===fid).map(f => f.id); }
  else feedIds = [S.currentFeed];
  const oldest = document.getElementById('sort-order')?.value === 'oldest';
  let list = feedIds.flatMap(id => S.articles[id]||[]).sort((a,b) => { const diff=new Date(a.pubDate||0)-new Date(b.pubDate||0); return oldest?diff:-diff; });
  if (document.getElementById('chk-hide-read')?.checked) list = list.filter(a => !S.read.has(a.id));
  if (!document.getElementById('chk-show-filtered')?.checked && S.settings.filterAction==='hide')
    list = list.filter(a => { const d=S.decisions[a.id]; return !d||d.keep!==false; });
  return list;
}

// The layout used for the CURRENT view: a single feed uses its own layout,
// a mixed view (All Items / folder) uses the chosen view layout.
function effectiveViewLayout() {
  if (isSingleFeedView()) {
    return S.feeds.find(f => f.id === S.currentFeed)?.layout || 'list';
  }
  return S_viewLayout === 'grid' ? 'photo' : 'list';
}

function renderArticles() {
  if (S.scrollObserver) { S.scrollObserver.disconnect(); S.scrollObserver = null; }
  S.currentArticles = visibleArticles();
  S.displayedCount  = 0; S.focusedIndex = -1;
  const container = document.getElementById('article-list');
  if (S.currentArticles.length===0 && S.feeds.length===0) {
    container.dataset.mode = 'list';
    container.innerHTML = `<div class="empty-state"><h3>No feeds yet</h3><p>Add a feed to get started.</p><button class="btn primary" onclick="openAddFeed()">+ Add Feed</button></div>`;
    return;
  }
  if (S.currentArticles.length===0) {
    container.dataset.mode = 'list';
    container.innerHTML = `<div class="empty-state"><h3>Nothing to show</h3><p>Try refreshing or adjusting the filter options.</p></div>`;
    return;
  }
  // Grid/masonry when the effective layout is photo; rows otherwise.
  container.dataset.mode = effectiveViewLayout() === 'photo' ? 'grid' : 'list';
  container.innerHTML = '';
  appendBatch();
}

function appendBatch() {
  const container = document.getElementById('article-list');
  document.getElementById('scroll-sentinel')?.remove();
  const batch = S.currentArticles.slice(S.displayedCount, S.displayedCount + PAGE_SIZE);
  batch.forEach(a => container.appendChild(createArticleEl(a)));
  S.displayedCount += batch.length;
  if (S.displayedCount < S.currentArticles.length) {
    const s = document.createElement('div');
    s.id='scroll-sentinel'; s.className='scroll-sentinel';
    s.innerHTML = `<span class="spin"></span> Loading…`;
    container.appendChild(s);
    S.scrollObserver = new IntersectionObserver(entries => { if (entries[0].isIntersecting) appendBatch(); }, { rootMargin:'400px' });
    S.scrollObserver.observe(s);
  } else if (S.displayedCount > 0) {
    const end = document.createElement('div');
    end.className = 'list-end';
    end.textContent = `${S.currentArticles.length} article${S.currentArticles.length!==1?'s':''}`;
    container.appendChild(end);
  }
}

function createArticleEl(a) {
  const el = document.createElement('div');
  // Single feed → use that feed's own layout.
  // Mixed view (All Items / folder) → use the uniform view layout the user picked,
  //   so interleaved feeds don't clash. 'grid' maps to the photo card layout.
  let layout;
  if (isSingleFeedView()) {
    layout = S.feeds.find(f => f.id === a.feedId)?.layout || 'list';
  } else {
    layout = S_viewLayout === 'grid' ? 'photo' : 'list';
  }
  el.className = 'article-item layout-' + layout
    + (!S.read.has(a.id)?' unread':'')
    + (S.decisions[a.id]?.keep===false?' ai-filtered':'')
    + (a.image?' has-thumb':'');
  el.dataset.id = a.id;
  el.innerHTML = articleHTML(a);
  return el;
}

// Derive a favicon URL for an article, preferring the article link's domain,
// falling back to the feed URL. Uses Google's favicon service.
function faviconFor(a) {
  const feed = S.feeds.find(f => f.id === a.feedId);
  const src = a.link || feed?.url || '';
  try {
    const host = new URL(src).hostname;
    if (!host) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch { return null; }
}

function articleHTML(a) {
  const dec = S.decisions[a.id];
  let meta = `<span class="tag tag-source">${esc(a.feedName)}</span>`;
  if (a.pubDate) meta += `<span>${relDate(a.pubDate)}</span>`;
  if (a.author)  meta += `<span>${esc(a.author)}</span>`;
  if (dec?.keep===false) meta += `<span class="tag tag-filtered" title="${esc(dec.reason||'')}">🚫 filtered</span>`;
  else if (!dec && hasFilterRule(a.feedId)) meta += `<span class="tag tag-pending">⏳ unfiltered</span>`;
  const thumb = a.image ? `<img class="article-thumb" src="${esc(a.image)}" loading="lazy" onerror="this.style.display='none'" alt="">` : '';
  const body = sanitize(a.content) || (a.description ? `<p>${esc(a.description)}</p>` : '');
  const titleEl = a.link
    ? `<a class="article-title-link" href="${esc(a.link)}" target="_blank" rel="noopener noreferrer" onclick="markArticleReadById('${esc(a.id)}')">${esc(a.title)}</a>`
    : `<span class="article-title-link">${esc(a.title)}</span>`;
  const favUrl = faviconFor(a);
  const favicon = favUrl
    ? `<img class="article-favicon" src="${esc(favUrl)}" loading="lazy" onerror="this.style.display='none'" alt="" title="${esc(a.feedName)}">`
    : '';
  return `<div class="article-layout">
    ${favicon}
    ${thumb}
    <div class="article-content">
      <div class="article-title">${titleEl}</div>
      <div class="article-meta">${meta}</div>
      ${body ? `<div class="article-body"><div class="article-body-inner">${body}</div></div>` : ''}
    </div>
  </div>`;
}

function focusArticleEl(el) {
  document.querySelectorAll('.article-item.kb-focused').forEach(e => e.classList.remove('kb-focused'));
  el.classList.add('kb-focused');
  markArticleRead(el);
}

function markArticleRead(el) {
  const id = el.dataset.id;
  if (!S.read.has(id)) { S.read.add(id); el.classList.remove('unread'); markReadDB(id); renderSidebar(); }
}

function markArticleReadById(id) {
  const el = document.querySelector(`.article-item[data-id="${id}"]`);
  if (el) markArticleRead(el);
}

// ── KEYBOARD NAVIGATION ───────────────────────────────────────
function focusArticle(idx) {
  if (S.currentArticles.length===0) return;
  idx = Math.max(0, Math.min(idx, S.currentArticles.length-1));
  while (idx >= S.displayedCount && S.displayedCount < S.currentArticles.length) appendBatch();
  S.focusedIndex = idx;
  const art = S.currentArticles[idx];
  const el  = document.querySelector(`.article-item[data-id="${art.id}"]`);
  if (!el) return;
  focusArticleEl(el);
  const container = document.getElementById('article-list');
  const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  container.scrollBy({ top: offset, behavior: 'smooth' });
}

function getSidebarItems() {
  const items = ['all'];
  S.feeds.filter(f => !f.folderId).forEach(f => items.push(f.id));
  S.folders.forEach(folder => {
    items.push(`folder:${folder.id}`);
    S.feeds.filter(f => f.folderId===folder.id).forEach(f => items.push(f.id));
  });
  return items;
}

async function markAllRead() {
  const toMark = visibleArticles().filter(a => !S.read.has(a.id));
  if (!toMark.length) { toast('Nothing to mark'); return; }
  toMark.forEach(a => S.read.add(a.id));
  const u = {};
  toMark.forEach(a => { u[`users/${S.user.uid}/read/${a.id}`] = true; });
  await userDb.ref().update(u);
  renderSidebar(); renderArticles();
  toast(`Marked ${toMark.length} as read`);
}

function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
function closeSidebar()  { document.getElementById('sidebar').classList.remove('open'); }

let gPending = false, gTimer = null;

document.addEventListener('keydown', e => {
  const navKeys = new Set(['j','k','n','p','o','v','m','r','a','?','h',' ']);
  if (navKeys.has(e.key) && ['SELECT','BUTTON'].includes(e.target.tagName)) e.target.blur();
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
  if (document.querySelector('.overlay.open')) {
    if (e.key==='Escape') document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
    return;
  }
  if (!document.getElementById('app').classList.contains('hidden')) {
    const list = document.getElementById('article-list');
    if (gPending) { clearTimeout(gTimer); gPending=false; if (e.key==='a') selectFeed('all'); return; }
    if (e.key==='g' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { gPending=true; gTimer=setTimeout(()=>{gPending=false;},1000); return; }
    switch(true) {
      case (e.key==='j'||e.key==='n')&&!e.shiftKey: e.preventDefault(); focusArticle(S.focusedIndex+1); break;
      case (e.key==='k'||e.key==='p')&&!e.shiftKey: e.preventDefault(); focusArticle(S.focusedIndex-1); break;
      case (e.key==='o'||e.key==='v')&&!e.shiftKey: { if(S.focusedIndex<0) break; const art=S.currentArticles[S.focusedIndex]; if(art?.link) window.open(art.link,'_blank','noopener'); break; }
      case e.key==='m'&&!e.shiftKey: {
        if(S.focusedIndex<0) break;
        const art=S.currentArticles[S.focusedIndex]; const el=document.querySelector(`.article-item[data-id="${art.id}"]`); if(!el) break;
        if(S.read.has(art.id)) { S.read.delete(art.id); el.classList.add('unread'); fbRef(`read/${art.id}`).remove(); renderSidebar(); } else markArticleRead(el);
        break;
      }
      case e.key===' '&&!e.shiftKey: e.preventDefault(); list.scrollBy({top:list.clientHeight*0.8,behavior:'smooth'}); break;
      case e.key===' '&&e.shiftKey:  e.preventDefault(); list.scrollBy({top:-list.clientHeight*0.8,behavior:'smooth'}); break;
      case e.key==='A'&&e.shiftKey:  e.preventDefault(); markAllRead(); break;
      case (e.key==='J'||e.key==='N')&&e.shiftKey: { e.preventDefault(); const items=getSidebarItems(),idx=items.indexOf(S.currentFeed); if(idx<items.length-1) selectFeed(items[idx+1]); break; }
      case (e.key==='K'||e.key==='P')&&e.shiftKey: { e.preventDefault(); const items=getSidebarItems(),idx=items.indexOf(S.currentFeed); if(idx>0) selectFeed(items[idx-1]); break; }
      case e.key==='X'&&e.shiftKey: { if(!S.currentFeed.startsWith('folder:')) break; collapsed.add(S.currentFeed.slice(7)); saveCollapsed(); renderSidebar(); break; }
      case e.key==='C'&&e.shiftKey: S.folders.forEach(f=>collapsed.add(f.id)); saveCollapsed(); renderSidebar(); break;
      case e.key==='E'&&e.shiftKey: collapsed.clear(); saveCollapsed(); renderSidebar(); break;
      case e.key==='r'&&!e.shiftKey&&!e.ctrlKey&&!e.metaKey: refreshFeeds(); break;
      case e.key==='a'&&!e.shiftKey: openAddFeed(); break;
      case e.key==='?'||(e.key==='h'&&!e.shiftKey): openOverlay('overlay-shortcuts'); break;
    }
  }
});

// ── FOLDER MANAGEMENT ────────────────────────────────────────
function openAddFolder() {
  S.editingFolderId = null;
  document.getElementById('folder-modal-title').textContent = 'New Folder';
  document.getElementById('btn-save-folder').textContent = 'Create';
  document.getElementById('folder-name-input').value = '';
  openOverlay('overlay-folder');
  setTimeout(() => document.getElementById('folder-name-input').focus(), 60);
}
function openEditFolder(folderId) {
  const folder = S.folders.find(f => f.id===folderId); if(!folder) return;
  S.editingFolderId = folderId;
  document.getElementById('folder-modal-title').textContent = 'Rename Folder';
  document.getElementById('btn-save-folder').textContent = 'Save';
  document.getElementById('folder-name-input').value = folder.name;
  openOverlay('overlay-folder');
  setTimeout(() => document.getElementById('folder-name-input').focus(), 60);
}
async function saveFolder() {
  const name = document.getElementById('folder-name-input').value.trim();
  if (!name) { toast('Please enter a folder name'); return; }
  if (S.editingFolderId) { const folder=S.folders.find(f=>f.id===S.editingFolderId); if(folder) folder.name=name; }
  else S.folders.push({ id:'folder_'+Date.now(), name });
  await saveFolders(); closeOverlay('overlay-folder'); renderSidebar();
  toast(S.editingFolderId ? 'Folder renamed' : 'Folder created!');
}
async function deleteFolder(folderId) {
  if (!confirm('Delete this folder? Feeds will become uncategorized.')) return;
  S.feeds.forEach(f => { if(f.folderId===folderId) delete f.folderId; });
  S.folders = S.folders.filter(f => f.id!==folderId);
  await Promise.all([saveFolders(), saveFeeds()]);
  if (S.currentFeed===`folder:${folderId}`) selectFeed('all');
  else { renderSidebar(); renderArticles(); }
}

// ── FEED MANAGEMENT ──────────────────────────────────────────
function populateFolderDropdown(selectedId) {
  const sel = document.getElementById('fi-folder');
  sel.innerHTML = '<option value="">— No folder —</option>';
  S.folders.forEach(f => { const o=document.createElement('option'); o.value=f.id; o.textContent=f.name; if(f.id===selectedId) o.selected=true; sel.appendChild(o); });
}
function openAddFeed() {
  S.editingFeedId = null;
  document.getElementById('feed-modal-title').textContent = 'Add Feed';
  document.getElementById('btn-save-feed').textContent = 'Add Feed';
  document.getElementById('fi-url').value = '';
  document.getElementById('fi-name').value = '';
  document.getElementById('fi-filter').value = '';
  document.getElementById('fi-layout').value = 'list';
  populateFolderDropdown(S.currentFeed.startsWith('folder:') ? S.currentFeed.slice(7) : '');
  openOverlay('overlay-feed');
  setTimeout(() => document.getElementById('fi-url').focus(), 60);
}
function openEditFeed(feedId) {
  const feed = S.feeds.find(f => f.id===feedId); if(!feed) return;
  S.editingFeedId = feedId;
  document.getElementById('feed-modal-title').textContent = 'Edit Feed';
  document.getElementById('btn-save-feed').textContent = 'Save';
  document.getElementById('fi-url').value    = feed.url;
  document.getElementById('fi-name').value   = feed.name||'';
  document.getElementById('fi-filter').value = feed.filterRule||'';
  document.getElementById('fi-layout').value = feed.layout || 'list';
  populateFolderDropdown(feed.folderId||'');
  openOverlay('overlay-feed');
}
async function saveFeed() {
  const url        = document.getElementById('fi-url').value.trim();
  if (!url) { toast('Please enter a feed URL'); return; }
  const name       = document.getElementById('fi-name').value.trim()||null;
  const filterRule = document.getElementById('fi-filter').value.trim()||null;
  const folderId   = document.getElementById('fi-folder').value||null;
  const layout     = document.getElementById('fi-layout').value || 'list';
  if (S.editingFeedId) {
    const feed = S.feeds.find(f => f.id===S.editingFeedId);
    if (feed) Object.assign(feed, { url, name, filterRule, folderId, layout });
    await saveFeeds(); closeOverlay('overlay-feed'); renderSidebar(); renderArticles();
  } else {
    const feed = { id:'f'+Date.now(), url, name, filterRule, folderId, layout };
    S.feeds.push(feed); await saveFeeds(); closeOverlay('overlay-feed');
    setRefreshBusy(true); await fetchAllFeeds([feed]); setRefreshBusy(false);
    renderSidebar(); renderArticles(); toast('Feed added!');
  }
}
async function deleteFeed(feedId) {
  if (!confirm('Remove this feed?')) return;
  S.feeds = S.feeds.filter(f => f.id!==feedId); delete S.articles[feedId];
  await saveFeeds();
  if (S.currentFeed===feedId) selectFeed('all');
  else { renderSidebar(); renderArticles(); }
}

// ── SETTINGS ─────────────────────────────────────────────────
function openSettings() {
  document.getElementById('si-apikey').value = S.settings.apiKey||'';
  document.getElementById('si-filter').value = S.settings.globalFilter||'';
  document.getElementById('si-action').value = S.settings.filterAction||'mark';
  document.getElementById('si-model').value  = S.settings.model||'claude-haiku-4-5-20251001';
  openOverlay('overlay-settings');
}
async function applySettings() {
  S.settings.apiKey       = document.getElementById('si-apikey').value.trim();
  S.settings.globalFilter = document.getElementById('si-filter').value.trim();
  S.settings.filterAction = document.getElementById('si-action').value;
  S.settings.model        = document.getElementById('si-model').value;
  await saveSettings(); closeOverlay('overlay-settings'); renderArticles(); toast('Settings saved');
}

// ── NAVIGATION ────────────────────────────────────────────────
function selectFeed(feedId) {
  S.currentFeed = feedId;
  let name = 'All Items';
  if (feedId.startsWith('folder:'))  name = S.folders.find(f=>f.id===feedId.slice(7))?.name||'Folder';
  else if (feedId!=='all')           name = S.feeds.find(f=>f.id===feedId)?.name||'Feed';
  document.getElementById('current-feed-name').textContent = name;
  // The view-layout picker only applies to mixed views, so hide it on a single feed.
  const vl = document.getElementById('view-layout');
  if (vl) { vl.style.display = isSingleFeedView() ? 'none' : ''; vl.value = S_viewLayout; }
  renderSidebar(); renderArticles();
  if (window.innerWidth <= 700) closeSidebar();
}
async function refreshFeeds() {
  let toRefresh;
  if (S.currentFeed==='all') toRefresh=S.feeds;
  else if (S.currentFeed.startsWith('folder:')) { const fid=S.currentFeed.slice(7); toRefresh=S.feeds.filter(f=>f.folderId===fid); }
  else toRefresh=S.feeds.filter(f=>f.id===S.currentFeed);
  if (!toRefresh.length) { toast('No feeds to refresh'); return; }
  setRefreshBusy(true);
  await fetchAllFeeds(toRefresh);
  setRefreshBusy(false); renderSidebar(); renderArticles(); toast('Refreshed');
}
function setRefreshBusy(v) { const btn=document.getElementById('btn-refresh'); btn.disabled=v; btn.textContent=v?'↻ Loading…':'↻ Refresh'; }

// ── AI FILTERING ──────────────────────────────────────────────
function hasFilterRule(feedId) {
  if (S.settings.globalFilter) return true;
  return !!(S.feeds.find(f=>f.id===feedId)?.filterRule);
}
async function runAIFilter() {
  if (!S.settings.apiKey) { toast('Add a Claude API key in ⚙ Settings first'); openSettings(); return; }
  const toFilter = visibleArticles().filter(a => hasFilterRule(a.feedId) && !S.decisions[a.id]);
  if (!toFilter.length) { toast('All visible articles already have a filter decision'); return; }
  const btn=document.getElementById('btn-filter'); btn.disabled=true; btn.textContent='⏳ Filtering…';
  const statusEl=document.getElementById('filter-status'); statusEl.classList.remove('hidden');
  const groups={};
  toFilter.forEach(a => { const feed=S.feeds.find(f=>f.id===a.feedId); const rule=feed?.filterRule||S.settings.globalFilter; (groups[rule]=groups[rule]||[]).push(a); });
  let done=0; const total=toFilter.length; const FBATCH=15;
  try {
    for (const [rule,arts] of Object.entries(groups)) {
      for (let i=0; i<arts.length; i+=FBATCH) {
        const batch=arts.slice(i,i+FBATCH);
        statusEl.textContent=`🤖 Filtering ${done+batch.length} / ${total}…`;
        const results=await callClaude(batch,rule); const newDec={};
        results.forEach(r => { S.decisions[r.id]={keep:r.keep,reason:r.reason||''}; newDec[r.id]=S.decisions[r.id]; });
        done+=batch.length; await saveDecsBatch(newDec); renderArticles();
      }
    }
    statusEl.textContent=`✅ Done — ${done} article${done!==1?'s':''} evaluated`;
    setTimeout(()=>statusEl.classList.add('hidden'),3500);
  } catch(err) {
    statusEl.textContent=`❌ ${err.message}`; setTimeout(()=>statusEl.classList.add('hidden'),6000); toast('Filter error: '+err.message);
  }
  btn.disabled=false; btn.textContent='🤖 AI Filter';
}
async function callClaude(articles,rule) {
  const body=articles.map(a=>`ID: ${a.id}\nTitle: ${a.title}\nSummary: ${a.description}`).join('\n\n---\n\n');
  const resp=await fetch('https://api.anthropic.com/v1/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':S.settings.apiKey,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
    body:JSON.stringify({model:S.settings.model,max_tokens:2048,messages:[{role:'user',content:`You are a content filter for an RSS reader.\nFilter rule: "${rule}"\n\nFor each article decide KEEP (true) or FILTER (false).\nReturn ONLY a JSON array — no prose, no markdown.\n\n${body}\n\nFormat: [{"id":"...","keep":true,"reason":"one sentence"}]`}]})
  });
  if (!resp.ok) { const e=await resp.json().catch(()=>({})); throw new Error(e.error?.message||`HTTP ${resp.status}`); }
  const data=await resp.json();
  const match=(data.content?.[0]?.text||'').match(/\[[\s\S]*\]/);
  if (!match) throw new Error('Unexpected AI response format');
  return JSON.parse(match[0]);
}

// ── UTILS ─────────────────────────────────────────────────────
function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function relDate(str) {
  if (!str) return '';
  try {
    const diff=Date.now()-new Date(str);
    if (diff<60000)    return 'just now';
    if (diff<3600000)  return `${Math.floor(diff/60000)}m ago`;
    if (diff<86400000) return `${Math.floor(diff/3600000)}h ago`;
    if (diff<604800000)return `${Math.floor(diff/86400000)}d ago`;
    return new Date(str).toLocaleDateString();
  } catch { return ''; }
}
function sanitize(html) {
  if (!html) return '';
  const tmp=document.createElement('div'); tmp.innerHTML=html;
  if (tmp.children.length===0 && html.includes('&lt;')) { const dec=document.createElement('textarea'); dec.innerHTML=html; tmp.innerHTML=dec.value; }
  tmp.querySelectorAll('script,iframe,object,embed,form').forEach(el=>el.remove());
  tmp.querySelectorAll('*').forEach(el=>{[...el.attributes].forEach(attr=>{if(/^on/i.test(attr.name)||(attr.name==='href'&&/^javascript:/i.test(attr.value)))el.removeAttribute(attr.name);});});
  return tmp.innerHTML;
}
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function openOverlay(id)  { document.getElementById(id).classList.add('open'); }
function closeOverlay(id) { document.getElementById(id).classList.remove('open'); }
function toast(msg,ms=3200) {
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.remove('hidden');
  clearTimeout(toast._t); toast._t=setTimeout(()=>el.classList.add('hidden'),ms);
}
document.querySelectorAll('.overlay').forEach(el=>{el.addEventListener('click',e=>{if(e.target===el)el.classList.remove('open');});});

// Show version in sidebar footer + console
document.getElementById('app-version').textContent = 'v' + APP_VERSION;
console.log('%cS Reader v' + APP_VERSION, 'color:#5a9cf8;font-weight:bold');

initFirebase();
