// Asset loading: car models (auto-detects wheels / paint / lights) and tree models (baked + LOD chain).
import { m4, mulberry32 } from './math.js';
import { fetchGLB, bakePrim, primToMesh, buildCardLOD } from './gltf.js';
import { Material } from './renderer.js';

// ---------- paint presets (hue is absolute 0..1; the source paint of the demo car is blue, hue ~0.63) ----------
export const PAINTS = [
  { name: 'Factory Blue', hue: 0.63, sat: 1.0, val: 1.0 },
  { name: 'Racing Red', hue: 0.0, sat: 1.05, val: 1.7 },
  { name: 'Giallo Yellow', hue: 0.145, sat: 1.0, val: 2.0 },
  { name: 'Verde Lime', hue: 0.27, sat: 1.0, val: 1.6 },
  { name: 'Arancio Orange', hue: 0.07, sat: 1.05, val: 1.9 },
  { name: 'Viola Purple', hue: 0.77, sat: 1.0, val: 1.35 },
  { name: 'Cyan Pulse', hue: 0.5, sat: 1.0, val: 1.6 },
  { name: 'Pearl White', hue: 0.63, sat: 0.03, val: 2.0 },
  { name: 'Matte Black', hue: 0.63, sat: 0.08, val: 0.2 },
  { name: 'Titanium Silver', hue: 0.63, sat: 0.05, val: 1.2 },
];
const SOURCE_HUE = 0.63;
export function paintUniform(p) {
  let shift = p.hue - SOURCE_HUE;
  return [shift, p.sat, p.val, p.hue === SOURCE_HUE && p.sat === 1 && p.val === 1 ? 0 : 1];
}

function worldBounds(prim, world) {
  const P = prim.positions;
  let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
    const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
    const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
    if (wx < minx) minx = wx; if (wx > maxx) maxx = wx;
    if (wy < miny) miny = wy; if (wy > maxy) maxy = wy;
    if (wz < minz) minz = wz; if (wz > maxz) maxz = wz;
  }
  return { min: [minx, miny, minz], max: [maxx, maxy, maxz] };
}

// ============================ CARS ============================
// cfg (optional, from <car>.json): { name, yaw, stats:{...}, wheelRadius, tags }
export async function loadCar(renderer, url, cfg = {}) {
  const gl = renderer.gl;
  const g = await fetchGLB(url);
  const orient = m4.create();
  // --- auto-normalise: scale to a realistic car length and orient the long axis along +Z (override with cfg.scale / cfg.yaw) ---
  let yawDeg = cfg.yaw;
  let autoScale = cfg.scale;
  {
    let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
    for (const prim of g.prims) {
      const b = worldBounds(prim, prim.world);
      mnx = Math.min(mnx, b.min[0]); mxx = Math.max(mxx, b.max[0]); mnz = Math.min(mnz, b.min[2]); mxz = Math.max(mxz, b.max[2]);
    }
    const ex = mxx - mnx, ez = mxz - mnz;
    if (yawDeg === undefined) yawDeg = ex > ez * 1.25 ? 90 : 0;
    const longest = Math.max(ex, ez);
    if (autoScale === undefined) autoScale = longest > 6.4 || longest < 3.0 ? 4.6 / longest : 1;
  }
  m4.rotationY(orient, (yawDeg * Math.PI) / 180);
  if (autoScale !== 1) for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) orient[i] *= autoScale;

  // materials
  const matCache = new Map();
  const getMat = async (idx) => {
    if (matCache.has(idx)) return matCache.get(idx);
    const d = g.parseMaterial(idx);
    const n = d.name.toLowerCase();
    const m = new Material({
      name: d.name, baseColor: d.baseColor.slice(), metallic: d.metallic, roughness: d.roughness,
      emissive: d.emissive, alphaMode: d.alphaMode, alphaCutoff: d.alphaCutoff, doubleSided: d.doubleSided,
      normalScale: d.normalScale, occStrength: d.occlusionStrength,
    });
    await g.uploadMaterial(gl, renderer.caps, d, renderer.texCache, { aniso: renderer.q.aniso, maxTexSize: renderer.q.maxTexSize });
    m.tex = d.tex;
    if (/window|glass/.test(n)) {
      m.role = 'glass';
      m.alphaMode = 'BLEND';
      m.baseColor = [0.55, 0.62, 0.68, 0.34];
      m.metallic = 0.0; m.roughness = 0.03;
      m.doubleSided = true;
    } else if (/_ext$|paint|body|exterior/.test(n)) {
      m.role = 'paint';
      m.paint = true;
      m.metallic = 0.42;
      m.roughness = 0.2;
    } else if (/wheel|rim/.test(n)) {
      m.role = 'rim';
      m.roughness = 0.28;
      m.metallic = Math.max(m.metallic, 0.8);
    } else if (/tyre|tire/.test(n)) {
      m.role = 'tyre';
      m.roughness = 0.82; m.metallic = 0;
    } else if (/lights?$/.test(n)) {
      m.role = 'lights';
      m.lightsEmissive = true;
      m.roughness = 0.2;
    } else if (/rotor|brake/.test(n)) {
      m.role = 'rotor';
      m.metallic = 0.9; m.roughness = 0.35;
    } else if (/chassis|misc/.test(n)) {
      m.role = 'misc';
      m.roughness = Math.min(m.roughness, 0.55);
    } else {
      m.role = 'other';
    }
    if (m.alphaMode === 'MASK') m.alphaCutoff = d.alphaCutoff;
    matCache.set(idx, m);
    return m;
  };

  const parts = [];
  const wheels = new Map();
  let bmin = [1e9, 1e9, 1e9], bmax = [-1e9, -1e9, -1e9];
  const tyreBounds = [];
  for (const prim of g.prims) {
    const mat = await getMat(prim.material);
    const world = m4.create();
    m4.multiply(world, orient, prim.world);
    const wb = worldBounds(prim, world);
    const center = [(wb.min[0] + wb.max[0]) / 2, (wb.min[1] + wb.max[1]) / 2, (wb.min[2] + wb.max[2]) / 2];
    for (let k = 0; k < 3; k++) { bmin[k] = Math.min(bmin[k], wb.min[k]); bmax[k] = Math.max(bmax[k], wb.max[k]); }
    // wheel group detection: first ancestor whose name looks like a wheel (but not the steering wheel)
    let wheelNode = -1;
    for (const ni of g.nodeChain(prim.node)) {
      const nm = (g.json.nodes[ni].name || '');
      if (/wheel/i.test(nm) && !/steer/i.test(nm)) { wheelNode = ni; break; }
    }
    let wheelIdx = -1;
    if (wheelNode >= 0) {
      if (!wheels.has(wheelNode)) {
        const w = g.nodeWorld[wheelNode];
        const wm = m4.create();
        m4.multiply(wm, orient, w);
        const pivot = [wm[12], wm[13], wm[14]];
        wheels.set(wheelNode, { index: wheels.size, node: wheelNode, pivot, front: false, left: pivot[0] > 0, radius: 0.33, adj: m4.create() });
      }
      wheelIdx = wheels.get(wheelNode).index;
      if (mat.role === 'tyre') {
        const r = Math.max(wb.max[1] - wb.min[1], wb.max[2] - wb.min[2]) / 2;
        const w = wheels.get(wheelNode);
        w.radius = Math.max(w.radius === 0.33 ? 0 : w.radius, r);
      }
    }
    let role = mat.role;
    if (role === 'lights') role = center[2] < 0 ? 'tail' : 'head';
    parts.push({ mesh: primToMesh(gl, prim), mat, base: world, wheel: wheelIdx, role, center, name: prim.nodeName });
  }
  const wheelList = [...wheels.values()].sort((a, b) => a.index - b.index);
  // front axle = the pair with larger z
  const zs = wheelList.map((w) => w.pivot[2]);
  const zmid = (Math.max(...zs) + Math.min(...zs)) / 2;
  for (const w of wheelList) w.front = w.pivot[2] > zmid;
  const frontZ = wheelList.filter((w) => w.front).map((w) => w.pivot[2]);
  const rearZ = wheelList.filter((w) => !w.front).map((w) => w.pivot[2]);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const wheelbase = Math.abs(avg(frontZ) - avg(rearZ)) || 2.7;
  const trackW = wheelList.length ? Math.max(...wheelList.map((w) => Math.abs(w.pivot[0]))) * 2 : 1.9;
  const groundY = bmin[1];
  const dims = {
    length: bmax[2] - bmin[2], width: bmax[0] - bmin[0], height: bmax[1] - bmin[1],
    wheelbase, track: trackW, groundY,
    frontAxleZ: avg(frontZ), rearAxleZ: avg(rearZ),
    center: [(bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2],
    wheelRadius: cfg.wheelRadius || (wheelList.length ? avg(wheelList.map((w) => w.radius)) : 0.34),
    minZ: bmin[2], maxZ: bmax[2],
  };
  // exhaust positions (rear, low) for nitro flames
  const exhaust = parts.filter((p) => /EXHAUST/i.test(p.name)).map((p) => p.center);
  dims.exhaust = exhaust.length
    ? [[-0.45, dims.groundY + 0.34, bmin[2] + 0.05], [0.45, dims.groundY + 0.34, bmin[2] + 0.05]]
    : [[-0.4, groundY + 0.4, bmin[2]], [0.4, groundY + 0.4, bmin[2]]];
  const tail = parts.filter((p) => p.role === 'tail').map((p) => p.center);
  dims.taillights = tail.length ? [Math.max(...tail.map((c) => Math.abs(c[0]))) || 0.5, tail[0][1], bmin[2]] : [0.5, 0.8, bmin[2]];
  const head = parts.filter((p) => p.role === 'head').map((p) => p.center);
  dims.headlights = head.length ? [Math.max(0.55, ...head.map((c) => Math.abs(c[0]))), Math.max(...head.map((c) => c[1])), bmax[2]] : [0.6, 0.65, bmax[2]];
  const nameBase = url.split('/').pop().replace(/\.glb$/i, '');
  const car = {
    id: cfg.id || nameBase,
    name: cfg.name || nameBase.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    parts, wheels: wheelList, dims,
    stats: Object.assign({
      topSpeed: 86, // m/s without nitro (~310 km/h)
      accel: 1.0, handling: 1.0, grip: 1.0, nitro: 1.0, mass: 1500, brake: 1.0,
    }, cfg.stats || {}),
    opaque: parts.filter((p) => p.mat.alphaMode !== 'BLEND'),
    glass: parts.filter((p) => p.mat.alphaMode === 'BLEND'),
    cfg,
  };
  return car;
}

const _adj = m4.create(), _t1 = m4.create(), _t2 = m4.create(), _r = m4.create(), _fin = m4.create(), _tmp = m4.create();

// state: { wheelSpin:[4 angles] or single angle, steer, paint:[h,s,v,on], tail, head }
export function drawCar(renderer, car, model, st, glassPass = false) {
  const wheels = car.wheels;
  for (const w of wheels) {
    const spin = Array.isArray(st.wheelSpin) ? st.wheelSpin[w.index] : st.wheelSpin;
    m4.translation(_t1, w.pivot[0], w.pivot[1], w.pivot[2]);
    m4.translation(_t2, -w.pivot[0], -w.pivot[1], -w.pivot[2]);
    m4.rotationX(_r, spin || 0);
    m4.multiply(_tmp, _r, _t2);
    if (w.front) {
      m4.rotationY(_r, st.steer || 0);
      m4.multiply(w.adj, _r, _tmp);
      m4.multiply(_tmp, _t1, w.adj);
      w.adj.set(_tmp);
    } else {
      m4.multiply(w.adj, _t1, _tmp);
    }
  }
  const list = glassPass ? car.glass : car.opaque;
  const paint = st.paint || [0, 1, 1, 0];
  for (const p of list) {
    if (p.wheel >= 0) {
      m4.multiply(_tmp, wheels[p.wheel].adj, p.base);
      m4.multiply(_fin, model, _tmp);
    } else {
      m4.multiply(_fin, model, p.base);
    }
    let boost = 0;
    if (p.role === 'tail') boost = st.tail || 0;
    else if (p.role === 'head') boost = st.head || 0;
    renderer.drawMesh(p.mesh, p.mat, _fin, { paint: p.mat.paint ? paint : null, emissiveBoost: boost });
  }
}

// ============================ TREES ============================
export const TREE_SPECS = {
  black_spruce: { file: 'assets/trees/black_spruce.glb', height: [10.5, 17], cutoff: 0.32, lod: [1, 0.42, 0.17, 0.07], mipBoost: 0.5, crown: 0.9 },
  red_oak: { file: 'assets/trees/red_oak.glb', height: [11, 17], cutoff: 0.42, lod: [1, 0.4, 0.15, 0.06], mipBoost: 0.3, crown: 1.0 },
  pine_b: { file: 'assets/trees/pine_b.glb', height: [12, 20], cutoff: 0.4, lod: [1, 0.55], mipBoost: 0.3, crown: 1.0 },
  fir_spruce: { file: 'assets/trees/fir_spruce.glb', height: [14, 22], cutoff: 0.4, lod: [1, 0.5, 0.22], mipBoost: 0.4, crown: 1.0 },
  pine_fbx: { file: 'assets/trees/pine_fbx.glb', height: [13, 21], cutoff: 0.4, lod: [1, 0.45, 0.18], mipBoost: 0.4, crown: 1.0 },
};

export class TreeModel {
  constructor(gl, key, spec) {
    this.gl = gl;
    this.key = key;
    this.spec = spec;
    this.lods = [];
    this.height = 1;
    this.radius = 1;
  }
  setInstances(lod, data, count) {
    const gl = this.gl;
    const L = this.lods[lod];
    L.count = count;
    if (count <= 0) return;
    const bytes = count * 32;
    gl.bindBuffer(gl.ARRAY_BUFFER, L.instBuf);
    if (bytes > L.instBytes) {
      L.instBytes = Math.max(bytes, L.instBytes * 2, 65536);
      gl.bufferData(gl.ARRAY_BUFFER, L.instBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 8);

  }
}

export async function loadTree(renderer, key, onStatus) {
  const gl = renderer.gl;
  const spec = TREE_SPECS[key];
  const g = await fetchGLB(spec.file);
  // world bounds of the whole model
  let minY = 1e9, maxY = -1e9, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of g.prims) {
    const b = worldBounds(p, p.world);
    minY = Math.min(minY, b.min[1]); maxY = Math.max(maxY, b.max[1]);
    minX = Math.min(minX, b.min[0]); maxX = Math.max(maxX, b.max[0]);
    minZ = Math.min(minZ, b.min[2]); maxZ = Math.max(maxZ, b.max[2]);
  }
  const H = maxY - minY;
  // find trunk base center: average xz of vertices near the bottom
  let sx = 0, sz = 0, cnt = 0;
  for (const p of g.prims) {
    const P = p.positions, w = p.world;
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      const wy = w[1] * x + w[5] * y + w[9] * z + w[13];
      if (wy < minY + H * 0.03) {
        sx += w[0] * x + w[4] * y + w[8] * z + w[12];
        sz += w[2] * x + w[6] * y + w[10] * z + w[14];
        cnt++;
      }
    }
  }
  const bx = cnt ? sx / cnt : (minX + maxX) / 2, bz = cnt ? sz / cnt : (minZ + maxZ) / 2;
  const T = m4.create();
  m4.translation(T, -bx, -minY, -bz);

  // materials (shared across all LODs)
  const matCache = new Map();
  const getMat = async (idx) => {
    if (matCache.has(idx)) return matCache.get(idx);
    const d = g.parseMaterial(idx);
    await g.uploadMaterial(gl, renderer.caps, d, renderer.texCache, { aniso: renderer.q.aniso, maxTexSize: renderer.q.maxTexSize });
    const foliage = d.alphaMode !== 'OPAQUE';
    const m = new Material({
      name: d.name, baseColor: d.baseColor.slice(), metallic: 0, roughness: Math.max(0.6, Math.min(1, d.roughness)),
      emissive: [0, 0, 0], alphaMode: d.alphaMode, alphaCutoff: foliage ? spec.cutoff : d.alphaCutoff,
      doubleSided: d.doubleSided || foliage, normalScale: foliage ? Math.min(d.normalScale, 0.7) : d.normalScale,
      occStrength: d.occlusionStrength, foliage, mipBoost: foliage ? spec.mipBoost : 0,
    });
    m.tex = d.tex;
    // PlantCatalog bark/needles are dark in linear space; keep authored colors
    matCache.set(idx, m);
    return m;
  };

  const baked = [];
  for (const p of g.prims) {
    const world = m4.create();
    m4.multiply(world, T, p.world);
    const b = bakePrim(p, world);
    b.mat = await getMat(p.material);
    b.isFoliage = b.mat.foliage;
    baked.push(b);
  }
  // crown radius (horizontal)
  let rad = 0;
  for (const b of baked) {
    const P = b.positions;
    for (let i = 0; i < P.length; i += 3) rad = Math.max(rad, Math.hypot(P[i], P[i + 2]));
  }

  const model = new TreeModel(gl, key, spec);
  model.height = H;
  model.radius = rad * (spec.crown || 1);
  model.heightRange = spec.height;
  const totalTris = baked.reduce((s, b) => s + b.indices.length / 3, 0);
  model.tris = totalTris;
  for (let li = 0; li < spec.lod.length; li++) {
    const ratio = spec.lod[li];
    const instBuf = gl.createBuffer();
    const L = { prims: [], tris: 0, instBuf, instBytes: 0, count: 0, ratio };
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    L.instBytes = 65536;
    gl.bufferData(gl.ARRAY_BUFFER, L.instBytes, gl.DYNAMIC_DRAW);
    for (const b of baked) {
      const triN = b.indices.length / 3;
      let prim = b;
      if (ratio < 0.999 && triN > 350) prim = buildCardLOD(b, ratio, { structuralTris: Math.max(700, triN * 0.02), grow: 0.42 });
      const mesh = primToMesh(gl, prim);
      mesh.bindInstanceBuffer(instBuf);
      L.prims.push({ mesh, mat: b.mat });
      L.tris += prim.indices.length / 3;
    }
    model.lods.push(L);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (onStatus) onStatus(key, model);
  return model;
}
