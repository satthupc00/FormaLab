// ---------------------------------------------------------------------------
// Auto update — installed copies check GitHub Releases of this repo (see "publish" in
// package.json) at startup and every hour. A newer version is downloaded in the background while
// the in-app update modal (renderer/license-ui.js) shows the release notes and progress; the user
// restarts from there, or it installs on the next quit. No OS dialogs.
// Only works for copies installed with the Setup .exe (NSIS).
// ---------------------------------------------------------------------------
const { app, ipcMain, net } = require('electron');

const CHECK_EVERY_MS = 60 * 60 * 1000;
const LATEST_YML = 'https://github.com/satthupc00/FormaLab/releases/latest/download/latest.yml';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Newest released version according to latest.yml, or null when it can't be read (offline).
async function fetchLatestVersion() {
  try {
    const res = await net.fetch(`${LATEST_YML}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const m = (await res.text()).match(/^version:\s*['"]?([\d.]+)/m);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

ipcMain.handle('app-version', () => ({ result: app.getVersion() }));

// true = this copy is the newest release, false = a newer one exists, null = couldn't tell
// (offline). Reads the same latest.yml the updater uses, so it also works when run with npm start.
ipcMain.handle('check-latest', async () => {
  const latest = await fetchLatestVersion();
  return { result: latest ? compareVersions(app.getVersion(), latest) >= 0 : null };
});

// "Kiểm tra cập nhật" button. Installed copies ask electron-updater (which then downloads the
// new version and drives the usual update-status / restart flow); `npm start` only compares.
// Result: { state: 'latest' | 'available' | 'error', version?, canDownload? }
let autoUpdaterRef = null;
ipcMain.handle('update-check-now', async () => {
  try {
    if (autoUpdaterRef) {
      const r = await autoUpdaterRef.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      if (!v) return { result: { state: 'error' } };
      return { result: compareVersions(v, app.getVersion()) > 0 ? { state: 'available', version: v, canDownload: true } : { state: 'latest', version: v } };
    }
    const v = await fetchLatestVersion();
    if (!v) return { result: { state: 'error' } };
    return { result: compareVersions(v, app.getVersion()) > 0 ? { state: 'available', version: v } : { state: 'latest', version: v } };
  } catch (e) {
    return { result: { state: 'error', message: e.message } };
  }
});

// Release notes -> list of lines for the modal (latest.yml gives plain text; the GitHub feed HTML).
function notesToLines(notes) {
  if (!notes) return [];
  const raw = Array.isArray(notes) ? notes.map(n => n.note || '').join('\n') : String(notes);
  return raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
    .split('\n').map(l => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
}

function initUpdater(getWindow) {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdaterRef = autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = status => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
  };
  const install = () => autoUpdater.quitAndInstall(true, true);

  autoUpdater.on('update-available', info => send({ state: 'available', version: info.version, notes: notesToLines(info.releaseNotes) }));
  autoUpdater.on('download-progress', p => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => send({ state: 'ready', version: info.version, notes: notesToLines(info.releaseNotes) }));
  autoUpdater.on('error', err => {
    console.warn('[updater]', err && err.message);
    send({ state: 'error', message: err && err.message });
  });

  ipcMain.on('update-install', install);
  ipcMain.on('update-retry', () => autoUpdater.checkForUpdates().catch(() => {}));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 3000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { initUpdater };
