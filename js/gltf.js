// GLB (glTF 2.0 binary) loader: parses geometry to CPU arrays, materials, and decodes images on demand.
// Supports: embedded buffers, strided accessors, normalized ints, u8/u16/u32 indices,
// KHR_materials_transmission / emissive_strength (basic), node hierarchies (TRS or matrix).
import { m4 } from './math.js';
import { Mesh, textureFromSource } from './gl.js';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const NORMDIV = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

export const preloaded = new Map(); // url -> ArrayBuffer (filled by the download screen)

export async function fetchGLB(url, onProgress) {
  const pre = preloaded.get(url);
  if (pre) { preloaded.delete(url); if (onProgress) onProgress(1); return parseGLB(pre, url); }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (onProgress) onProgress(1);
  return parseGLB(buf, url);
}

export function parseGLB(buf, name = 'glb') {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${name}: not a GLB file`);
  let off = 12;
  let json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    off += 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off, len)));
    else if (type === 0x004e4942 && !bin) bin = new Uint8Array(buf, off, len);
    off += len;
  }
  if (!json) throw new Error(`${name}: missing JSON chunk`);
  return new GLTFData(json, bin, name);
}

class GLTFData {
  constructor(json, bin, name) {
    this.json = json;
    this.bin = bin;
    this.name = name;
    this.imageCache = new Map();
    this._buildNodes();
    this._buildPrims();
  }

  readAccessor(idx) {
    const j = this.json;
    const acc = j.accessors[idx];
    const n = NCOMP[acc.type];
    const Arr = COMP[acc.componentType];
    const out = new Float32Array(acc.count * n);
    const isFloatOut = true;
    const norm = acc.normalized ? NORMDIV[acc.componentType] : 0;
    if (acc.bufferView !== undefined) {
      const bv = j.bufferViews[acc.bufferView];
      const base = this.bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride = bv.byteStride || n * Arr.BYTES_PER_ELEMENT;
      if (stride === n * Arr.BYTES_PER_ELEMENT && base % Arr.BYTES_PER_ELEMENT === 0) {
        const src = new Arr(this.bin.buffer, base, acc.count * n);
        if (norm) for (let i = 0; i < src.length; i++) out[i] = Math.max(src[i] / norm, -1);
        else out.set(src);
      } else {
        const dv = new DataView(this.bin.buffer, base - 0, Math.max(0, stride * (acc.count - 1) + n * Arr.BYTES_PER_ELEMENT));
        const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
        const bpe = Arr.BYTES_PER_ELEMENT;
        for (let i = 0; i < acc.count; i++) {
          for (let k = 0; k < n; k++) {
            let v = dv[get](i * stride + k * bpe, true);
            if (norm) v = Math.max(v / norm, -1);
            out[i * n + k] = v;
          }
        }
      }
    }
    return out;
  }

  readIndices(idx) {
    const j = this.json;
    const acc = j.accessors[idx];
    const Arr = COMP[acc.componentType];
    const bv = j.bufferViews[acc.bufferView];
    const base = this.bin.byteOffset + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    let src;
    if (base % Arr.BYTES_PER_ELEMENT === 0) src = new Arr(this.bin.buffer, base, acc.count);
    else src = new Arr(this.bin.buffer.slice(base, base + acc.count * Arr.BYTES_PER_ELEMENT));
    return src;
  }

  _nodeLocal(n) {
    const o = m4.create();
    if (n.matrix) {
      o.set(n.matrix);
    } else {
      m4.fromTRS(o, n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
    }
    return o;
  }

  _buildNodes() {
    const j = this.json;
    const nodes = j.nodes || [];
    this.nodeWorld = new Array(nodes.length);
    this.nodeParent = new Array(nodes.length).fill(-1);
    const sceneRoots = j.scenes[j.scene || 0].nodes;
    const visit = (i, parentMat, parent) => {
      const w = m4.create();
      m4.multiply(w, parentMat, this._nodeLocal(nodes[i]));
      this.nodeWorld[i] = w;
      this.nodeParent[i] = parent;
      for (const c of nodes[i].children || []) visit(c, w, i);
    };
    const I = m4.create();
    for (const r of sceneRoots) visit(r, I, -1);
  }

  nodeChain(i) {
    const chain = [];
    while (i >= 0) {
      chain.unshift(i);
      i = this.nodeParent[i];
    }
    return chain;
  }

  _buildPrims() {
    const j = this.json;
    this.prims = [];
    (j.nodes || []).forEach((node, ni) => {
      if (node.mesh === undefined || !this.nodeWorld[ni]) return;
      const mesh = j.meshes[node.mesh];
      mesh.primitives.forEach((p, pi) => {
        if (p.mode !== undefined && p.mode !== 4) return; // triangles only
        const a = p.attributes;
        const positions = this.readAccessor(a.POSITION);
        let normals = a.NORMAL !== undefined ? this.readAccessor(a.NORMAL) : null;
        const uvs = a.TEXCOORD_0 !== undefined ? this.readAccessor(a.TEXCOORD_0) : null;
        let colors = null;
        if (a.COLOR_0 !== undefined) {
          const acc = j.accessors[a.COLOR_0];
          const raw = this.readAccessor(a.COLOR_0);
          if (acc.type === 'VEC3') {
            colors = new Float32Array((raw.length / 3) * 4);
            for (let i = 0, k = 0; i < raw.length; i += 3, k += 4) {
              colors[k] = raw[i]; colors[k + 1] = raw[i + 1]; colors[k + 2] = raw[i + 2]; colors[k + 3] = 1;
            }
          } else colors = raw;
        }
        let indices = p.indices !== undefined ? this.readIndices(p.indices) : null;
        const vcount = positions.length / 3;
        if (!indices) {
          indices = vcount > 65535 ? new Uint32Array(vcount) : new Uint16Array(vcount);
          for (let i = 0; i < vcount; i++) indices[i] = i;
        }
        if (!normals) normals = computeNormals(positions, indices);
        this.prims.push({
          node: ni,
          nodeName: node.name || '',
          meshName: mesh.name || '',
          index: pi,
          material: p.material,
          positions, normals, uvs, colors, indices,
          world: this.nodeWorld[ni],
        });
      });
    });
  }

  parseMaterial(mi) {
    const j = this.json;
    const m = mi === undefined ? {} : j.materials[mi];
    const pbr = m.pbrMetallicRoughness || {};
    const ext = m.extensions || {};
    const mat = {
      name: m.name || `mat${mi}`,
      baseColor: pbr.baseColorFactor || [1, 1, 1, 1],
      metallic: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
      roughness: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
      emissive: m.emissiveFactor || [0, 0, 0],
      alphaMode: m.alphaMode || 'OPAQUE',
      alphaCutoff: m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5,
      doubleSided: !!m.doubleSided,
      normalScale: m.normalTexture && m.normalTexture.scale !== undefined ? m.normalTexture.scale : 1,
      occlusionStrength: m.occlusionTexture && m.occlusionTexture.strength !== undefined ? m.occlusionTexture.strength : 1,
      transmission: ext.KHR_materials_transmission ? (ext.KHR_materials_transmission.transmissionFactor ?? 0) : 0,
      texInfo: {
        base: pbr.baseColorTexture,
        mr: pbr.metallicRoughnessTexture,
        normal: m.normalTexture,
        occ: m.occlusionTexture,
        emis: m.emissiveTexture,
      },
    };
    if (ext.KHR_materials_emissive_strength) {
      const s = ext.KHR_materials_emissive_strength.emissiveStrength ?? 1;
      mat.emissive = mat.emissive.map((v) => v * s);
    }
    return mat;
  }

  async decodeImage(imageIdx) {
    if (this.imageCache.has(imageIdx)) return this.imageCache.get(imageIdx);
    const p = (async () => {
      const im = this.json.images[imageIdx];
      let blob;
      if (im.bufferView !== undefined) {
        const bv = this.json.bufferViews[im.bufferView];
        const start = this.bin.byteOffset + (bv.byteOffset || 0);
        blob = new Blob([new Uint8Array(this.bin.buffer, start, bv.byteLength)], { type: im.mimeType || 'image/png' });
      } else if (im.uri) {
        blob = await (await fetch(im.uri)).blob();
      } else throw new Error('image without data');
      return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    })();
    this.imageCache.set(imageIdx, p);
    return p;
  }

  // Create GPU textures for a material description. Returns the material with `.tex` populated.
  async uploadMaterial(gl, caps, mat, texCache, { aniso = 8, maxTexSize = 2048 } = {}) {
    mat.tex = { base: null, mr: null, normal: null, occ: null, emis: null };
    const j = this.json;
    const jobs = [];
    for (const key of Object.keys(mat.texInfo)) {
      const info = mat.texInfo[key];
      if (!info) continue;
      const tdef = j.textures[info.index];
      if (!tdef || tdef.source === undefined) continue;
      const srgb = key === 'base' || key === 'emis';
      const smp = tdef.sampler !== undefined ? j.samplers[tdef.sampler] : {};
      const wrapOf = (w) => (w === 33071 ? gl.CLAMP_TO_EDGE : w === 33648 ? gl.MIRRORED_REPEAT : gl.REPEAT);
      const wrapS = wrapOf(smp.wrapS), wrapT = wrapOf(smp.wrapT);
      const ckey = `${this.name}|${tdef.source}|${srgb ? 's' : 'l'}|${wrapS}|${wrapT}`;
      let p = texCache.get(ckey);
      if (!p) {
        p = this.decodeImage(tdef.source).then((bmp) => {
          let src = bmp;
          const maxDim = Math.max(bmp.width, bmp.height);
          if (maxDim > maxTexSize) {
            // downscale oversized textures to respect the quality preset (keeps aspect)
            const s = maxTexSize / maxDim;
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(bmp.width * s));
            c.height = Math.max(1, Math.round(bmp.height * s));
            const ctx = c.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bmp, 0, 0, c.width, c.height);
            src = c;
          }
          const wrap = wrapS; // renderer uses one wrap mode per texture
          const tex = textureFromSource(gl, caps, src, { srgb, wrap, aniso });
          if (wrapS !== wrapT) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
          }
          return tex;
        });
        texCache.set(ckey, p);
      }
      jobs.push(p.then((t) => { mat.tex[key] = t; }));
    }
    await Promise.all(jobs);
    return mat;
  }
}

function computeNormals(pos, idx) {
  const n = new Float32Array(pos.length);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

// Apply a 4x4 transform to prim vertex data, producing new arrays (positions + normals).
export function bakePrim(prim, matrix, extraScale = 1) {
  const m = matrix;
  const nm = m4.normalMat3(new Float32Array(9), m);
  const P = prim.positions, N = prim.normals;
  const op = new Float32Array(P.length), on = new Float32Array(N.length);
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    op[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) * extraScale;
    op[i + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) * extraScale;
    op[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) * extraScale;
    const nx = N[i], ny = N[i + 1], nz = N[i + 2];
    let ax = nm[0] * nx + nm[3] * ny + nm[6] * nz;
    let ay = nm[1] * nx + nm[4] * ny + nm[7] * nz;
    let az = nm[2] * nx + nm[5] * ny + nm[8] * nz;
    const l = Math.hypot(ax, ay, az) || 1;
    on[i] = ax / l; on[i + 1] = ay / l; on[i + 2] = az / l;
  }
  let indices = prim.indices;
  // negative determinant mirrors winding -> flip triangle order
  if (m4.det3(m) < 0) {
    const f = indices instanceof Uint32Array ? new Uint32Array(indices.length) : new Uint16Array(indices.length);
    for (let i = 0; i < indices.length; i += 3) { f[i] = indices[i]; f[i + 1] = indices[i + 2]; f[i + 2] = indices[i + 1]; }
    indices = f;
  }
  return { ...prim, positions: op, normals: on, indices };
}

export function primToMesh(gl, prim) {
  let idx = prim.indices;
  if (idx instanceof Uint8Array) idx = new Uint16Array(idx);
  const vcount = prim.positions.length / 3;
  if (vcount > 65535 && !(idx instanceof Uint32Array)) idx = new Uint32Array(idx);
  return new Mesh(gl, { positions: prim.positions, normals: prim.normals, uvs: prim.uvs, colors: prim.colors, indices: idx });
}

// ---------- foliage LOD generation: drops whole "cards" (connected triangle clusters) ----------
// keep: fraction of small components to retain. Structural (large) components always stay.
// Selection is nested: a component kept at ratio r is kept at every ratio >= r.
export function buildCardLOD(prim, keep, { structuralTris = 900, grow = 0.45 } = {}) {
  const idx = prim.indices;
  const vcount = prim.positions.length / 3;
  if (!prim._cc) {
    // union-find over vertices
    const parent = new Int32Array(vcount);
    for (let i = 0; i < vcount; i++) parent[i] = i;
    const find = (x) => {
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    };
    for (let i = 0; i < idx.length; i += 3) {
      const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]);
      if (a !== b) parent[b] = a;
      const a2 = find(a);
      if (c !== a2) parent[c] = a2;
    }
    const triComp = new Int32Array(idx.length / 3);
    const compTris = new Map();
    for (let t = 0; t < triComp.length; t++) {
      const r = find(idx[t * 3]);
      triComp[t] = r;
      compTris.set(r, (compTris.get(r) || 0) + 1);
    }
    // centroid per component
    const cen = new Map();
    for (let v = 0; v < vcount; v++) {
      const r = find(v);
      let c = cen.get(r);
      if (!c) { c = [0, 0, 0, 0]; cen.set(r, c); }
      c[0] += prim.positions[v * 3]; c[1] += prim.positions[v * 3 + 1]; c[2] += prim.positions[v * 3 + 2]; c[3]++;
    }
    for (const c of cen.values()) { c[0] /= c[3]; c[1] /= c[3]; c[2] /= c[3]; }
    prim._cc = { find, triComp, compTris, cen };
  }
  const { find, triComp, compTris, cen } = prim._cc;
  const hash = (r) => {
    let h = (r * 2654435761) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const keepComp = (r) => compTris.get(r) > structuralTris || hash(r) < keep;
  const remap = new Int32Array(vcount).fill(-1);
  const newIdx = [];
  let nv = 0;
  for (let t = 0; t < triComp.length; t++) {
    const r = triComp[t];
    if (!keepComp(r)) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k];
      if (remap[v] < 0) remap[v] = nv++;
      newIdx.push(remap[v]);
    }
  }
  const scaleUp = keep >= 0.999 ? 1 : Math.pow(keep, -grow);
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
  const UV = prim.uvs ? new Float32Array(nv * 2) : null;
  const C = prim.colors ? new Float32Array(nv * 4) : null;
  for (let v = 0; v < vcount; v++) {
    const nvv = remap[v];
    if (nvv < 0) continue;
    const r = find(v);
    let x = prim.positions[v * 3], y = prim.positions[v * 3 + 1], z = prim.positions[v * 3 + 2];
    if (scaleUp !== 1 && compTris.get(r) <= structuralTris) {
      const c = cen.get(r);
      x = c[0] + (x - c[0]) * scaleUp; y = c[1] + (y - c[1]) * scaleUp; z = c[2] + (z - c[2]) * scaleUp;
    }
    P[nvv * 3] = x; P[nvv * 3 + 1] = y; P[nvv * 3 + 2] = z;
    N[nvv * 3] = prim.normals[v * 3]; N[nvv * 3 + 1] = prim.normals[v * 3 + 1]; N[nvv * 3 + 2] = prim.normals[v * 3 + 2];
    if (UV) { UV[nvv * 2] = prim.uvs[v * 2]; UV[nvv * 2 + 1] = prim.uvs[v * 2 + 1]; }
    if (C) for (let k = 0; k < 4; k++) C[nvv * 4 + k] = prim.colors[v * 4 + k];
  }
  const I = nv > 65535 ? new Uint32Array(newIdx) : new Uint16Array(newIdx);
  return { ...prim, positions: P, normals: N, uvs: UV, colors: C, indices: I, _cc: undefined };
}
