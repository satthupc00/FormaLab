// Reading model files: FBX, glTF/GLB, OBJ(+MTL). Texture paths written inside the files are
// resolved against the model's folder (and its textures/ sub-folder); missing ones are reported.
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { resolveResource, baseName } from './platform.js';

const EMPTY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function makeManager(modelRef, pool, missing) {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    if (/^(data:|blob:)/.test(url)) return url;
    const hit = resolveResource(url, modelRef, pool);
    if (hit) return hit;
    missing.add(baseName(decodeURIComponent(url.split('?')[0])));
    return EMPTY_PNG;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  return manager;
}

let ktx2 = null;
function gltfLoader(manager, renderer) {
  const loader = new GLTFLoader(manager);
  const draco = new DRACOLoader();
  draco.setDecoderPath('libs/draco/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (renderer) {
    if (!ktx2) ktx2 = new KTX2Loader().setTranscoderPath('libs/basis/').detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }
  return loader;
}

const dirUrl = ref => {
  if (ref.path) return ref.url().replace(/[^/]*$/, '');
  if (ref.remote) return ref.remote.replace(/[^/]*$/, '');
  return '';
};

// Returns { object, clips, missing: string[], kind, flipY, zUp }
export async function loadModel(ref, { pool = [], renderer } = {}) {
  const missing = new Set();
  const manager = makeManager(ref, pool, missing);
  const done = new Promise(resolve => { manager.onLoad = resolve; });
  let object, clips = [], flipY = true, zUp = false;

  if (ref.ext === 'fbx') {
    const loader = new FBXLoader(manager);
    const buf = await ref.arrayBuffer();
    object = loader.parse(buf, dirUrl(ref));
    clips = object.animations || [];
    zUp = fbxIsZUp(buf);
  } else if (ref.ext === 'glb' || ref.ext === 'gltf') {
    const loader = gltfLoader(manager, renderer);
    const data = ref.ext === 'glb' ? await ref.arrayBuffer() : await ref.text();
    const gltf = await new Promise((resolve, reject) => loader.parse(data, dirUrl(ref), resolve, reject));
    object = gltf.scene;
    clips = gltf.animations || [];
    flipY = false;
  } else if (ref.ext === 'obj') {
    const text = await ref.text();
    const loader = new OBJLoader(manager);
    const mtlName = (text.match(/^mtllib\s+(.+)$/m) || [])[1];
    if (mtlName) {
      const url = resolveResource(dirUrl(ref) + mtlName.trim(), ref, pool);
      if (url) {
        try {
          const mtl = await new MTLLoader(manager).setResourcePath(dirUrl(ref)).loadAsync(url);
          mtl.preload();
          loader.setMaterials(mtl);
        } catch (e) { missing.add(mtlName.trim()); }
      } else missing.add(mtlName.trim());
    }
    object = loader.parse(text);
  } else {
    throw new Error('Chưa hỗ trợ định dạng .' + ref.ext);
  }
  object.name = object.name || ref.name;

  // Wait (briefly) for textures referenced by the file so thumbnails are ready.
  await Promise.race([done, new Promise(r => setTimeout(r, 4000))]);
  return { object, clips, missing: [...missing].filter(Boolean), kind: ref.ext, flipY, zUp };
}

// Animation-only file (or any model): returns its clips.
export async function loadAnimations(ref, opts = {}) {
  const { clips } = await loadModel(ref, opts);
  return clips;
}

// Blender and some Max exports keep Z as up axis; FBXLoader keeps Y up, so flag it for the UI.
function fbxIsZUp(buf) {
  try {
    const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4 * 1024 * 1024));
    const text = new TextDecoder('latin1').decode(head);
    const i = text.indexOf('UpAxis');
    if (i < 0) return false;
    const tail = text.slice(i, i + 120);
    if (/UpAxis"\s*,\s*"int"\s*,\s*"Integer"\s*,\s*""\s*,\s*2/.test(tail)) return true; // ASCII
    // binary: property records are typed; the int value follows an 'I' marker after "Integer"
    const j = tail.indexOf('Integer');
    if (j >= 0) {
      const off = i + j + 7; // skip the word "Integer" itself
      for (let k = off; k < off + 40 && k < head.length - 5; k++) {
        if (head[k] === 0x49 /* I */) { const v = new DataView(buf, k + 1, 4).getInt32(0, true); return v === 2; }
      }
    }
  } catch (e) { /* ignore */ }
  return false;
}
