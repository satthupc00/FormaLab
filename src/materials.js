// PBR material handling: converting loaded materials to MeshStandardMaterial, texture slots,
// loading textures, and auto-assigning textures by file name (Substance / Unreal / Unity style).
import * as THREE from 'three';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { stripExt, IMAGE_EXT } from './platform.js';

// Order = order of the slot grid in the material panel.
export const SLOTS = [
  { key: 'map', label: 'Base Color', srgb: true },
  { key: 'normalMap', label: 'Normal' },
  { key: 'orm', label: 'ORM (gộp)', packed: true },
  { key: 'roughnessMap', label: 'Roughness', ch: 'G' },
  { key: 'metalnessMap', label: 'Metallic', ch: 'B' },
  { key: 'aoMap', label: 'AO', ch: 'R' },
  { key: 'emissiveMap', label: 'Emissive', srgb: true },
  { key: 'alphaMap', label: 'Opacity' },
  { key: 'bumpMap', label: 'Height' },
];

// Suffix keywords -> slot. Longer keywords are tried first; one-letter ones need a separator.
const KEYWORDS = [
  ['occlusionroughnessmetallic', 'orm'], ['ambientocclusion', 'aoMap'], ['basecolor', 'map'], ['albedotransparency', 'map'],
  ['normaldirectx', 'normalMap'], ['normalopengl', 'normalMap'], ['displacement', 'bumpMap'], ['transparency', 'alphaMap'],
  ['metallicsmoothness', null], ['metalness', 'metalnessMap'], ['roughness', 'roughnessMap'], ['occlusion', 'aoMap'],
  ['emissive', 'emissiveMap'], ['emission', 'emissiveMap'], ['metallic', 'metalnessMap'], ['diffuse', 'map'],
  ['opacity', 'alphaMap'], ['albedo', 'map'], ['normal', 'normalMap'], ['height', 'bumpMap'], ['color', 'map'],
  ['colour', 'map'], ['rough', 'roughnessMap'], ['metal', 'metalnessMap'], ['alpha', 'alphaMap'], ['bump', 'bumpMap'],
  ['emit', 'emissiveMap'], ['glow', 'emissiveMap'], ['diff', 'map'], ['disp', 'bumpMap'], ['nrm', 'normalMap'],
  ['nor', 'normalMap'], ['orm', 'orm'], ['arm', 'orm'], ['rma', null], ['col', 'map'], ['ao', 'aoMap'], ['bc', 'map'],
  ['n', 'normalMap'], ['d', 'map'], ['r', 'roughnessMap'], ['m', 'metalnessMap'], ['e', 'emissiveMap'], ['h', 'bumpMap'],
];

// "MonBot_BaseColor.png" -> { slot: 'map', prefix: 'monbot', directx: false }
export function classifyTexture(fileName) {
  const raw = stripExt(fileName);
  const lower = raw.toLowerCase();
  const directx = /directx|_dx\b|[-_ ]dx$/.test(lower);
  const parts = lower.split(/[\s._-]+/).filter(Boolean);
  for (let take = Math.min(3, parts.length - 1); take >= 1; take--) {
    const tail = parts.slice(-take).join('');
    const hit = KEYWORDS.find(([k]) => k === tail);
    if (hit) {
      if (!hit[1]) return null;
      return { slot: hit[1], prefix: parts.slice(0, -take).join(''), directx };
    }
  }
  // no separator before the keyword, e.g. "monbotbasecolor"
  const joined = parts.join('');
  for (const [k, slot] of KEYWORDS) {
    if (k.length >= 5 && joined.endsWith(k) && joined.length > k.length) {
      return slot ? { slot, prefix: joined.slice(0, -k.length), directx } : null;
    }
  }
  return null;
}

const norm = s => String(s || '').toLowerCase().replace(/^(mat|mtl|mi|m|t|tex)[_\s-]+/, '').replace(/[^a-z0-9]/g, '').replace(/(mat|mtl|material)$/, '');

function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.5 + 0.5;
  let best = 0; // longest common substring
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0;
    while (a[i + k] && a[i + k] === b[j + k]) k++;
    if (k > best) best = k;
  }
  return best / Math.max(a.length, b.length);
}

// Plan which texture files go where. materials: [{ material, names: [material name, mesh names...] }]
// Returns [{ material, slot, ref, directx }]
export function planAutoAssign(materials, refs) {
  const tex = refs.filter(r => IMAGE_EXT.includes(r.ext)).map(r => ({ ref: r, info: classifyTexture(r.name) })).filter(t => t.info);
  if (!tex.length || !materials.length) return [];
  const groups = new Map();
  for (const t of tex) {
    const key = t.info.prefix;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const plan = [];
  const pushGroup = (material, list) => {
    for (const t of list) plan.push({ material, slot: t.info.slot, ref: t.ref, directx: t.info.directx });
  };
  if (groups.size === 1) {
    const list = [...groups.values()][0];
    for (const m of materials) pushGroup(m.material, list);
    return plan;
  }
  for (const m of materials) {
    let best = null, bestScore = 0;
    for (const [prefix, list] of groups) {
      const score = Math.max(...m.names.map(n => similarity(n, prefix)));
      if (score > bestScore) { bestScore = score; best = list; }
    }
    if (best && bestScore >= 0.45) pushGroup(m.material, best);
  }
  // A single material and several sets: take the set with most files.
  if (!plan.length && materials.length === 1) {
    const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    pushGroup(materials[0].material, biggest);
  }
  return plan;
}

// ---- loading ----
const texLoader = new THREE.TextureLoader();
const tgaLoader = new TGALoader();
const cache = new Map();

export function loadTexture(ref) {
  const url = ref.url();
  if (cache.has(url)) return cache.get(url);
  const loader = ref.ext === 'tga' ? tgaLoader : texLoader;
  const p = new Promise((resolve, reject) => {
    loader.load(url, tex => {
      tex.name = ref.name;
      tex.userData.fileName = ref.name;
      tex.userData.ref = ref;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 8;
      resolve(tex);
    }, undefined, () => reject(new Error('Không đọc được ảnh ' + ref.name)));
  });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

// Fresh texture object per slot so colour space / flip settings don't fight between slots.
function forSlot(tex, slotKey, flipY) {
  const t = tex.clone();
  t.colorSpace = slotKey === 'map' || slotKey === 'emissiveMap' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (flipY !== undefined) t.flipY = flipY;
  t.needsUpdate = true;
  return t;
}

// ---- material conversion ----
export function toStandard(src) {
  if (src.isMeshStandardMaterial) {
    src.userData.formalab = src.userData.formalab || {};
    return src;
  }
  const m = new THREE.MeshStandardMaterial({
    name: src.name,
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    map: src.map || null,
    normalMap: src.normalMap || null,
    aoMap: src.aoMap || null,
    bumpMap: src.bumpMap || null,
    bumpScale: src.bumpScale !== undefined ? src.bumpScale : 1,
    alphaMap: src.alphaMap || null,
    emissive: src.emissive ? src.emissive.clone() : new THREE.Color(0, 0, 0),
    emissiveMap: src.emissiveMap || null,
    transparent: !!src.transparent,
    opacity: src.opacity !== undefined ? src.opacity : 1,
    side: src.side,
    vertexColors: !!src.vertexColors,
    alphaTest: src.alphaTest || 0,
    roughness: src.shininess !== undefined ? THREE.MathUtils.clamp(1 - Math.sqrt(src.shininess / 100), 0.25, 0.9) : 0.6,
    metalness: 0,
  });
  if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
  if (m.emissiveMap) {
    m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
    if (m.emissive.getHex() === 0) m.emissive.setRGB(1, 1, 1);
  }
  // FBX phong exports often carry a near-white diffuse with a texture; keep it white so the map shows true colours.
  if (m.map && m.color.r + m.color.g + m.color.b > 2.4) m.color.setRGB(1, 1, 1);
  if (m.normalMap) m.normalMap.colorSpace = THREE.NoColorSpace;
  m.userData.formalab = { from: src.type };
  src.dispose();
  return m;
}

// Assign a texture (or null to clear) to a slot. 'orm' fills AO/Roughness/Metallic at once.
export async function assignSlot(material, slotKey, ref, opts = {}) {
  const fl = material.userData.formalab || (material.userData.formalab = {});
  fl.files = fl.files || {};
  const keys = slotKey === 'orm' ? ['aoMap', 'roughnessMap', 'metalnessMap'] : [slotKey];
  if (!ref) {
    for (const k of keys) { material[k] = null; delete fl.files[k]; }
    if (slotKey === 'orm' || keys.some(k => fl.packed === k)) fl.packed = null;
    if (slotKey === 'orm') fl.orm = null;
    if (slotKey === 'emissiveMap') material.emissive.setRGB(0, 0, 0);
    if (slotKey === 'alphaMap') material.transparent = false;
    material.needsUpdate = true;
    return;
  }
  const tex = await loadTexture(ref);
  const flipY = material.map ? material.map.flipY : (opts.flipY !== undefined ? opts.flipY : true);
  if (slotKey === 'orm') {
    const t = forSlot(tex, 'aoMap', flipY);
    material.aoMap = t; material.roughnessMap = t; material.metalnessMap = t;
    material.roughness = 1; material.metalness = 1;
    fl.orm = ref.name;
    for (const k of keys) fl.files[k] = ref.name;
  } else {
    material[slotKey] = forSlot(tex, slotKey, flipY);
    fl.files[slotKey] = ref.name;
    if (slotKey === 'roughnessMap' || slotKey === 'metalnessMap' || slotKey === 'aoMap') {
      if (fl.orm) { fl.orm = null; }
      if (slotKey === 'roughnessMap') material.roughness = 1;
      if (slotKey === 'metalnessMap') material.metalness = 1;
    }
    if (slotKey === 'emissiveMap' && material.emissive.getHex() === 0) material.emissive.setRGB(1, 1, 1);
    if (slotKey === 'alphaMap') { material.transparent = true; material.alphaTest = 0; }
    if (slotKey === 'normalMap' && opts.directx !== undefined) setNormalDirectX(material, opts.directx);
    if (slotKey === 'map' && material.color.r + material.color.g + material.color.b > 2.4) material.color.setRGB(1, 1, 1);
  }
  material.needsUpdate = true;
}

export function setNormalDirectX(material, dx) {
  const fl = material.userData.formalab || (material.userData.formalab = {});
  fl.directx = !!dx;
  material.normalScale.y = Math.abs(material.normalScale.y) * (dx ? -1 : 1);
}

// Describe a slot for the UI: { file, thumbTex, note }
export function slotInfo(material, slot) {
  const fl = material.userData.formalab || {};
  if (slot.key === 'orm') {
    return fl.orm ? { file: fl.orm, tex: material.aoMap } : { file: null };
  }
  const tex = material[slot.key];
  if (!tex) return { file: null };
  const file = (fl.files && fl.files[slot.key]) || tex.userData.fileName || tex.name || (tex.image && tex.image.src ? decodeURIComponent(tex.image.src.split('/').pop()) : 'Texture trong file');
  if (fl.orm && slot.ch) return { file: fl.orm, tex, note: `từ ORM (${slot.ch})` };
  return { file, tex };
}

// Small preview image (data URL) of a texture.
const thumbCache = new WeakMap();
export function thumbOf(tex, channel) {
  const img = tex && tex.image;
  if (!img) return null;
  const key = channel || 'rgb';
  const per = thumbCache.get(img) || {};
  if (per[key]) return per[key];
  const c = document.createElement('canvas');
  c.width = c.height = 56;
  const g = c.getContext('2d');
  try {
    if (img.data && img.width) { // DataTexture (TGA)
      const tmp = document.createElement('canvas');
      tmp.width = img.width; tmp.height = img.height;
      const id = tmp.getContext('2d').createImageData(img.width, img.height);
      id.data.set(img.data.length === id.data.length ? img.data : new Uint8ClampedArray(id.data.length).fill(255));
      tmp.getContext('2d').putImageData(id, 0, 0);
      g.drawImage(tmp, 0, 0, 56, 56);
    } else g.drawImage(img, 0, 0, 56, 56);
    if (channel) {
      const d = g.getImageData(0, 0, 56, 56);
      const idx = { R: 0, G: 1, B: 2 }[channel];
      for (let i = 0; i < d.data.length; i += 4) { const v = d.data[i + idx]; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; }
      g.putImageData(d, 0, 0);
    }
  } catch (e) { return null; }
  per[key] = c.toDataURL();
  thumbCache.set(img, per);
  return per[key];
}
