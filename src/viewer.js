// The 3D side of FormaLab: renderer, camera, lights, environment, model, animation, view modes,
// and image / turntable export. No DOM panels here — app.js drives it.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { toStandard } from './materials.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Viewer {
  constructor(canvas, stage) {
    this.canvas = canvas;
    this.stage = stage;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.camera.position.set(3, 2, 4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    // Xoay: chuột trái · Pan: chuột giữa, chuột phải, hoặc Shift/Ctrl + chuột trái · Zoom: lăn chuột
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.studioEnv = this.pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
    this.env = { texture: this.studioEnv, show: true, rotation: 0, intensity: 1, blur: 0.25, color: new THREE.Color(0x2b2d31) };
    this.applyEnv();

    // helpers that never appear in exported images
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.grid = new THREE.GridHelper(10, 20, 0x5a5f69, 0x3b3f47);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.grid.material.depthWrite = false;
    this.helpers.add(this.grid);

    this.shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    this.size = 2; // bounding sphere radius of the model, drives lights / grid / camera
    this.center = new THREE.Vector3(0, 1, 0);
    this.lights = [];
    this.lightId = 0;
    this.shadows = true;
    this.addLight('directional', { name: 'Key light', intensity: 3, color: '#fff4e0', azimuth: 40, elevation: 50 });
    this.addLight('directional', { name: 'Fill light', intensity: 0.8, color: '#cfe0ff', azimuth: -70, elevation: 25, shadow: false });
    this.addLight('point', { name: 'Rim light', intensity: 30, color: '#7fb8ff', azimuth: 200, elevation: 35 });

    this.model = null;
    this.modelRoot = new THREE.Group();
    this.scene.add(this.modelRoot);

    this.mixer = null;
    this.clips = [];
    this.action = null;
    this.playing = true;
    this.loop = true;
    this.speed = 1;

    this.viewMode = 'shaded';
    this.channel = 'all';
    this.skeletonHelper = null;
    this.showBones = false;
    this.selectionBox = null;

    this.clock = new THREE.Clock();
    this.onFrame = null;
    this.fps = 60;
    this._frames = 0; this._acc = 0;
    this.capture = { width: 1920, height: 1080, safe: false };

    new ResizeObserver(() => this.resize()).observe(stage);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ------------------------------------------------------------------ frame
  resize() {
    const w = Math.max(1, this.stage.clientWidth), h = Math.max(1, this.stage.clientHeight);
    if (this.recording) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.onResize) this.onResize(w, h);
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.mixer && this.action) {
      if (this.playing) {
        this.mixer.update(dt * this.speed);
        const dur = this.action.getClip().duration;
        if (!this.loop && this.action.time >= dur - 1e-4) { this.playing = false; if (this.onPlayState) this.onPlayState(false); }
      }
    }
    if (this.turntable) this.turntable(dt);
    this.controls.update();
    if (this.skeletonHelper) this.skeletonHelper.visible = this.showBones;
    if (this.selectionBox) this.selectionBox.update();
    this.renderer.render(this.scene, this.camera);
    this._frames++; this._acc += dt;
    if (this._acc >= 0.5) { this.fps = Math.round(this._frames / this._acc); this._frames = 0; this._acc = 0; }
    if (this.onFrame) this.onFrame();
  }

  // ------------------------------------------------------------------ environment
  applyEnv() {
    const e = this.env;
    this.scene.environment = e.texture;
    this.scene.environmentIntensity = e.intensity;
    this.scene.background = e.show ? e.texture : e.color;
    this.scene.backgroundIntensity = e.intensity;
    this.scene.backgroundBlurriness = e.show ? e.blur : 0;
    const rot = THREE.MathUtils.degToRad(e.rotation);
    this.scene.environmentRotation.set(0, rot, 0);
    this.scene.backgroundRotation.set(0, rot, 0);
  }

  async loadHDRI(ref) {
    const buf = await ref.arrayBuffer();
    let tex;
    if (ref.ext === 'exr') {
      const loader = new EXRLoader().setDataType(THREE.HalfFloatType);
      const d = loader.parse(buf);
      tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.flipY = d.flipY !== undefined ? d.flipY : false;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    } else {
      const loader = new RGBELoader().setDataType(THREE.HalfFloatType);
      const d = loader.parse(buf);
      tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      tex.flipY = true;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    }
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    tex.userData.raw = tex.image;
    return tex;
  }

  setEnvTexture(tex) {
    this.env.texture = tex || this.studioEnv;
    this.applyEnv();
  }

  // ------------------------------------------------------------------ lights
  addLight(type, o = {}) {
    let light;
    if (type === 'directional') light = new THREE.DirectionalLight();
    else if (type === 'spot') { light = new THREE.SpotLight(); light.angle = THREE.MathUtils.degToRad(o.angle || 30); light.penumbra = 0.4; light.decay = 0; }
    else { light = new THREE.PointLight(); light.decay = 0; }
    light.color.set(o.color || '#ffffff');
    const item = {
      id: ++this.lightId, type, light,
      name: o.name || ({ directional: 'Directional', point: 'Point', spot: 'Spot' }[type] + ' ' + this.lightId),
      intensity: o.intensity !== undefined ? o.intensity : (type === 'directional' ? 2 : 20),
      azimuth: o.azimuth !== undefined ? o.azimuth : 30,
      elevation: o.elevation !== undefined ? o.elevation : 40,
      visible: true,
      castShadow: o.shadow !== undefined ? o.shadow : type !== 'point',
    };
    if (light.shadow) {
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.02;
    }
    this.scene.add(light);
    if (light.target) this.scene.add(light.target);
    this.lights.push(item);
    this.updateLight(item);
    return item;
  }

  removeLight(item) {
    this.scene.remove(item.light);
    if (item.light.target) this.scene.remove(item.light.target);
    item.light.dispose && item.light.dispose();
    this.lights = this.lights.filter(l => l !== item);
  }

  updateLight(item) {
    const l = item.light, r = this.size || 2;
    const az = THREE.MathUtils.degToRad(item.azimuth), el = THREE.MathUtils.degToRad(item.elevation);
    const dist = r * (item.type === 'directional' ? 3 : 2.2);
    l.position.set(
      this.center.x + Math.sin(az) * Math.cos(el) * dist,
      this.center.y + Math.sin(el) * dist,
      this.center.z + Math.cos(az) * Math.cos(el) * dist);
    if (l.target) { l.target.position.copy(this.center); l.target.updateMatrixWorld(); }
    l.visible = item.visible;
    // Point / spot intensity is entered relative to the model size so the same number looks the
    // same on a 2 m model and a 200 cm model.
    l.intensity = item.type === 'directional' ? item.intensity : item.intensity * 0.04;
    l.castShadow = this.shadows && item.castShadow && item.type !== 'point';
    if (l.shadow && l.shadow.camera) {
      const cam = l.shadow.camera;
      if (cam.isOrthographicCamera) { cam.left = cam.bottom = -r * 1.4; cam.right = cam.top = r * 1.4; }
      cam.near = r * 0.05; cam.far = r * 8;
      cam.updateProjectionMatrix();
    }
  }

  setShadows(on) {
    this.shadows = on;
    this.shadowPlane.visible = on;
    this.lights.forEach(l => this.updateLight(l));
  }

  // ------------------------------------------------------------------ model
  clearModel() {
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer = null; }
    this.clips = []; this.action = null;
    if (this.skeletonHelper) { this.helpers.remove(this.skeletonHelper); this.skeletonHelper.dispose(); this.skeletonHelper = null; }
    this.select(null);
    if (this.model) {
      this.modelRoot.remove(this.model);
      this.model.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const mats = o.userData.originalMaterial ? [].concat(o.userData.originalMaterial) : o.material ? [].concat(o.material) : [];
        mats.forEach(m => { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); });
      });
    }
    this.model = null;
    this.modelRoot.rotation.set(0, 0, 0);
  }

  // Takes a loaded THREE.Object3D (+ clips) and prepares it for display.
  setModel(object, clips, info = {}) {
    this.clearModel();
    this.model = object;
    this.modelInfo = info;
    const meshes = [];
    object.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.material = Array.isArray(o.material) ? o.material.map(toStandard) : toStandard(o.material);
        o.userData.originalMaterial = o.material;
        o.frustumCulled = !o.isSkinnedMesh; // skinned bounds often lag behind the animation
        meshes.push(o);
      }
    });
    this.modelRoot.add(object);
    if (info.zUp) this.modelRoot.rotation.x = -Math.PI / 2;

    const hasBones = (() => { let b = false; object.traverse(o => { if (o.isBone) b = true; }); return b; })();
    if (hasBones) {
      this.skeletonHelper = new THREE.SkeletonHelper(object);
      this.skeletonHelper.material.depthTest = false;
      this.skeletonHelper.material.vertexColors = false;
      this.skeletonHelper.material.color.set(0xE5383B);
      this.skeletonHelper.material.needsUpdate = true;
      this.skeletonHelper.renderOrder = 999;
      this.skeletonHelper.visible = this.showBones;
      this.helpers.add(this.skeletonHelper);
    }

    this.mixer = new THREE.AnimationMixer(object);
    this.clips = [];
    (clips || []).forEach(c => this.addClip(c, info.name || 'model'));
    this.frame(true);
    this.setViewMode(this.viewMode, this.channel);
    return meshes;
  }

  setZUp(on) {
    if (!this.model) return;
    this.modelRoot.rotation.x = on ? -Math.PI / 2 : 0;
    this.frame(true);
  }

  // Bounds of the model in its current pose.
  bounds() {
    const box = new THREE.Box3();
    if (!this.model) return box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    this.modelRoot.updateMatrixWorld(true);
    this.model.traverse(o => {
      if (!(o.isMesh && o.visible !== false)) return;
      if (o.isSkinnedMesh) { o.computeBoundingBox(); const b = o.boundingBox.clone().applyMatrix4(o.matrixWorld); box.union(b); }
      else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)); }
    });
    if (box.isEmpty()) box.setFromObject(this.model);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    return box;
  }

  // Re-centres camera, grid, shadow catcher and lights on the model. keepView=false only moves the target.
  frame(resetView) {
    const box = this.bounds();
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    this.size = r;
    this.center.copy(sphere.center);
    this.floorY = box.min.y;

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = r / Math.sin(fov / 2) * 1.05;
    const dir = resetView
      ? new THREE.Vector3(0.55, 0.32, 1).normalize()
      : this.camera.position.clone().sub(this.controls.target).normalize();
    this.camera.near = r / 100;
    this.camera.far = r * 100;
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(this.center);
    this.controls.minDistance = r * 0.05;
    this.controls.maxDistance = r * 40;
    this.controls.update();

    const step = Math.pow(10, Math.floor(Math.log10(r * 2)));
    const gsize = Math.ceil((r * 6) / step) * step;
    this.grid.scale.setScalar(gsize / 10);
    this.grid.position.set(this.center.x, this.floorY, this.center.z);
    this.shadowPlane.scale.setScalar(r * 8);
    this.shadowPlane.position.set(this.center.x, this.floorY - r * 0.001, this.center.z);
    this.lights.forEach(l => this.updateLight(l));
  }

  stats() {
    const s = { tris: 0, verts: 0, bones: 0, meshes: 0, materials: new Set() };
    if (!this.model) return s;
    this.model.traverse(o => {
      if (o.isBone) s.bones++;
      if (o.isMesh) {
        s.meshes++;
        const g = o.geometry;
        s.verts += g.attributes.position ? g.attributes.position.count : 0;
        s.tris += (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) / 3;
        [].concat(o.userData.originalMaterial || o.material).forEach(m => s.materials.add(m));
      }
    });
    s.tris = Math.round(s.tris);
    return s;
  }

  materials() {
    const list = [];
    const seen = new Map();
    if (!this.model) return list;
    this.model.traverse(o => {
      if (!o.isMesh) return;
      [].concat(o.userData.originalMaterial || o.material).forEach(m => {
        if (!seen.has(m)) { seen.set(m, { material: m, names: [m.name], meshes: [] }); list.push(seen.get(m)); }
        const e = seen.get(m);
        e.meshes.push(o);
        if (o.name) e.names.push(o.name);
      });
    });
    return list;
  }

  select(mesh) {
    if (this.selectionBox) { this.helpers.remove(this.selectionBox); this.selectionBox.dispose(); this.selectionBox = null; }
    this.selected = mesh;
    if (mesh) {
      this.selectionBox = new THREE.BoxHelper(mesh, 0xE5383B);
      this.selectionBox.material.depthTest = false;
      this.selectionBox.material.transparent = true;
      this.selectionBox.material.opacity = 0.8;
      this.helpers.add(this.selectionBox);
    }
  }

  pick(clientX, clientY) {
    if (!this.model) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObject(this.model, true).filter(h => h.object.isMesh && h.object.visible);
    return hits.length ? hits[0].object : null;
  }

  // ------------------------------------------------------------------ view modes
  setViewMode(mode, channel) {
    this.viewMode = mode;
    this.channel = channel || 'all';
    if (!this.model) return;
    this.model.traverse(o => {
      if (!o.isMesh) return;
      const orig = o.userData.originalMaterial;
      if (mode === 'shaded' && this.channel === 'all') { o.material = orig; return; }
      o.material = Array.isArray(orig) ? orig.map(m => this.viewMaterial(m, mode)) : this.viewMaterial(orig, mode);
    });
  }

  viewMaterial(src, mode) {
    const cache = src.userData.viewCache || (src.userData.viewCache = {});
    const key = mode + ':' + this.channel;
    if (cache[key]) return cache[key];
    let m;
    if (this.channel !== 'all') m = this.channelMaterial(src, this.channel);
    else if (mode === 'wire') m = new THREE.MeshBasicMaterial({ color: 0xe8e9ec, wireframe: true });
    else if (mode === 'uv') {
      m = new THREE.MeshStandardMaterial({ map: this.checkerTexture(), roughness: 0.75 });
      if (src.map) m.map.flipY = src.map.flipY;
    } else if (mode === 'matcap') m = new THREE.MeshMatcapMaterial({ matcap: this.matcapTexture(), normalMap: src.normalMap, normalScale: src.normalScale });
    else m = src;
    if (m !== src) { m.side = src.side; m.alphaMap = m.alphaMap || null; }
    cache[key] = m;
    return m;
  }

  // Shows one texture channel unlit. Uses MeshBasicMaterial so skinning keeps working.
  channelMaterial(src, channel) {
    const pick = { map: ['map', null], normal: ['normalMap', null], roughness: ['roughnessMap', 'g'], metallic: ['metalnessMap', 'b'], ao: ['aoMap', 'r'], emissive: ['emissiveMap', null] }[channel];
    const tex = src[pick[0]];
    if (channel === 'normal' && !tex) return new THREE.MeshNormalMaterial();
    if (!tex) {
      const v = channel === 'roughness' ? src.roughness : channel === 'metallic' ? src.metalness : channel === 'ao' ? 1 : null;
      const color = channel === 'map' ? src.color : channel === 'emissive' ? src.emissive : new THREE.Color(v, v, v);
      return new THREE.MeshBasicMaterial({ color: color.clone() });
    }
    const m = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
    if (pick[1]) {
      const sw = pick[1];
      m.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
          `#include <map_fragment>\n diffuseColor.rgb = vec3(texture2D(map, vMapUv).${sw});`);
      };
      m.customProgramCacheKey = () => 'ch-' + sw;
    } else if (channel === 'normal') {
      m.onBeforeCompile = sh => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
          '#include <map_fragment>\n diffuseColor.rgb = texture2D(map, vMapUv).rgb;');
      };
      m.customProgramCacheKey = () => 'ch-normal';
    }
    return m;
  }

  checkerTexture() {
    if (this._checker) return this._checker;
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? '#2B2D31' : '#E8E9EC'; g.fillRect(x * 64, y * 64, 64, 64);
      g.fillStyle = (x + y) % 2 ? '#8D929C' : '#5A5F69';
      g.font = 'bold 18px Segoe UI, sans-serif'; g.fillText(String.fromCharCode(65 + x) + (8 - y), x * 64 + 8, y * 64 + 24);
    }
    g.fillStyle = '#E5383B'; g.fillRect(0, 448, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return (this._checker = t);
  }

  matcapTexture() {
    if (this._matcap) return this._matcap;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(96, 84, 10, 128, 128, 128);
    grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.25, '#d9d4cc'); grd.addColorStop(0.7, '#7a7470'); grd.addColorStop(1, '#2a2624');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = grd; g.beginPath(); g.arc(128, 128, 127, 0, Math.PI * 2); g.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return (this._matcap = t);
  }

  // ------------------------------------------------------------------ animation
  addClip(clip, source) {
    if (!this.mixer || !clip || !clip.tracks.length) return null;
    const fixed = this.retarget(clip);
    if (!fixed.tracks.length) return null;
    let name = clip.name && clip.name !== 'mixamo.com' && !/^(Take 001|Animation|default)$/i.test(clip.name) ? clip.name : source;
    while (this.clips.some(c => c.name === name)) name += ' *';
    fixed.name = name;
    const entry = { name, clip: fixed, source, matched: fixed.userData ? fixed.userData.matched : 0 };
    this.clips.push(entry);
    return entry;
  }

  // Animation from another file: keep the tracks whose bone exists in this model. Bones are
  // matched by name, ignoring namespaces ("mixamorig:Hips" / "Character1_Hips" ...) and case.
  retarget(clip) {
    const names = new Map();
    const short = n => n.toLowerCase().replace(/^.*[:|]/, '').replace(/^(mixamorig\d*|character\d*_|bip\d*_?|armature_?)/, '').replace(/[^a-z0-9]/g, '');
    this.model.traverse(o => { if (o.name) { names.set(o.name, o.name); names.set('~' + short(o.name), o.name); } });
    const tracks = [];
    let matched = 0;
    const touched = new Set();
    for (const t of clip.tracks) {
      const dot = t.name.lastIndexOf('.');
      const node = t.name.slice(0, dot), prop = t.name.slice(dot);
      const target = names.get(node) || names.get('~' + short(node));
      if (!target) continue;
      const nt = t.clone();
      nt.name = target + prop;
      tracks.push(nt);
      if (!touched.has(target)) { touched.add(target); matched++; }
    }
    const c = new THREE.AnimationClip(clip.name, clip.duration, tracks);
    c.userData = { matched };
    return c;
  }

  playClip(index) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    this.action = null;
    const entry = this.clips[index];
    if (!entry) { // bind pose
      this.model.traverse(o => { if (o.isSkinnedMesh) o.skeleton.pose(); });
      return;
    }
    this.action = this.mixer.clipAction(entry.clip);
    this.action.setLoop(this.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    this.action.clampWhenFinished = true;
    this.action.play();
    this.playing = true;
  }

  setLoop(on) {
    this.loop = on;
    if (this.action) this.action.setLoop(on ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  }

  get duration() { return this.action ? this.action.getClip().duration : 0; }
  get time() { return this.action ? this.action.time : 0; }

  seek(t) {
    if (!this.action) return;
    const d = this.duration;
    this.action.paused = false;
    this.action.enabled = true;
    this.action.time = THREE.MathUtils.clamp(t, 0, d);
    this.mixer.update(0);
  }

  togglePlay() {
    if (!this.action) return false;
    if (!this.playing && !this.loop && this.time >= this.duration - 1e-4) this.seek(0);
    this.playing = !this.playing;
    if (this.playing) { this.action.paused = false; this.action.enabled = true; }
    return this.playing;
  }

  // ------------------------------------------------------------------ export
  // Pixel rectangle of the render area inside the viewport, for a target aspect ratio.
  safeRect(width, height) {
    const sw = this.stage.clientWidth, sh = this.stage.clientHeight;
    const pad = 48, top = 18;
    const ar = width / height;
    let bw = sw - pad * 2, bh = bw / ar;
    if (bh > sh - pad * 2 - top) { bh = sh - pad * 2 - top; bw = bh * ar; }
    return { x: (sw - bw) / 2, y: (sh - bh) / 2 + top / 2, w: bw, h: bh, sw, sh };
  }

  // Renders exactly what is inside the safe frame at width x height. Returns a canvas.
  renderImage(width, height, { transparent = false, supersample = 2 } = {}) {
    const r = this.safeRect(width, height);
    const maxSide = this.renderer.capabilities.maxTextureSize || 8192;
    const ss = Math.max(1, Math.min(supersample, Math.floor(Math.min(maxSide, 8192) / Math.max(width, height))));
    const W = width * ss, H = height * ss;
    const prev = {
      size: this.renderer.getSize(new THREE.Vector2()), ratio: this.renderer.getPixelRatio(),
      bg: this.scene.background, helpers: this.helpers.visible, plane: this.shadowPlane.visible,
    };
    this.helpers.visible = false;
    if (transparent) this.scene.background = null;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(W, H, false);
    this.camera.setViewOffset(r.sw, r.sh, r.x, r.y, r.w, r.h);
    this.camera.aspect = r.sw / r.sh;
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);

    const out = document.createElement('canvas');
    out.width = width; out.height = height;
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (!transparent) { g.fillStyle = '#' + this.env.color.getHexString(); g.fillRect(0, 0, width, height); }
    // step down by halves for clean supersampling
    let src = this.canvas, sw2 = W, sh2 = H;
    while (sw2 / 2 >= width && sh2 / 2 >= height && (sw2 > width || sh2 > height)) {
      const tmp = document.createElement('canvas');
      tmp.width = Math.max(width, Math.round(sw2 / 2)); tmp.height = Math.max(height, Math.round(sh2 / 2));
      const tg = tmp.getContext('2d'); tg.imageSmoothingQuality = 'high';
      tg.drawImage(src, 0, 0, sw2, sh2, 0, 0, tmp.width, tmp.height);
      src = tmp; sw2 = tmp.width; sh2 = tmp.height;
    }
    g.drawImage(src, 0, 0, sw2, sh2, 0, 0, width, height);

    this.camera.clearViewOffset();
    this.helpers.visible = prev.helpers;
    this.scene.background = prev.bg;
    this.renderer.setPixelRatio(prev.ratio);
    this.renderer.setSize(prev.size.x, prev.size.y, false);
    this.resize();
    return out;
  }

  // 360° camera orbit recorded to a video. onProgress(0..1). Returns a Blob.
  recordTurntable(width, height, seconds, onProgress) {
    return new Promise((resolve, reject) => {
      const types = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
      const mime = types.find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
      if (!mime) { reject(new Error('Máy này không hỗ trợ quay video.')); return; }
      const r = this.safeRect(width, height);
      const target = this.controls.target.clone();
      const offset = this.camera.position.clone().sub(target);
      const prevRatio = this.renderer.getPixelRatio();
      const prevHelpers = this.helpers.visible;
      this.recording = true;
      this.helpers.visible = false;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.camera.setViewOffset(r.sw, r.sh, r.x, r.y, r.w, r.h);
      this.camera.aspect = r.sw / r.sh;
      this.camera.updateProjectionMatrix();
      this.controls.enabled = false;

      const stream = this.canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(width * height * 30 * 0.25) });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      let elapsed = 0, cancelled = false;
      const finish = () => {
        this.turntable = null;
        this.camera.position.copy(target).add(offset);
        this.camera.clearViewOffset();
        this.controls.enabled = true;
        this.helpers.visible = prevHelpers;
        this.recording = false;
        this.renderer.setPixelRatio(prevRatio);
        this.resize();
      };
      rec.onstop = () => {
        finish();
        if (cancelled) { reject(new Error('cancelled')); return; }
        resolve({ blob: new Blob(chunks, { type: mime.split(';')[0] }), ext: mime.includes('mp4') ? 'mp4' : 'webm' });
      };
      this.cancelRecording = () => { cancelled = true; if (rec.state !== 'inactive') rec.stop(); };
      this.turntable = dt => {
        elapsed += dt;
        const a = Math.min(1, elapsed / seconds) * Math.PI * 2;
        const o = offset.clone().applyAxisAngle(UP, a);
        this.camera.position.copy(target).add(o);
        this.camera.lookAt(target);
        if (onProgress) onProgress(Math.min(1, elapsed / seconds));
        if (elapsed >= seconds && rec.state === 'recording') { this.turntable = null; setTimeout(() => rec.stop(), 120); }
      };
      rec.start(250);
    });
  }
}
