// Thin layer between the viewer and the outside world. Inside Electron (nodeIntegration) files are
// read from disk by path; in a plain browser (used for testing the UI) dropped File objects are used.
// Every loadable thing is a "FileRef": { name, ext, path?, file?, url(), arrayBuffer(), text() }.

const nodeRequire = typeof window !== 'undefined' && typeof window.require === 'function' ? window.require : null;
export const isElectron = !!(nodeRequire && typeof process !== 'undefined' && process.versions && process.versions.electron);

const fs = isElectron ? nodeRequire('fs') : null;
const nodePath = isElectron ? nodeRequire('path') : null;
const urlMod = isElectron ? nodeRequire('url') : null;
const electron = isElectron ? nodeRequire('electron') : null;

export const extOf = name => (String(name).match(/\.([^./\\]+)$/) || [, ''])[1].toLowerCase();
export const baseName = p => String(p).split(/[\\/]/).pop();
export const stripExt = n => String(n).replace(/\.[^./\\]+$/, '');

export const MODEL_EXT = ['fbx', 'glb', 'gltf', 'obj'];
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'tga', 'webp', 'bmp', 'gif'];
export const HDR_EXT = ['hdr', 'exr'];

// ---- FileRef ----
function fromPath(p) {
  const name = baseName(p);
  return {
    name, ext: extOf(name), path: p,
    dir: nodePath.dirname(p),
    url: () => urlMod.pathToFileURL(p).href,
    arrayBuffer: async () => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    text: async () => fs.readFileSync(p, 'utf-8'),
  };
}

const blobUrls = new Map();
function fromFile(file, relPath) {
  const name = file.name;
  return {
    name, ext: extOf(name), file, relPath: relPath || file.webkitRelativePath || name,
    url: () => { if (!blobUrls.has(file)) blobUrls.set(file, URL.createObjectURL(file)); return blobUrls.get(file); },
    arrayBuffer: () => file.arrayBuffer(),
    text: () => file.text(),
  };
}

export function refFromPath(p) { return fromPath(p); }

// Fetchable URL (used in the browser for bundled samples).
export function refFromUrl(url) {
  const name = decodeURIComponent(baseName(url.split('?')[0]));
  return {
    name, ext: extOf(name), remote: url,
    url: () => url,
    arrayBuffer: async () => (await fetch(url)).arrayBuffer(),
    text: async () => (await fetch(url)).text(),
  };
}

// ---- siblings: other files near a model (textures next to it or in a textures folder) ----
const TEX_DIRS = ['textures', 'texture', 'tex', 'maps', 'map', 'images', 'sourceimages', 'materials'];

export function siblingFiles(ref, pool) {
  if (ref.path) {
    const out = [];
    const scan = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = nodePath.join(dir, e.name);
        if (e.isFile()) out.push(fromPath(full));
        else if (e.isDirectory() && depth > 0 && TEX_DIRS.includes(e.name.toLowerCase())) scan(full, depth - 1);
      }
    };
    scan(ref.dir, 1);
    return out;
  }
  return pool ? pool.filter(r => r !== ref) : [];
}

// Every file inside a folder (recursive, capped) — used when a texture folder is dropped/opened.
export function filesInDir(dir, max = 400) {
  const out = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = nodePath.join(d, e.name);
      if (e.isFile()) out.push(fromPath(full));
      else if (e.isDirectory() && depth > 0) walk(full, depth - 1);
    }
  };
  walk(dir, 3);
  return out;
}

// Resolve a texture path written inside a model file (often an absolute path from the artist's
// machine) to a file that actually exists here. Returns a URL or null.
export function resolveResource(requestUrl, modelRef, pool) {
  const raw = decodeURIComponent(String(requestUrl).replace(/^file:\/\/\/?/, '').split('?')[0]);
  const name = baseName(raw).toLowerCase();
  if (modelRef && modelRef.path) {
    if (/^(blob:|data:)/.test(requestUrl)) return requestUrl;
    const direct = /^[a-zA-Z]:[\\/]|^\//.test(raw) ? raw : null;
    if (direct && fs.existsSync(direct)) return urlMod.pathToFileURL(direct).href;
    const hit = siblingFiles(modelRef).find(r => r.name.toLowerCase() === name);
    return hit ? hit.url() : null;
  }
  if (/^(blob:|data:)/.test(requestUrl)) return requestUrl;
  const hit = (pool || []).find(r => r.name.toLowerCase() === name);
  if (hit) return hit.url();
  if (modelRef && modelRef.remote) return requestUrl; // bundled sample over http
  return null;
}

// ---- drag & drop ----
// Returns { files: FileRef[], dirs: string[] (Electron folder paths) }.
export async function refsFromDrop(dataTransfer) {
  const files = [], dirs = [];
  if (isElectron) {
    const { webUtils } = electron;
    for (const f of dataTransfer.files) {
      const p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : f.path;
      if (!p) continue;
      let st = null;
      try { st = fs.statSync(p); } catch (e) { /* ignore */ }
      if (st && st.isDirectory()) dirs.push(p); else files.push(fromPath(p));
    }
    return { files, dirs };
  }
  // Browser: walk dropped folders through the entries API.
  const entries = [...dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  const readEntry = entry => new Promise(resolve => {
    if (entry.isFile) entry.file(f => { files.push(fromFile(f, entry.fullPath.slice(1))); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const more = () => reader.readEntries(async batch => {
        if (!batch.length) { for (const e of all) await readEntry(e); resolve(); return; }
        all.push(...batch); more();
      }, () => resolve());
      more();
    } else resolve();
  });
  if (entries.length) { for (const e of entries) await readEntry(e); }
  else for (const f of dataTransfer.files) files.push(fromFile(f));
  return { files, dirs };
}

// ---- dialogs ----
const ipc = isElectron ? electron.ipcRenderer : null;

export async function openFiles({ title, filters, multi = false, folder = false } = {}) {
  if (isElectron) {
    const props = [folder ? 'openDirectory' : 'openFile'];
    if (multi) props.push('multiSelections');
    const paths = await ipc.invoke('open-dialog', { title, properties: props, filters });
    if (folder) return { files: [], dirs: paths };
    return { files: paths.map(fromPath), dirs: [] };
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multi || folder;
    if (folder) input.webkitdirectory = true;
    if (filters && !folder) input.accept = filters.flatMap(f => f.extensions.map(e => '.' + e)).join(',');
    input.onchange = () => resolve({ files: [...input.files].map(f => fromFile(f)), dirs: [] });
    input.click();
  });
}

export async function saveBlob(blob, defaultName, filters) {
  if (isElectron) {
    const target = await ipc.invoke('save-dialog', { defaultPath: defaultName, filters });
    if (!target) return null;
    fs.writeFileSync(target, Buffer.from(await blob.arrayBuffer()));
    return target;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = baseName(defaultName);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return a.download;
}

export function showInFolder(p) { if (isElectron) ipc.invoke('show-in-folder', p); }

export async function appPaths() {
  if (isElectron) return ipc.invoke('app-paths');
  return { samples: '../samples', hdri: '../hdri', pictures: '', videos: '' };
}

export async function launchFile() {
  if (!isElectron) return null;
  const p = await ipc.invoke('launch-file');
  return p ? fromPath(p) : null;
}

export function joinPath(...parts) {
  return isElectron ? nodePath.join(...parts) : parts.join('/');
}

export function sampleRef(paths, rel) {
  const p = joinPath(paths.samples, rel);
  return isElectron ? fromPath(p) : refFromUrl(p);
}

export function hdriRef(paths, file) {
  const p = joinPath(paths.hdri, file);
  return isElectron ? fromPath(p) : refFromUrl(p);
}

export function existsPath(p) { return isElectron ? fs.existsSync(p) : true; }
