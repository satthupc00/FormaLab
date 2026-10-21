// ---------------------------------------------------------------------------
// Access keys — who is allowed to use the app.
//
// Mondiro FormaLab (like Mondiro Toolbox) shares its key list with Spine Preview: the list lives in access/keys.json in the
// (public) Spine_Preview repo, so one key unlocks both apps and revoking it locks both. Keys are
// stored there only as SHA-256 hashes, so reading the public file does not reveal any usable key.
// Each installed copy:
//   - asks for a key once, checks it against the list and remembers it,
//   - re-checks the list at startup and every RECHECK_MS while running, and locks itself as soon
//     as its key is revoked (active:false) or deleted,
//   - keeps working offline for up to OFFLINE_GRACE_DAYS since its last successful check.
//
// The owner manages the list from the Admin panel inside the app. Admin logs in with a GitHub
// token that can write to the Spine_Preview repo; edits are committed straight to access/keys.json
// through the GitHub API. A machine with an admin token saved is always unlocked.
// ---------------------------------------------------------------------------
const { app, ipcMain, net, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OWNER = 'satthupc00';
const REPO = 'Spine_Preview'; // shared key list, see header
const BRANCH = 'main';
const KEYS_PATH = 'access/keys.json';
const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${KEYS_PATH}`;
const API = 'https://api.github.com';

const OFFLINE_GRACE_DAYS = 7;
const RECHECK_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos

const licenseFile = () => path.join(app.getPath('userData'), 'license.json');
const adminFile = () => path.join(app.getPath('userData'), 'admin.dat');

// ---- helpers ---------------------------------------------------------------

// The SPV- prefix and hash salt must stay identical to Spine Preview so the shared keys match.
function normalizeKey(key) {
  return String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SPV/, '');
}

function hashKey(key) {
  return crypto.createHash('sha256').update('spine-preview:' + normalizeKey(key)).digest('hex');
}

function generateKey() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return 'SPV-' + s.match(/.{4}/g).join('-');
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await net.fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* not critical */ }
}

// Admin data (GitHub token + plain keys the admin created) is encrypted with the OS keychain
// (DPAPI on Windows) so it can't be read by copying the file to another machine.
function readAdmin() {
  try {
    const buf = fs.readFileSync(adminFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function writeAdmin(data) {
  const text = JSON.stringify(data);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf-8');
  fs.writeFileSync(adminFile(), buf);
}

// ---- checking this machine's key -------------------------------------------

async function fetchPublicKeyList() {
  // The query string makes the CDN less likely to hand back a stale copy after a revoke.
  const res = await fetchWithTimeout(`${RAW_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data.keys) ? data.keys : [];
}

let lastStatus = null;

async function checkAccess() {
  const admin = readAdmin();
  if (admin && admin.token) return (lastStatus = { ok: true, mode: 'admin' });

  const store = readJson(licenseFile(), {});
  if (!store.key) return (lastStatus = { ok: false, reason: 'nokey' });

  let keys;
  try {
    keys = await fetchPublicKeyList();
  } catch (e) {
    const graceMs = OFFLINE_GRACE_DAYS * 24 * 3600 * 1000;
    if (store.lastOkAt && Date.now() - store.lastOkAt < graceMs) {
      return (lastStatus = { ok: true, mode: 'offline', name: store.name });
    }
    return (lastStatus = { ok: false, reason: 'offline' });
  }

  const entry = keys.find(k => k.hash === hashKey(store.key));
  if (entry && entry.active !== false) {
    writeJson(licenseFile(), { ...store, lastOkAt: Date.now(), name: entry.name });
    return (lastStatus = { ok: true, mode: 'key', name: entry.name });
  }
  writeJson(licenseFile(), { ...store, lastOkAt: 0 });
  return (lastStatus = { ok: false, reason: entry ? 'revoked' : 'invalid' });
}

async function activate(key) {
  if (!normalizeKey(key)) return { ok: false, reason: 'invalid' };
  let keys;
  try {
    keys = await fetchPublicKeyList();
  } catch (e) {
    return { ok: false, reason: 'offline' };
  }
  const entry = keys.find(k => k.hash === hashKey(key));
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.active === false) return { ok: false, reason: 'revoked' };
  writeJson(licenseFile(), { key: key.trim(), lastOkAt: Date.now(), name: entry.name });
  return (lastStatus = { ok: true, mode: 'key', name: entry.name });
}

function isLocked() {
  return !lastStatus || !lastStatus.ok;
}

// ---- admin: editing access/keys.json through the GitHub API -----------------

async function gh(method, url, token, body) {
  const res = await fetchWithTimeout(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    // Without this Chromium serves GitHub's cached copy (max-age=60) right after an edit, so the
    // panel showed stale rows and the next edit failed on an outdated sha.
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function requireToken() {
  const admin = readAdmin();
  if (!admin || !admin.token) throw new Error('Chưa đăng nhập Admin.');
  return admin;
}

async function adminLogin(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Hãy dán GitHub token.');
  const res = await gh('GET', `/repos/${OWNER}/${REPO}`, token);
  if (res.status === 401) throw new Error('Token không hợp lệ hoặc đã hết hạn.');
  if (!res.ok) throw new Error(`Token không truy cập được repo ${OWNER}/${REPO} (HTTP ${res.status}).`);
  if (res.data.permissions && !res.data.permissions.push) throw new Error('Tài khoản của token này không có quyền ghi vào repo.');
  const prev = readAdmin() || {};
  writeAdmin({ token, plainKeys: prev.plainKeys || {} });
  lastStatus = { ok: true, mode: 'admin' };
  return true;
}

// Logging out forgets the token only; the keys created on this machine stay saved so they can
// still be shown after logging in again.
function adminLogout() {
  const admin = readAdmin();
  if (admin) writeAdmin({ plainKeys: admin.plainKeys || {} });
}

async function readRemoteList(token) {
  const res = await gh('GET', `/repos/${OWNER}/${REPO}/contents/${KEYS_PATH}?ref=${BRANCH}&t=${Date.now()}`, token);
  if (res.status === 404) return { data: { keys: [] }, sha: null };
  if (!res.ok) throw new Error(`Không đọc được danh sách key (HTTP ${res.status}).`);
  const data = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
  if (!Array.isArray(data.keys)) data.keys = [];
  return { data, sha: res.data.sha };
}

// Read-modify-write with the file's sha; if someone else changed it in between, GitHub rejects
// the write (409) and we retry once on the fresh copy.
async function editRemoteList(token, message, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readRemoteList(token);
    mutate(data);
    const content = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8').toString('base64');
    const res = await gh('PUT', `/repos/${OWNER}/${REPO}/contents/${KEYS_PATH}`, token, {
      message, content, branch: BRANCH, ...(sha ? { sha } : {})
    });
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`Không lưu được lên GitHub (HTTP ${res.status}).`);
  }
  throw new Error('Danh sách vừa bị sửa ở nơi khác, hãy thử lại.');
}

function withPlainKeys(keys) {
  const plainKeys = (readAdmin() || {}).plainKeys || {};
  return keys.map(k => ({ ...k, key: plainKeys[k.id] || null }));
}

function rememberKey(id, key) {
  const admin = readAdmin() || {};
  const plainKeys = { ...(admin.plainKeys || {}) };
  if (key) plainKeys[id] = key; else delete plainKeys[id];
  writeAdmin({ ...admin, plainKeys });
}

async function adminList() {
  const admin = requireToken();
  const { data } = await readRemoteList(admin.token);
  return withPlainKeys(data.keys);
}

async function adminAdd(name, note) {
  const admin = requireToken();
  name = String(name || '').trim();
  if (!name) throw new Error('Hãy nhập tên người dùng.');
  const key = generateKey();
  const id = 'k_' + crypto.randomBytes(4).toString('hex');
  const data = await editRemoteList(admin.token, `Access: thêm key cho ${name}`, d => {
    d.keys.push({
      id, name, note: String(note || '').trim(), hash: hashKey(key), active: true,
      created: new Date().toISOString().slice(0, 10)
    });
  });
  rememberKey(id, key);
  return { id, key, keys: withPlainKeys(data.keys) };
}

// Gives an existing person a fresh key (their old key stops working). Used when the old key
// wasn't saved on this machine and can't be shown any more.
async function adminRegenerate(id) {
  const admin = requireToken();
  const key = generateKey();
  const data = await editRemoteList(admin.token, `Access: đổi key ${id}`, d => {
    const k = d.keys.find(x => x.id === id);
    if (!k) throw new Error('Không tìm thấy key này nữa.');
    k.hash = hashKey(key);
    k.active = true;
  });
  rememberKey(id, key);
  return { key, keys: withPlainKeys(data.keys) };
}

async function adminSetActive(id, active) {
  const admin = requireToken();
  const data = await editRemoteList(admin.token, `Access: ${active ? 'mở lại' : 'thu hồi'} key ${id}`, d => {
    const k = d.keys.find(x => x.id === id);
    if (k) k.active = !!active;
  });
  return withPlainKeys(data.keys);
}

async function adminRemove(id) {
  const admin = requireToken();
  const data = await editRemoteList(admin.token, `Access: xóa key ${id}`, d => {
    d.keys = d.keys.filter(x => x.id !== id);
  });
  rememberKey(id, null);
  return withPlainKeys(data.keys);
}

// ---- wiring ----------------------------------------------------------------

// Wrap handlers so errors reach the renderer as { error } instead of a rejected invoke.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { result: await fn(...args) }; } catch (err) { return { error: err.message || String(err) }; }
  });
}

function initLicense(getWindow) {
  handle('license-check', () => checkAccess());
  handle('license-activate', key => activate(key));
  handle('admin-status', () => !!(readAdmin() || {}).token);
  handle('admin-login', token => adminLogin(token));
  handle('admin-logout', () => { adminLogout(); return checkAccess(); });
  handle('admin-list', () => adminList());
  handle('admin-add', (name, note) => adminAdd(name, note));
  handle('admin-set-active', (id, active) => adminSetActive(id, active));
  handle('admin-remove', id => adminRemove(id));
  handle('admin-regenerate', id => adminRegenerate(id));

  setInterval(async () => {
    const status = await checkAccess();
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('license-status', status);
  }, RECHECK_MS);
}

module.exports = { initLicense, isLocked, hashKey, normalizeKey, generateKey };
