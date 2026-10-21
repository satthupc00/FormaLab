// FormaLab renderer: wires the panels, timeline and dialogs to the Viewer.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Viewer } from './viewer.js';
import { loadModel } from './loaders.js';
import { SLOTS, planAutoAssign, assignSlot, slotInfo, thumbOf, setNormalDirectX, classifyTexture } from './materials.js';
import * as P from './platform.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FPS = 30;

// ---------------------------------------------------------------- settings (per machine)
const settings = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem('formalab.settings') || '{}'); } catch (e) { data = {}; }
  return {
    get: (k, d) => (data[k] !== undefined ? data[k] : d),
    set: (k, v) => { data[k] = v; try { localStorage.setItem('formalab.settings', JSON.stringify(data)); } catch (e) { /* ignore */ } },
  };
})();

// ---------------------------------------------------------------- toast / busy
const toastEl = $('#toast');
let toastTimer = null;
function toast(msg, action) {
  toastEl.innerHTML = esc(msg) + (action ? ` <a>${esc(action.label)}</a>` : '');
  toastEl.classList.toggle('clickable', !!action);
  if (action) toastEl.querySelector('a').onclick = action.run;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), action ? 5000 : 2600);
}
window.toast = toast;

const busy = {
  show(text, { progress = false, cancel = null } = {}) {
    $('#busyText').textContent = text;
    $('#busyProg').hidden = !progress;
    $('#busyProg i').style.width = '0%';
    $('#busyCancel').hidden = !cancel;
    $('#busyCancel').onclick = cancel;
    $('#busy').hidden = false;
  },
  progress(p) { $('#busyProg i').style.width = Math.round(p * 100) + '%'; },
  hide() { $('#busy').hidden = true; },
};

// ---------------------------------------------------------------- viewer
const viewer = new Viewer($('#vp'), $('#stage'));
const state = { ref: null, flipY: true, meshes: [], mats: [], matIndex: -1, paths: null, textureCount: 0 };

// ---------------------------------------------------------------- slider fill (m-skill §9)
(function tick() {
  for (const r of document.querySelectorAll('input[type=range]')) {
    const p = ((r.value - (r.min || 0)) / ((r.max || 100) - (r.min || 0))) * 100;
    r.style.setProperty('--fill', p + '%');
  }
  requestAnimationFrame(tick);
})();

// range + value label helper
function bindRange(el, fmt, onInput) {
  const out = el.nextElementSibling;
  const show = () => { if (out && out.classList.contains('val')) out.textContent = fmt(+el.value); };
  el.addEventListener('input', () => { show(); onInput(+el.value); });
  show();
  return show;
}

// ---------------------------------------------------------------- tabs
const tabs = $$('.tab');
function moveBar(tb) { $('#tabBar').style.left = tb.offsetLeft + 'px'; $('#tabBar').style.width = tb.offsetWidth + 'px'; }
tabs.forEach(tb => tb.addEventListener('click', () => {
  tabs.forEach(x => x.classList.toggle('on', x === tb));
  moveBar(tb);
  $$('.pane').forEach(p => p.classList.toggle('on', p.id === tb.dataset.p));
  settings.set('tab', tb.dataset.p);
}));
requestAnimationFrame(() => {
  const saved = tabs.find(t => t.dataset.p === settings.get('tab'));
  (saved || tabs[0]).click();
});

// ================================================================= model loading
const fmtNum = n => n.toLocaleString('en-US');

async function openModel(ref, { pool = [], preloaded = null } = {}) {
  busy.show(`Đang mở ${ref.name}…`);
  try {
    const res = preloaded || await loadModel(ref, { pool, renderer: viewer.renderer });
    state.ref = ref;
    state.flipY = res.flipY;
    state.pool = pool;
    state.meshes = viewer.setModel(res.object, res.clips, { name: P.stripExt(ref.name), zUp: res.zUp });
    $('#ckZup').checked = res.zUp;

    // textures next to the model fill the PBR slots the file left empty
    const assigned = await autoAssign(P.siblingFiles(ref, pool), false);
    // animations named like the model: Hero@Run.fbx, Hero_Anim_Run.fbx
    const animCount = await autoAnimations(ref, pool);

    afterModelChange();
    const clipIdx = viewer.clips.length ? 0 : -1;
    selectClip(clipIdx);
    $('#empty').hidden = true;
    const notes = [];
    if (assigned) notes.push(`tự gán ${assigned} texture`);
    if (animCount) notes.push(`nạp ${animCount} animation đi kèm`);
    if (res.missing.length) {
      toast(`Thiếu ${res.missing.length} texture: ${res.missing.slice(0, 3).join(', ')}${res.missing.length > 3 ? '…' : ''}. Thả thư mục texture vào để gán.`);
    } else toast(`Đã mở ${ref.name}${notes.length ? ' · ' + notes.join(', ') : ''}`);
    return true;
  } catch (e) {
    console.error(e);
    toast(`Không mở được ${ref.name}: ${e.message || e}`);
    return false;
  } finally {
    busy.hide();
  }
}

async function autoAnimations(ref, pool) {
  const base = P.stripExt(ref.name).toLowerCase();
  const files = P.siblingFiles(ref, pool).filter(r => ['fbx', 'glb', 'gltf'].includes(r.ext) && r.name !== ref.name)
    .filter(r => { const n = r.name.toLowerCase(); return n.startsWith(base + '@') || n.startsWith(base + '_anim') || n.startsWith(base + '-anim'); });
  let n = 0;
  for (const f of files.slice(0, 30)) {
    try {
      const res = await loadModel(f, { pool, renderer: viewer.renderer });
      for (const c of res.clips) if (viewer.addClip(c, clipSourceName(f.name))) n++;
    } catch (e) { /* skip unreadable */ }
  }
  return n;
}

const clipSourceName = name => P.stripExt(name).replace(/^.*?(@|_anim_?|-anim-?)/i, '') || P.stripExt(name);

// plan + apply texture auto-assignment. overwrite=false only fills empty slots.
async function autoAssign(refs, overwrite) {
  const mats = viewer.materials();
  const plan = planAutoAssign(mats, refs);
  let count = 0;
  const used = new Set();
  for (const p of plan) {
    const m = p.material;
    const empty = p.slot === 'orm' ? !m.aoMap && !m.roughnessMap && !m.metalnessMap : !m[p.slot];
    if (!overwrite && !empty) continue;
    try {
      await assignSlot(m, p.slot, p.ref, { flipY: state.flipY, directx: p.directx });
      used.add(p.ref.name);
      count++;
    } catch (e) { console.warn(e); }
  }
  state.textureCount = countTextures();
  return used.size ? used.size : count;
}

function countTextures() {
  const files = new Set();
  for (const e of viewer.materials()) {
    for (const s of SLOTS) { const t = e.material[s.key]; if (t && t.isTexture) files.add(t.image || t.uuid); }
  }
  return files.size;
}

function afterModelChange() {
  state.mats = viewer.materials();
  state.matIndex = state.mats.length ? 0 : -1;
  state.textureCount = countTextures();
  renderTree();
  renderMatSelect();
  renderMaterial();
  renderClips();
  renderStats();
  ['#animBtn', '#shotBtn', '#shot2', '#turnBtn'].forEach(s => { $(s).disabled = false; });
  updateSafe();
}

function renderStats() {
  const s = viewer.stats();
  $('#stTris').textContent = fmtNum(s.tris);
  $('#stVerts').textContent = fmtNum(s.verts);
  $('#stBones').textContent = fmtNum(s.bones);
  $('#stMats').textContent = s.materials.size;
  const anims = viewer.clips.length;
  $('#fileInfo').innerHTML = state.ref
    ? `<b>${esc(state.ref.name)}</b> · ${anims} animation · ${state.textureCount} texture`
    : 'Chưa mở model';
  $('#fileInfo').title = state.ref ? (state.ref.path || state.ref.name) : '';
  $('#sceneCount').textContent = s.meshes ? `${s.meshes} mesh` : '';
}

// ---------------------------------------------------------------- scene tree
function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  if (!viewer.model) { tree.innerHTML = '<div class="empty-note">Chưa có model</div>'; return; }
  const s = viewer.stats();
  const root = document.createElement('div');
  root.className = 'list-item';
  root.innerHTML = `<svg class="i k"><use href="#ic-box"/></svg><span class="nm">${esc(state.ref ? P.stripExt(state.ref.name) : 'Model')}</span><small>${fmtNum(s.tris)}</small>`;
  root.onclick = () => selectMesh(null);
  tree.append(root);
  const meshes = state.meshes.slice(0, 400);
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const tris = Math.round((g.index ? g.index.count : g.attributes.position.count) / 3);
    const it = document.createElement('div');
    it.className = 'list-item child';
    it.innerHTML = `<svg class="i k"><use href="#ic-mesh"/></svg><span class="nm" title="${esc(mesh.name || 'Mesh')}">${esc(mesh.name || 'Mesh')}</span><small>${fmtNum(tris)}</small>
      <button class="ibtn sm" title="Ẩn / hiện"><svg class="i"><use href="#ic-eye"/></svg></button>`;
    it.querySelector('button').onclick = e => {
      e.stopPropagation();
      mesh.visible = !mesh.visible;
      it.classList.toggle('off', !mesh.visible);
      it.querySelector('use').setAttribute('href', mesh.visible ? '#ic-eye' : '#ic-eye-off');
    };
    it.onclick = () => selectMesh(mesh);
    it._mesh = mesh;
    tree.append(it);
  }
  if (state.meshes.length > meshes.length) {
    const more = document.createElement('div');
    more.className = 'empty-note';
    more.textContent = `… và ${state.meshes.length - meshes.length} mesh nữa`;
    tree.append(more);
  }
  if (s.bones) {
    const it = document.createElement('div');
    it.className = 'list-item child';
    it.innerHTML = `<svg class="i k"><use href="#ic-bone"/></svg><span class="nm">Skeleton</span><small>${s.bones} xương</small>`;
    it.onclick = () => $('#bonesBtn').click();
    tree.append(it);
  }
}

function selectMesh(mesh) {
  viewer.select(mesh);
  for (const it of $$('#tree .list-item')) it.classList.toggle('sel', !!mesh && it._mesh === mesh);
  if (mesh) {
    const m = [].concat(mesh.userData.originalMaterial || mesh.material)[0];
    const idx = state.mats.findIndex(e => e.material === m);
    if (idx >= 0) { state.matIndex = idx; $('#matSelect').value = idx; renderMaterial(); }
    const row = $$('#tree .list-item').find(it => it._mesh === mesh);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- material panel
const matPreview = (() => {
  const canvas = $('#matCanvas');
  let r = null, scene, cam, ball;
  const init = () => {
    r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.toneMapping = THREE.ACESFilmicToneMapping;
    scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    scene.environment = pm.fromScene(new RoomEnvironment(r), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-2, 3, 3); scene.add(key);
    cam = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    cam.position.set(0, 0, 4.6);
    const geo = new THREE.SphereGeometry(1, 96, 48);
    geo.setAttribute('uv1', geo.attributes.uv);
    ball = new THREE.Mesh(geo);
    scene.add(ball);
  };
  let pending = false;
  return {
    draw(material) {
      if (!r) init();
      ball.material = material || new THREE.MeshStandardMaterial({ color: 0x555a63 });
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const w = canvas.clientWidth || 230, h = canvas.clientHeight || 96;
        r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        r.setSize(w, h, false);
        cam.aspect = w / h; cam.updateProjectionMatrix();
        ball.position.x = w / h > 1.6 ? 0.9 : 0;
        r.render(scene, cam);
      });
    },
  };
})();

const curMat = () => (state.matIndex >= 0 && state.mats[state.matIndex] ? state.mats[state.matIndex].material : null);

function renderMatSelect() {
  const sel = $('#matSelect');
  sel.innerHTML = '';
  if (!state.mats.length) { sel.innerHTML = '<option>—</option>'; sel.disabled = true; return; }
  state.mats.forEach((e, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = (e.material.name || `Material ${i + 1}`) + (e.meshes.length > 1 ? `  (${e.meshes.length} mesh)` : '');
    sel.append(o);
  });
  sel.disabled = false;
  sel.value = state.matIndex;
}
$('#matSelect').addEventListener('change', e => { state.matIndex = +e.target.value; renderMaterial(); });

let paramShows = [];
function renderMaterial() {
  const m = curMat();
  $('#matName').textContent = m ? (m.name || 'Material') : 'Chưa có material';
  $('#matTag').textContent = m ? 'PBR' : '';
  matPreview.draw(m);
  const slots = $('#slots');
  slots.innerHTML = '';
  $('#matParams').hidden = !m;
  if (!m) return;
  for (const slot of SLOTS) {
    const info = slotInfo(m, slot);
    const el = document.createElement('div');
    el.className = 'slot';
    el.title = `${slot.label} — bấm để chọn ảnh, hoặc kéo thả ảnh vào đây`;
    const thumb = info.file ? thumbOf(info.tex, info.note ? slot.ch : null) : null;
    el.innerHTML = `<i class="th${info.file ? '' : ' empty'}"${thumb ? ` style="background-image:url(${thumb})"` : ''}></i>
      <div class="tx"><b>${slot.label}</b><em>${esc(info.note || info.file || 'Trống')}</em></div>
      ${info.file ? '<button class="x" title="Bỏ texture">✕</button>' : ''}`;
    if (info.file) el.title = `${slot.label}: ${info.file}`;
    el.onclick = async () => {
      const { files } = await P.openFiles({ title: `Chọn ảnh cho ${slot.label}`, filters: [{ name: 'Ảnh', extensions: P.IMAGE_EXT }] });
      if (files[0]) setSlot(m, slot, files[0]);
    };
    const x = el.querySelector('.x');
    if (x) x.onclick = async e => { e.stopPropagation(); await assignSlot(m, slot.key, null); afterMaterialEdit(); };
    el.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('drop'); });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation();
      el.classList.remove('drop');
      dragDepth = 0; $('#drop').classList.remove('on');
      const { files } = await P.refsFromDrop(e.dataTransfer);
      const img = files.find(f => P.IMAGE_EXT.includes(f.ext));
      if (img) setSlot(m, slot, img); else toast('Hãy thả 1 file ảnh (png, jpg, tga…)');
    });
    slots.append(el);
  }
  // parameters
  $('#mColor').value = '#' + m.color.getHexString();
  $('#mRough').value = m.roughness;
  $('#mMetal').value = m.metalness;
  $('#mNormal').value = Math.abs(m.normalScale.x);
  $('#mEmis').value = m.emissiveIntensity;
  $('#mBump').value = m.bumpScale;
  $('#mDX').checked = !!(m.userData.formalab && m.userData.formalab.directx);
  $('#mDouble').checked = m.side === THREE.DoubleSide;
  paramShows.forEach(f => f());
}

async function setSlot(m, slot, ref) {
  try {
    const info = classifyTexture(ref.name);
    await assignSlot(m, slot.key, ref, { flipY: state.flipY, directx: slot.key === 'normalMap' && info ? info.directx : undefined });
    afterMaterialEdit();
    toast(`${slot.label}: ${ref.name}`);
  } catch (e) { toast(e.message); }
}

function afterMaterialEdit() {
  for (const e of state.mats) delete e.material.userData.viewCache;
  viewer.setViewMode(viewer.viewMode, viewer.channel);
  state.textureCount = countTextures();
  renderMaterial();
  renderStats();
}

const matParam = (id, fmt, apply) => paramShows.push(bindRange($(id), fmt, v => { const m = curMat(); if (m) { apply(m, v); matPreview.draw(m); } }));
matParam('#mRough', v => v.toFixed(2), (m, v) => { m.roughness = v; });
matParam('#mMetal', v => v.toFixed(2), (m, v) => { m.metalness = v; });
matParam('#mNormal', v => v.toFixed(2), (m, v) => { const dx = m.normalScale.y < 0; m.normalScale.set(v, dx ? -v : v); });
matParam('#mEmis', v => v.toFixed(1), (m, v) => { m.emissiveIntensity = v; });
matParam('#mBump', v => v.toFixed(2), (m, v) => { m.bumpScale = v; });
$('#mColor').addEventListener('input', e => { const m = curMat(); if (m) { m.color.set(e.target.value); matPreview.draw(m); } });
$('#mDX').addEventListener('change', e => { const m = curMat(); if (m) { setNormalDirectX(m, e.target.checked); matPreview.draw(m); } });
$('#mDouble').addEventListener('change', e => {
  const m = curMat();
  if (m) { m.side = e.target.checked ? THREE.DoubleSide : THREE.FrontSide; m.needsUpdate = true; matPreview.draw(m); }
});

$('#ckZup').addEventListener('change', e => viewer.setZUp(e.target.checked));

// ================================================================= animation
function renderClips() {
  const sel = $('#clipSel');
  sel.innerHTML = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.append(o); };
  if (!viewer.clips.length) add(-1, viewer.model ? 'Không có animation' : 'Chưa có model');
  else add(-1, '— Tư thế gốc (bind pose)');
  viewer.clips.forEach((c, i) => add(i, `${c.name}  · ${c.clip.duration.toFixed(2)}s`));
  $('#timeline').classList.toggle('disabled', !viewer.clips.length);
}

function selectClip(i) {
  $('#clipSel').value = i;
  viewer.playClip(i);
  setPlayIcon(viewer.playing && i >= 0);
  $('#timeline').classList.toggle('disabled', i < 0 && !viewer.clips.length);
}
$('#clipSel').addEventListener('change', e => selectClip(+e.target.value));

function setPlayIcon(playing) { $('#playIco').innerHTML = `<use href="#ic-${playing ? 'pause' : 'play'}"/>`; }
viewer.onPlayState = p => setPlayIcon(p);
$('#playBtn').onclick = () => setPlayIcon(viewer.togglePlay());
const stepFrame = d => {
  if (!viewer.action) return;
  if (viewer.playing) setPlayIcon(viewer.togglePlay());
  viewer.seek(Math.round(viewer.time * FPS + d) / FPS);
};
$('#prevBtn').onclick = () => stepFrame(-1);
$('#nextBtn').onclick = () => stepFrame(1);
$('#startBtn').onclick = () => viewer.seek(0);
$('#speedSel').addEventListener('change', e => { viewer.speed = +e.target.value; });
$('#loopBtn').onclick = () => { const on = !$('#loopBtn').classList.contains('on'); $('#loopBtn').classList.toggle('on', on); viewer.setLoop(on); };

let scrubbing = false, wasPlaying = false;
const scrub = $('#scrub');
scrub.addEventListener('pointerdown', () => { scrubbing = true; wasPlaying = viewer.playing; viewer.playing = false; });
scrub.addEventListener('input', () => viewer.seek((scrub.value / 1000) * viewer.duration));
window.addEventListener('pointerup', () => {
  if (!scrubbing) return;
  scrubbing = false;
  viewer.playing = wasPlaying;
  setPlayIcon(viewer.playing && !!viewer.action);
});

viewer.onFrame = () => {
  const d = viewer.duration, t = viewer.time;
  if (!scrubbing) scrub.value = d ? (t / d) * 1000 : 0;
  $('#time').innerHTML = `<b>${t.toFixed(2)}s</b> / ${d.toFixed(2)}s · f ${Math.round(t * FPS)}`;
  if ((viewer._statTick = (viewer._statTick || 0) + 1) % 20 === 0) $('#stFps').textContent = viewer.fps;
};

async function addAnimationFiles(refs, pool = []) {
  if (!viewer.model) { toast('Hãy mở model trước, rồi thêm animation'); return; }
  busy.show('Đang nạp animation…');
  let added = 0, lastIndex = -1;
  const failed = [];
  for (const ref of refs) {
    try {
      const res = await loadModel(ref, { pool, renderer: viewer.renderer });
      if (!res.clips.length) { failed.push(`${ref.name} (không có animation)`); continue; }
      for (const c of res.clips) {
        const e = viewer.addClip(c, clipSourceName(ref.name));
        if (e) { added++; lastIndex = viewer.clips.indexOf(e); } else failed.push(`${ref.name} (tên xương không khớp)`);
      }
    } catch (e) { failed.push(`${ref.name} (${e.message})`); }
  }
  busy.hide();
  renderClips();
  renderStats();
  if (lastIndex >= 0) selectClip(lastIndex);
  if (added && !failed.length) toast(`Đã thêm ${added} animation`);
  else if (added) toast(`Đã thêm ${added} animation · bỏ qua: ${failed.join(', ')}`);
  else toast(`Không thêm được animation: ${failed.join(', ')}`);
}

// ================================================================= lights
const LIGHT_ICON = { directional: '#ic-sun', point: '#ic-bulb', spot: '#ic-spot' };
const LIGHT_TYPE = { directional: 'Directional', point: 'Point', spot: 'Spot' };

function renderLights() {
  const list = $('#lightList');
  list.innerHTML = '';
  for (const item of viewer.lights) {
    const el = document.createElement('div');
    el.className = 'light' + (item.visible ? '' : ' off');
    const max = item.type === 'directional' ? 10 : 100;
    const step = item.type === 'directional' ? 0.1 : 0.5;
    el.innerHTML = `
      <div class="light-h"><svg class="i k"><use href="${LIGHT_ICON[item.type]}"/></svg><span class="nm">${esc(item.name)}</span><small>${LIGHT_TYPE[item.type]}</small><span class="sp"></span>
        <button class="ibtn sm" data-a="eye" title="Ẩn / hiện đèn"><svg class="i"><use href="${item.visible ? '#ic-eye' : '#ic-eye-off'}"/></svg></button>
        <button class="ibtn sm" data-a="del" title="Xoá đèn"><svg class="i"><use href="#ic-trash"/></svg></button></div>
      <div class="row"><label>Cường độ</label><input type="range" data-k="intensity" min="0" max="${max}" step="${step}" value="${item.intensity}"><span class="val"></span></div>
      <div class="row"><label>Màu</label><input type="color" data-k="color" value="#${item.light.color.getHexString()}"><span style="flex:1"></span>
        ${item.type !== 'point' ? `<label class="check" style="margin:0;flex:0 0 auto;color:var(--muted)"><input type="checkbox" data-k="shadow" ${item.castShadow ? 'checked' : ''}>Bóng</label>` : ''}</div>
      <div class="row"><label>Hướng</label><input type="range" data-k="azimuth" min="-180" max="180" value="${((item.azimuth + 180) % 360 + 360) % 360 - 180}"><span class="val"></span></div>
      <div class="row"><label>Độ cao</label><input type="range" data-k="elevation" min="-20" max="90" value="${item.elevation}"><span class="val"></span></div>
      ${item.type === 'spot' ? `<div class="row"><label>Góc chiếu</label><input type="range" data-k="angle" min="5" max="80" value="${Math.round(THREE.MathUtils.radToDeg(item.light.angle))}"><span class="val"></span></div>` : ''}`;
    const fmt = { intensity: v => (item.type === 'directional' ? v.toFixed(1) : v.toFixed(0)), azimuth: v => v + '°', elevation: v => v + '°', angle: v => v + '°' };
    el.querySelectorAll('input[type=range]').forEach(r => bindRange(r, fmt[r.dataset.k], v => {
      if (r.dataset.k === 'angle') item.light.angle = THREE.MathUtils.degToRad(v); else item[r.dataset.k] = v;
      viewer.updateLight(item);
    }));
    el.querySelector('[data-k=color]').addEventListener('input', e => item.light.color.set(e.target.value));
    const sh = el.querySelector('[data-k=shadow]');
    if (sh) sh.addEventListener('change', () => { item.castShadow = sh.checked; viewer.updateLight(item); });
    el.querySelector('[data-a=eye]').onclick = () => { item.visible = !item.visible; viewer.updateLight(item); renderLights(); };
    el.querySelector('[data-a=del]').onclick = () => { viewer.removeLight(item); renderLights(); };
    list.append(el);
  }
  if (!viewer.lights.length) list.innerHTML = '<div class="empty-note" style="padding:0 0 10px">Không có đèn — model chỉ được chiếu bởi HDRI.</div>';
}
$$('[data-add]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.add;
  viewer.addLight(t, { azimuth: Math.round(Math.random() * 300 - 150), elevation: 35, intensity: t === 'directional' ? 1.5 : 25 });
  renderLights();
}));
renderLights();

$('#ckShadow').checked = settings.get('shadows', true);
viewer.setShadows($('#ckShadow').checked);
$('#shadowBtn').classList.toggle('on', $('#ckShadow').checked);
const setShadows = on => {
  viewer.setShadows(on);
  $('#ckShadow').checked = on;
  $('#shadowBtn').classList.toggle('on', on);
  settings.set('shadows', on);
};
$('#ckShadow').addEventListener('change', e => setShadows(e.target.checked));
$('#shadowBtn').onclick = () => setShadows(!viewer.shadows);

const TONE = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, none: THREE.NoToneMapping };
$('#toneSel').value = settings.get('tone', 'aces');
viewer.renderer.toneMapping = TONE[$('#toneSel').value];
$('#toneSel').addEventListener('change', e => {
  viewer.renderer.toneMapping = TONE[e.target.value];
  settings.set('tone', e.target.value);
  for (const m of state.mats) m.material.needsUpdate = true;
});
$('#exposure').value = settings.get('exposure', 1);
viewer.renderer.toneMappingExposure = +$('#exposure').value;
bindRange($('#exposure'), v => v.toFixed(2), v => { viewer.renderer.toneMappingExposure = v; settings.set('exposure', v); });

// ================================================================= environment / HDRI
const HDRI_PRESETS = [
  { id: 'studio', name: 'Studio' },
  { id: 'royal_esplanade', name: 'Quảng trường', file: 'royal_esplanade_1k.hdr' },
  { id: 'venice_sunset', name: 'Hoàng hôn', file: 'venice_sunset_1k.hdr' },
  { id: 'spruit_sunrise', name: 'Bình minh', file: 'spruit_sunrise_1k.hdr' },
  { id: 'quarry_01', name: 'Mỏ đá', file: 'quarry_01_1k.hdr' },
  { id: 'moonless_golf', name: 'Đêm', file: 'moonless_golf_1k.hdr' },
];
const hdris = HDRI_PRESETS.map(p => ({ ...p, tex: null, thumb: null }));
let hdriActive = settings.get('hdri', 'studio');

function hdriThumb(tex) {
  const img = tex.image, W = 160, H = 80;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), out = g.createImageData(W, H);
  const half = img.data instanceof Uint16Array;
  const f = v => (half ? THREE.DataUtils.fromHalfFloat(v) : v);
  const ch = img.data.length / (img.width * img.height);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.floor(x / W * img.width), sy = Math.floor(y / H * img.height);
    const i = (sy * img.width + sx) * ch, o = (y * W + x) * 4;
    for (let k = 0; k < 3; k++) {
      const v = f(img.data[i + k]);
      out.data[o + k] = Math.round(Math.pow(v / (1 + v), 1 / 2.2) * 255);
    }
    out.data[o + 3] = 255;
  }
  g.putImageData(out, 0, 0);
  return c.toDataURL('image/jpeg', 0.8);
}

function renderHdris() {
  const grid = $('#hdriGrid');
  grid.innerHTML = '';
  for (const h of hdris) {
    const el = document.createElement('div');
    el.className = 'hdri' + (h.id === hdriActive ? ' on' : '') + (h.file && !h.thumb ? ' loading' : '');
    el.title = h.name;
    if (h.thumb) el.style.backgroundImage = `url(${h.thumb})`;
    else if (h.id === 'studio') el.style.background = 'linear-gradient(#5d636e,#b9b6af 50%,#6e6a64)';
    el.innerHTML = `<span>${esc(h.name)}</span>`;
    el.onclick = () => activateHdri(h);
    grid.append(el);
  }
  const add = document.createElement('div');
  add.className = 'hdri add';
  add.title = 'Nạp file .hdr / .exr (hoặc kéo thả vào cửa sổ)';
  add.textContent = '+ Nạp HDRI';
  add.onclick = async () => {
    const { files } = await P.openFiles({ title: 'Chọn HDRI', filters: [{ name: 'HDRI', extensions: P.HDR_EXT }] });
    if (files[0]) addHdri(files[0]);
  };
  grid.append(add);
}

async function ensureHdri(h) {
  if (h.tex || !h.ref) return h.tex;
  h.tex = await viewer.loadHDRI(h.ref);
  h.thumb = hdriThumb(h.tex);
  return h.tex;
}

async function activateHdri(h) {
  hdriActive = h.id;
  renderHdris();
  try {
    viewer.setEnvTexture(h.id === 'studio' ? null : await ensureHdri(h));
    if (h.preset) settings.set('hdri', h.id);
  } catch (e) { toast('Không đọc được HDRI: ' + e.message); }
  renderHdris();
}

async function addHdri(ref) {
  const h = { id: 'file:' + (ref.path || ref.name) + ':' + Date.now(), name: P.stripExt(ref.name), ref, tex: null, thumb: null };
  hdris.push(h);
  busy.show('Đang nạp HDRI…');
  try { await activateHdri(h); toast('Đã nạp HDRI ' + ref.name); } catch (e) { toast(e.message); }
  busy.hide();
}

async function initHdris() {
  state.paths = state.paths || await P.appPaths();
  for (const h of hdris) if (h.file) { h.ref = P.hdriRef(state.paths, h.file); h.preset = true; }
  hdris[0].preset = true;
  renderHdris();
  const start = hdris.find(h => h.id === hdriActive) || hdris[0];
  await activateHdri(start);
  // thumbnails for the rest, one by one so the UI stays responsive
  for (const h of hdris) {
    if (h.file && !h.tex) {
      try { await ensureHdri(h); } catch (e) { h.thumb = null; }
      renderHdris();
      await new Promise(r => setTimeout(r, 30));
    }
  }
}

const envCtl = (id, key, fmt, def) => {
  const el = $(id);
  el.value = settings.get('env.' + key, def);
  viewer.env[key] = +el.value;
  bindRange(el, fmt, v => { viewer.env[key] = v; viewer.applyEnv(); settings.set('env.' + key, v); });
};
envCtl('#envRot', 'rotation', v => v + '°', 0);
envCtl('#envInt', 'intensity', v => v.toFixed(2), 1);
envCtl('#envBlur', 'blur', v => v.toFixed(2), 0.25);
$('#ckBg').checked = settings.get('env.show', true);
viewer.env.show = $('#ckBg').checked;
$('#ckBg').addEventListener('change', e => { viewer.env.show = e.target.checked; viewer.applyEnv(); settings.set('env.show', e.target.checked); });
$('#bgColor').value = settings.get('env.color', '#2b2d31');
viewer.env.color.set($('#bgColor').value);
$('#bgColor').addEventListener('input', e => { viewer.env.color.set(e.target.value); viewer.applyEnv(); settings.set('env.color', e.target.value); });
viewer.applyEnv();

// ================================================================= view toolbar
$$('.vtool .seg').forEach(b => b.addEventListener('click', () => {
  $$('.vtool .seg').forEach(x => x.classList.toggle('on', x === b));
  viewer.setViewMode(b.dataset.mode, $('#channelSel').value);
}));
$('#channelSel').addEventListener('change', e => viewer.setViewMode(viewer.viewMode, e.target.value));
$('#gridBtn').onclick = () => { const on = !viewer.grid.visible; viewer.grid.visible = on; $('#gridBtn').classList.toggle('on', on); settings.set('grid', on); };
viewer.grid.visible = settings.get('grid', true);
$('#gridBtn').classList.toggle('on', viewer.grid.visible);
$('#bonesBtn').onclick = () => {
  viewer.showBones = !viewer.showBones;
  $('#bonesBtn').classList.toggle('on', viewer.showBones);
  if (viewer.showBones && !viewer.skeletonHelper) toast('Model này không có xương');
};
$('#fitBtn').onclick = () => viewer.frame(false);

// click to select a mesh in the viewport
let downAt = null;
$('#vp').addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY, b: e.button }; });
$('#vp').addEventListener('pointerup', e => {
  if (!downAt || downAt.b !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) { downAt = null; return; }
  downAt = null;
  if (viewer.model) selectMesh(viewer.pick(e.clientX, e.clientY));
});
$('#vp').addEventListener('dblclick', () => viewer.frame(false));

// ================================================================= safe frame + export
const resW = $('#resW'), resH = $('#resH');
resW.value = settings.get('resW', 1920);
resH.value = settings.get('resH', 1080);
const clampRes = v => Math.max(16, Math.min(8192, Math.round(+v || 0)));

function updateSafe() {
  const W = clampRes(resW.value), H = clampRes(resH.value);
  const r = viewer.safeRect(W, H);
  const box = $('#sfBox');
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  $('#sfTag').textContent = `${W} × ${H}`;
  $$('#resPresets .chip').forEach(c => c.classList.toggle('on', c.dataset.r === `${W}x${H}`));
}
viewer.onResize = updateSafe;
function setSafe(on) {
  $('#ckSafe').checked = on;
  $('#safe').classList.toggle('on', on);
  $('#sfBtn').classList.toggle('on', on);
  settings.set('safe', on);
  updateSafe();
}
$('#ckSafe').addEventListener('change', e => setSafe(e.target.checked));
$('#sfBtn').onclick = () => setSafe(!$('#ckSafe').checked);
[resW, resH].forEach(i => {
  i.addEventListener('input', updateSafe);
  i.addEventListener('change', () => { i.value = clampRes(i.value); settings.set(i.id, +i.value); updateSafe(); });
});
$('#swapBtn').onclick = () => { [resW.value, resH.value] = [resH.value, resW.value]; settings.set('resW', +resW.value); settings.set('resH', +resH.value); updateSafe(); };
$$('#resPresets .chip').forEach(c => c.addEventListener('click', () => {
  const [w, h] = c.dataset.r.split('x');
  resW.value = w; resH.value = h;
  settings.set('resW', +w); settings.set('resH', +h);
  if (!$('#ckSafe').checked) setSafe(true); else updateSafe();
}));
setSafe(settings.get('safe', false));

$('#ckAlpha').checked = settings.get('alpha', false);
$('#ckAlpha').addEventListener('change', e => {
  settings.set('alpha', e.target.checked);
  if (e.target.checked && $('#fmtSel').value === 'jpg') { $('#fmtSel').value = 'png'; settings.set('fmt', 'png'); }
});
$('#fmtSel').value = settings.get('fmt', 'png');
$('#fmtSel').addEventListener('change', e => {
  settings.set('fmt', e.target.value);
  if (e.target.value === 'jpg' && $('#ckAlpha').checked) { $('#ckAlpha').checked = false; settings.set('alpha', false); toast('JPG không có nền trong suốt'); }
});
$('#aaSel').value = settings.get('aa', '2');
$('#aaSel').addEventListener('change', e => settings.set('aa', e.target.value));
$('#turnSec').value = settings.get('turnSec', '6');
$('#turnSec').addEventListener('change', e => settings.set('turnSec', e.target.value));

const outName = (ext, W, H) => {
  const base = state.ref ? P.stripExt(state.ref.name) : 'FormaLab';
  const dir = settings.get('lastOutDir', '') || (state.paths && state.paths.pictures) || '';
  const file = `${base}_${W}x${H}.${ext}`;
  return dir ? P.joinPath(dir, file) : file;
};
const rememberDir = saved => { if (saved && /[\\/]/.test(saved)) settings.set('lastOutDir', saved.replace(/[\\/][^\\/]*$/, '')); };

async function takeShot() {
  if (!viewer.model) { toast('Hãy mở model trước'); return; }
  const W = clampRes(resW.value), H = clampRes(resH.value);
  const fmt = $('#fmtSel').value;
  busy.show(`Đang chụp ${W} × ${H}…`);
  // let the "busy" card paint before the (blocking) high-res render
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))));
  try {
    const canvas = viewer.renderImage(W, H, { transparent: $('#ckAlpha').checked && fmt === 'png', supersample: +$('#aaSel').value });
    const blob = await new Promise(r => canvas.toBlob(r, fmt === 'jpg' ? 'image/jpeg' : 'image/png', 0.95));
    busy.hide();
    const saved = await P.saveBlob(blob, outName(fmt, W, H), [{ name: fmt.toUpperCase(), extensions: [fmt] }]);
    if (saved) {
      rememberDir(saved);
      toast(`Đã lưu ảnh ${P.baseName(saved)}`, P.isElectron ? { label: 'Mở thư mục', run: () => P.showInFolder(saved) } : null);
    }
  } catch (e) {
    busy.hide();
    toast('Không chụp được: ' + e.message);
  }
}
$('#shotBtn').onclick = takeShot;
$('#shot2').onclick = takeShot;

$('#turnBtn').onclick = async () => {
  if (!viewer.model) return;
  let W = clampRes(resW.value), H = clampRes(resH.value);
  const scale = Math.min(1, 1920 / Math.max(W, H));
  if (scale < 1) { W = Math.round(W * scale / 2) * 2; H = Math.round(H * scale / 2) * 2; }
  W -= W % 2; H -= H % 2;
  const sec = +$('#turnSec').value;
  busy.show(`Đang quay turntable ${W} × ${H}…`, { progress: true, cancel: () => viewer.cancelRecording && viewer.cancelRecording() });
  try {
    const { blob, ext } = await viewer.recordTurntable(W, H, sec, p => busy.progress(p));
    busy.hide();
    const saved = await P.saveBlob(blob, outName(ext, W, H).replace(new RegExp(`_${W}x${H}\\.`), `_turntable_${W}x${H}.`), [{ name: ext.toUpperCase(), extensions: [ext] }]);
    if (saved) {
      rememberDir(saved);
      toast(`Đã lưu video ${P.baseName(saved)}${scale < 1 ? ' (thu về tối đa 1920px)' : ''}`, P.isElectron ? { label: 'Mở thư mục', run: () => P.showInFolder(saved) } : null);
    }
  } catch (e) {
    busy.hide();
    if (e.message !== 'cancelled') toast('Không quay được: ' + e.message); else toast('Đã huỷ quay video');
  }
};

// ================================================================= open / drop
const MODEL_FILTER = [{ name: 'Model 3D', extensions: P.MODEL_EXT }];

async function openDialog() {
  const { files } = await P.openFiles({ title: 'Mở model', filters: MODEL_FILTER, multi: !P.isElectron });
  if (!files.length) return;
  const model = files.find(f => P.MODEL_EXT.includes(f.ext));
  if (model) openModel(model, { pool: files });
}
$('#openBtn').onclick = openDialog;
$('#emptyOpen').onclick = openDialog;
$('#animBtn').onclick = async () => {
  const { files } = await P.openFiles({ title: 'Chọn file animation (FBX / GLB)', filters: [{ name: 'Animation', extensions: ['fbx', 'glb', 'gltf'] }], multi: true });
  if (files.length) addAnimationFiles(files);
};

$('#sampleTopBtn').onclick = () => $('#sampleBtn').click();
$('#sampleBtn').onclick = async () => {
  state.paths = state.paths || await P.appPaths();
  const ref = P.sampleRef(state.paths, 'MonBot/MonBot.fbx');
  const pool = P.isElectron ? [] : ['MonBot_BaseColor.png', 'MonBot_Normal.png', 'MonBot_ORM.png', 'MonBot_Emissive.png']
    .map(n => P.sampleRef(state.paths, 'MonBot/textures/' + n));
  if (await openModel(ref, { pool })) {
    toast('Đã mở MonBot · bấm "Thêm animation" và chọn file trong thư mục animations', P.isElectron ? {
      label: 'Mở thư mục mẫu', run: () => P.showInFolder(P.joinPath(state.paths.samples, 'MonBot', 'animations', 'MonBot_Anim_Walk.fbx')),
    } : null);
  }
};

async function handleDrop({ files, dirs }) {
  // folders (Electron): a folder with a model opens it, otherwise it is a texture folder
  for (const d of dirs) {
    const inside = P.filesInDir(d);
    const model = inside.find(f => P.MODEL_EXT.includes(f.ext));
    if (model && !viewer.model) { await openModel(model, { pool: inside }); continue; }
    files = files.concat(inside.filter(f => !P.MODEL_EXT.includes(f.ext) || !viewer.model));
  }
  const hdr = files.filter(f => P.HDR_EXT.includes(f.ext));
  const models = files.filter(f => P.MODEL_EXT.includes(f.ext));
  const images = files.filter(f => P.IMAGE_EXT.includes(f.ext));
  for (const h of hdr.slice(0, 4)) await addHdri(h);

  if (models.length) {
    if (viewer.model) {
      // FBX/GLB without meshes = animation files for the current model
      busy.show('Đang đọc file…');
      const anims = [];
      let newModel = null, newRes = null;
      for (const m of models) {
        try {
          const res = await loadModel(m, { pool: files, renderer: viewer.renderer });
          let hasMesh = false;
          res.object.traverse(o => { if (o.isMesh) hasMesh = true; });
          if (!hasMesh && res.clips.length) anims.push(m);
          else if (!newModel) { newModel = m; newRes = res; }
        } catch (e) { toast(`Không đọc được ${m.name}: ${e.message}`); }
      }
      busy.hide();
      if (newModel) await openModel(newModel, { pool: files, preloaded: newRes });
      if (anims.length) await addAnimationFiles(anims, files);
    } else {
      await openModel(models[0], { pool: files });
      if (models.length > 1) await addAnimationFiles(models.slice(1), files);
    }
    return;
  }
  if (images.length) {
    if (!viewer.model) { toast('Hãy mở model trước, rồi thả texture vào'); return; }
    const n = await autoAssign(images, true);
    if (n) { afterMaterialEdit(); toast(`Đã gán ${n} texture theo tên file`); }
    else if (images.length === 1 && curMat()) { await setSlot(curMat(), SLOTS[0], images[0]); }
    else toast('Không nhận ra tên texture (cần đuôi như _BaseColor, _Normal, _ORM…). Thả từng ảnh vào ô trong bảng Material.');
  }
}

let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#drop').classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', async e => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').classList.remove('on');
  if (document.getElementById('lock-overlay') && !document.getElementById('lock-overlay').hidden) return;
  handleDrop(await P.refsFromDrop(e.dataTransfer));
});

// ================================================================= keyboard
window.addEventListener('keydown', e => {
  if (e.target.matches('input[type=text],input[type=number],input[type=password],select,textarea')) return;
  const lock = document.getElementById('lock-overlay');
  if (lock && !lock.hidden) return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'o') { e.preventDefault(); if (e.shiftKey) $('#animBtn').click(); else openDialog(); return; }
  if (e.ctrlKey && k === 's') { e.preventDefault(); takeShot(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (k === ' ') { e.preventDefault(); if (viewer.action) setPlayIcon(viewer.togglePlay()); }
  else if (k === 'f') { if (e.shiftKey) setSafe(!$('#ckSafe').checked); else viewer.frame(false); }
  else if (k === 'g') $('#gridBtn').click();
  else if (k === 'b') $('#bonesBtn').click();
  else if (k === 'l') $('#loopBtn').click();
  else if (k === 'home') viewer.seek(0);
  else if (k === 'arrowleft') { e.preventDefault(); stepFrame(-1); }
  else if (k === 'arrowright') { e.preventDefault(); stepFrame(1); }
  else if ('1234'.includes(k) && k.length === 1) $$('.vtool .seg')[+k - 1].click();
  else if (k === 'escape') selectMesh(null);
});

// ================================================================= start
(async () => {
  state.paths = await P.appPaths();
  initHdris();
  const launch = await P.launchFile();
  if (launch) openModel(launch);
})();

// for automated UI tests
window.__formalab = { viewer, state, openModel, handleDrop, addAnimationFiles, P };
