// World: terrain heightfield, road ribbon, barriers, curbs, props, light pools and instanced forest.
import { m4, fbm2, noise2, clamp, lerp, smoothstep, mulberry32, TAU } from './math.js';
import { Mesh, MeshBuilder } from './gl.js';
import { Material } from './renderer.js';
import { ROAD_HALF, SHOULDER, WALL, terrainBase } from './track.js';
import * as TX from './textures.js';

const CS = 4;            // terrain cell size (m)
const CHUNK = 40;        // cells per terrain chunk
const MARGIN = 470;      // terrain extends this far beyond the track bounding box
const ROAD_CHUNK = 90;   // road samples per chunk

export class World {
  constructor(renderer, env, track, treeModels) {
    this.r = renderer;
    this.gl = renderer.gl;
    this.env = env;
    this.track = track;
    this.trees = treeModels; // key -> TreeModel
    this.q = renderer.q;
    this.chunks = { terrain: [], road: [], barrier: [] };
    this.props = [];      // {mesh, mat, center, radius}
    this.dynamicProps = [];
    this.decals = null;
    this.pickups = [];
    this.identity = m4.create();
  }

  async build(progress = () => {}) {
    const r = this.r, gl = this.gl;
    const opts = r.q;
    progress(0.02, 'Generating textures');
    await tick();
    this.texGrass = TX.makeGrassTexture(gl, r.caps, opts, this.env.grass);
    this.texFloor = TX.makeForestFloorTexture(gl, r.caps, opts, this.env.floor);
    this.texRock = TX.makeRockTexture(gl, r.caps, opts);
    this.texRoad = TX.makeRoadTexture(gl, r.caps, opts);
    this.texAsphalt = TX.makeAsphaltDetailTexture(gl, r.caps, opts);
    this.texChecker = TX.makeCheckerTexture(gl, r.caps, opts);
    this.texChevron = TX.makeChevronTexture(gl, r.caps, opts);
    this.matTerrain = new Material({ name: 'terrain', terrain: true, texA: this.texGrass, texB: this.texFloor, texC: this.texRock });
    this.matRoad = new Material({ name: 'road', road: true, texA: this.texRoad, texB: this.texAsphalt });
    this.matConcrete = new Material({ name: 'concrete', roughness: 0.85, metallic: 0, grain: true, doubleSided: true });
    this.matPaint = new Material({ name: 'prop', roughness: 0.55, metallic: 0.2, doubleSided: true });
    this.matMetal = new Material({ name: 'metal', roughness: 0.4, metallic: 0.85, doubleSided: true });
    progress(0.08, 'Sculpting terrain');
    await tick();
    this._buildTerrain();
    progress(0.35, 'Paving the road');
    await tick();
    this._buildRoad();
    this._buildBarriers();
    progress(0.5, 'Placing props');
    await tick();
    this._buildProps();
    progress(0.6, 'Planting forest');
    await tick();
    this._scatterTrees();
    progress(0.75, 'Almost ready');
    await tick();
  }

  // ------------------------------------------------------------------ terrain
  heightAt(x, z) {
    const g = this.grid;
    let fx = (x - g.minx) / CS, fz = (z - g.minz) / CS;
    fx = clamp(fx, 0, g.nx - 1.001); fz = clamp(fz, 0, g.nz - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = g.h, nx = g.nx;
    const a = h[iz * nx + ix], b = h[iz * nx + ix + 1], c = h[(iz + 1) * nx + ix], d = h[(iz + 1) * nx + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  _buildTerrain() {
    const tr = this.track, env = this.env;
    const b = tr.bounds;
    const minx = Math.floor((b.minx - MARGIN) / CS) * CS, maxx = Math.ceil((b.maxx + MARGIN) / CS) * CS;
    const minz = Math.floor((b.minz - MARGIN) / CS) * CS, maxz = Math.ceil((b.maxz + MARGIN) / CS) * CS;
    const nx = Math.round((maxx - minx) / CS) + 1, nz = Math.round((maxz - minz) / CS) + 1;
    const h = new Float32Array(nx * nz);
    const dist = new Float32Array(nx * nz).fill(999);
    const roadH = new Float32Array(nx * nz);
    this.grid = { minx, minz, maxx, maxz, nx, nz, h, dist };
    const flatR = SHOULDER + 2.8, blend = 26;
    const tmp = {};
    for (let iz = 0; iz < nz; iz++) {
      const z = minz + iz * CS;
      for (let ix = 0; ix < nx; ix++) {
        const x = minx + ix * CS;
        const idx = iz * nx + ix;
        let H = terrainBase(env, x, z) + (fbm2(x * 0.035, z * 0.035, 3, env.seed + 5) - 0.5) * 3.2;
        const e = Math.min(x - minx, maxx - x, z - minz, maxz - z);
        const rimK = smoothstep(300, 0, e);
        H += rimK * rimK * 120 + rimK * 20;
        tr.nearest(x, z, -1, tmp);
        if (tmp.i >= 0 && tmp.dist < 100) {
          dist[idx] = tmp.dist;
          roadH[idx] = tmp.y;
          const k = smoothstep(flatR, flatR + blend, tmp.dist);
          H = lerp(tmp.y - 0.1, H, k);
        }
        h[idx] = H;
      }
    }
    this.roadH = roadH;
    // normals
    const normals = new Float32Array(nx * nz * 3);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const hl = h[iz * nx + Math.max(ix - 1, 0)], hr = h[iz * nx + Math.min(ix + 1, nx - 1)];
        const hd = h[Math.max(iz - 1, 0) * nx + ix], hu = h[Math.min(iz + 1, nz - 1) * nx + ix];
        let nxv = (hl - hr) / (2 * CS), nzv = (hd - hu) / (2 * CS);
        const l = Math.hypot(nxv, 1, nzv);
        const o = (iz * nx + ix) * 3;
        normals[o] = nxv / l; normals[o + 1] = 1 / l; normals[o + 2] = nzv / l;
      }
    }
    this.normals = normals;
    // vertex weights: r=grass, g=forest floor, b=rock, a=gravel
    const col = new Uint8Array(nx * nz * 4);
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const idx = iz * nx + ix;
        const x = minx + ix * CS, z = minz + iz * CS;
        const ny = normals[idx * 3 + 1];
        const slope = 1 - ny;
        let rock = smoothstep(0.16, 0.32, slope);
        const alt = h[idx];
        rock = Math.max(rock, smoothstep(55, 95, alt) * 0.6);
        const d = dist[idx];
        let gravel = 1 - smoothstep(SHOULDER + 0.5, SHOULDER + 4.5, d);
        const fl = smoothstep(0.38, 0.62, fbm2(x * 0.012 + 3, z * 0.012 - 7, 3, env.seed + 11));
        const nearRoad = 1 - smoothstep(14, 30, d); // grassy verge near the road, forest floor deeper in
        let floorW = clamp(fl * (0.55 + 0.45 * (1 - nearRoad)) + (1 - nearRoad) * 0.25, 0, 1);
        let grassW = 1 - floorW;
        const rem = 1 - Math.max(rock, gravel);
        const o = idx * 4;
        col[o] = grassW * rem * 255;
        col[o + 1] = floorW * rem * 255;
        col[o + 2] = rock * (1 - gravel) * 255;
        col[o + 3] = gravel * 255;
      }
    }
    // chunk meshes
    const cx = Math.ceil((nx - 1) / CHUNK), cz = Math.ceil((nz - 1) / CHUNK);
    for (let jz = 0; jz < cz; jz++) {
      for (let jx = 0; jx < cx; jx++) {
        const x0 = jx * CHUNK, z0 = jz * CHUNK;
        const w = Math.min(CHUNK, nx - 1 - x0), d = Math.min(CHUNK, nz - 1 - z0);
        if (w <= 0 || d <= 0) continue;
        const vn = (w + 1) * (d + 1);
        const pos = new Float32Array(vn * 3), nor = new Float32Array(vn * 3), uv = new Float32Array(vn * 2), cc = new Uint8Array(vn * 4);
        let miny = 1e9, maxy = -1e9, k = 0;
        for (let iz = 0; iz <= d; iz++) {
          for (let ix = 0; ix <= w; ix++) {
            const gi = (z0 + iz) * nx + (x0 + ix);
            pos[k * 3] = minx + (x0 + ix) * CS; pos[k * 3 + 1] = h[gi]; pos[k * 3 + 2] = minz + (z0 + iz) * CS;
            nor[k * 3] = normals[gi * 3]; nor[k * 3 + 1] = normals[gi * 3 + 1]; nor[k * 3 + 2] = normals[gi * 3 + 2];
            cc[k * 4] = col[gi * 4]; cc[k * 4 + 1] = col[gi * 4 + 1]; cc[k * 4 + 2] = col[gi * 4 + 2]; cc[k * 4 + 3] = col[gi * 4 + 3];
            miny = Math.min(miny, h[gi]); maxy = Math.max(maxy, h[gi]);
            k++;
          }
        }
        const idx = new Uint16Array(w * d * 6);
        let q = 0;
        for (let iz = 0; iz < d; iz++) {
          for (let ix = 0; ix < w; ix++) {
            const a = iz * (w + 1) + ix, b = a + 1, c = a + (w + 1), e = c + 1;
            idx[q++] = a; idx[q++] = c; idx[q++] = b;
            idx[q++] = b; idx[q++] = c; idx[q++] = e;
          }
        }
        const mesh = new Mesh(this.gl, { positions: pos, normals: nor, uvs: uv, colors: cc, indices: idx });
        const ccx = minx + (x0 + w / 2) * CS, ccz = minz + (z0 + d / 2) * CS;
        const rad = Math.hypot(w * CS / 2, d * CS / 2, (maxy - miny) / 2);
        this.chunks.terrain.push({ mesh, c: [ccx, (miny + maxy) / 2, ccz], rad });
      }
    }
    // a huge dark backdrop under everything (hides tiny cracks / the terrain border)
    let mg = 1e9;
    for (let i = 0; i < h.length; i++) if (h[i] < mg) mg = h[i];
    this.minGround = mg - 2;
  }

  // ------------------------------------------------------------------ road ribbon
  _buildRoad() {
    const tr = this.track, N = tr.N;
    const vScale = Math.max(1, Math.round(tr.length / TX.ROAD_TEX.lengthM)) / tr.length;
    this.vScale = vScale;
    const half = TX.ROAD_TEX.widthM / 2;
    for (let c0 = 0; c0 < N; c0 += ROAD_CHUNK) {
      const c1 = Math.min(N, c0 + ROAD_CHUNK);
      const mb = new MeshBuilder();
      for (let i = c0; i <= c1; i++) {
        const ii = i % N;
        const lx = tr.tz[ii], lz = -tr.tx[ii];
        const y = tr.y[ii] + 0.035;
        const sl = tr.slope[ii];
        let nx = -sl * tr.tx[ii], nz = -sl * tr.tz[ii];
        const nl = Math.hypot(nx, 1, nz);
        const v = i * tr.ds * vScale;
        mb.vert(tr.x[ii] + lx * half, y, tr.z[ii] + lz * half, nx / nl, 1 / nl, nz / nl, 0, v);
        mb.vert(tr.x[ii] - lx * half, y, tr.z[ii] - lz * half, nx / nl, 1 / nl, nz / nl, 1, v);
      }
      for (let k = 0; k < c1 - c0; k++) {
        const L0 = k * 2, R0 = L0 + 1, L1 = L0 + 2, R1 = L0 + 3;
        mb.tri(L0, R0, L1);
        mb.tri(R0, R1, L1);
      }
      const bb = mb.bounds();
      this.chunks.road.push({ mesh: mb.build(this.gl), c: bb.center, rad: bb.radius });
    }
    // start/finish checker line + start grid markings
    const mb = new MeshBuilder();
    const i0 = 0;
    const lx = tr.tz[i0], lz = -tr.tx[i0];
    const tx = tr.tx[i0], tz = tr.tz[i0];
    const y = tr.y[i0] + 0.07;
    const hw = 8.0, len = 1.6;
    const p = (a, b) => [tr.x[i0] + lx * a + tx * b, tr.z[i0] + lz * a + tz * b];
    const q0 = p(hw, -len / 2), q1 = p(-hw, -len / 2), q2 = p(-hw, len / 2), q3 = p(hw, len / 2);
    mb.vert(q0[0], y, q0[1], 0, 1, 0, 0, 0);
    mb.vert(q1[0], y, q1[1], 0, 1, 0, 1, 0);
    mb.vert(q2[0], y, q2[1], 0, 1, 0, 1, 1);
    mb.vert(q3[0], y, q3[1], 0, 1, 0, 0, 1);
    mb.tri(0, 1, 2); mb.tri(0, 2, 3);
    this.startLine = { mesh: mb.build(this.gl), mat: new Material({ name: 'checker', roughness: 0.6, tex: { base: this.texChecker }, doubleSided: true }) };
  }

  // ------------------------------------------------------------------ barriers & curbs
  _buildBarriers() {
    const tr = this.track, N = tr.N;
    const prof = [[-0.33, -0.5], [-0.33, 0.08], [-0.2, 0.42], [-0.11, 0.93], [0.11, 0.93], [0.2, 0.42], [0.33, 0.08], [0.33, -0.5]];
    const concrete = [0.30, 0.30, 0.29, 1], concrete2 = [0.24, 0.24, 0.235, 1];
    const red = [0.55, 0.045, 0.04, 1], white = [0.52, 0.52, 0.5, 1];
    const curbRed = [0.55, 0.045, 0.04, 1], curbWhite = [0.55, 0.55, 0.53, 1];
    for (let c0 = 0; c0 < N; c0 += ROAD_CHUNK) {
      const c1 = Math.min(N, c0 + ROAD_CHUNK);
      const mb = new MeshBuilder();
      const curb = new MeshBuilder();
      for (const side of [1, -1]) {
        const base = mb.vcount;
        for (let i = c0; i <= c1; i++) {
          const ii = i % N;
          const lx = tr.tz[ii], lz = -tr.tx[ii];
          const kv = tr.curv[ii];
          // outer side of a sharp bend gets red/white paint
          const outer = Math.abs(kv) > 0.0058 && Math.sign(kv) === -side;
          const panel = ((i >> 1) & 1) === 0;
          let color = panel ? concrete : concrete2;
          if (outer) color = ((i >> 1) & 1) ? red : white;
          const y0 = tr.y[ii];
          for (let k = 0; k < prof.length - 1; k++) {
            const [o1, h1] = prof[k], [o2, h2] = prof[k + 1];
            let nn = [-(h2 - h1), (o2 - o1)];
            const nl = Math.hypot(nn[0], nn[1]) || 1;
            nn = [nn[0] / nl, nn[1] / nl];
            const wnx = lx * side * nn[0], wnz = lz * side * nn[0], wny = nn[1];
            for (const [o, hh] of [[o1, h1], [o2, h2]]) {
              const lat = side * (WALL + o);
              mb.vert(tr.x[ii] + lx * lat, y0 + hh, tr.z[ii] + lz * lat, wnx, wny, wnz, i * 0.25, hh, color[0], color[1], color[2], 1);
            }
          }
        }
        // indices: each sample has (prof.length-1)*2 verts
        const per = (prof.length - 1) * 2;
        for (let i = 0; i < c1 - c0; i++) {
          for (let k = 0; k < prof.length - 1; k++) {
            const a = base + i * per + k * 2, b = a + 1, c = a + per, d = c + 1;
            if (side > 0) { mb.tri(a, c, b); mb.tri(b, c, d); } else { mb.tri(a, b, c); mb.tri(b, d, c); }
          }
        }
        // curbs at sharp bends (both sides)
        for (let i = c0; i < c1; i++) {
          const ii = i % N, jj = (i + 1) % N;
          if (Math.abs(tr.curv[ii]) < 0.0062) continue;
          const col = ((i >> 1) & 1) ? curbRed : curbWhite;
          const a0 = side * ROAD_HALF, a1 = side * (ROAD_HALF + 0.95);
          const pts = [
            [tr.x[ii] + tr.tz[ii] * a0, tr.z[ii] - tr.tx[ii] * a0, tr.y[ii]],
            [tr.x[ii] + tr.tz[ii] * a1, tr.z[ii] - tr.tx[ii] * a1, tr.y[ii]],
            [tr.x[jj] + tr.tz[jj] * a1, tr.z[jj] - tr.tx[jj] * a1, tr.y[jj]],
            [tr.x[jj] + tr.tz[jj] * a0, tr.z[jj] - tr.tx[jj] * a0, tr.y[jj]],
          ];
          const b0 = curb.vcount;
          pts.forEach((pp, k) => curb.vert(pp[0], pp[2] + 0.075, pp[1], 0, 1, 0, k % 2, k >> 1, col[0], col[1], col[2], 1));
          curb.tri(b0, b0 + 1, b0 + 2); curb.tri(b0, b0 + 2, b0 + 3);
        }
      }
      const bb = mb.bounds();
      this.chunks.barrier.push({ mesh: mb.build(this.gl), mat: this.matConcrete, c: bb.center, rad: bb.radius });
      if (curb.vcount > 0) {
        const cb = curb.bounds();
        this.chunks.barrier.push({ mesh: curb.build(this.gl), mat: this.matPaint, c: cb.center, rad: cb.radius });
      }
    }
  }

  // ------------------------------------------------------------------ props
  _addProp(mb, mat, extra = {}) {
    if (mb.vcount === 0) return;
    const bb = mb.bounds();
    this.props.push({ mesh: mb.build(this.gl), mat, c: bb.center, rad: bb.radius, ...extra });
  }

  _buildProps() {
    const tr = this.track, N = tr.N, gl = this.gl, r = this.r, env = this.env;
    const rng = mulberry32(env.seed * 7 + 1);
    const left = (i) => [tr.tz[i], -tr.tx[i]];
    // ---------- start gantry ----------
    {
      const mb = new MeshBuilder();
      const i = 0;
      const [lx, lz] = left(i);
      const yaw = Math.atan2(tr.tx[i], tr.tz[i]);
      const y0 = tr.y[i];
      const dark = [0.14, 0.15, 0.17, 1], accent = [0.9, 0.12, 0.08, 1];
      for (const s of [1, -1]) {
        const px = tr.x[i] + lx * s * 11.6, pz = tr.z[i] + lz * s * 11.6;
        mb.box(px, y0 + 3.7, pz, 0.38, 3.8, 0.38, dark, yaw);
        mb.box(px, y0 + 0.3, pz, 0.7, 0.3, 0.7, accent, yaw);
      }
      mb.box(tr.x[i], y0 + 7.4, tr.z[i], 12.2, 0.42, 0.5, dark, yaw);
      mb.box(tr.x[i], y0 + 7.75, tr.z[i], 12.0, 0.08, 0.2, accent, yaw);
      this._addProp(mb, this.matPaint);
      // banner (faces incoming cars: normal toward -tangent)
      const tex = TX.makeBannerTexture(gl, r.caps, 'START / FINISH', 'ASPHALT FOREST CHAMPIONSHIP', '#c40f16', '#16182a', r.q);
      const bm = new Material({ name: 'banner', roughness: 0.7, tex: { base: tex }, lightsEmissive: true, doubleSided: true });
      const bmb = new MeshBuilder();
      this._quadFacing(bmb, tr.x[i], y0 + 6.1, tr.z[i], lx, lz, 10.8, 2.6, -tr.tx[i], -tr.tz[i], false);
      this._addProp(bmb, bm, { emissiveBoost: 0.45 });
    }
    // ---------- billboards ----------
    {
      const brands = [
        ['NITRO RUSH', 'FUEL YOUR SPEED', '#0a6cf5', '#06123a'],
        ['APEX TIRES', 'GRIP IS EVERYTHING', '#ffb400', '#2b1700'],
        ['VOLT CELL', 'CHARGE AHEAD', '#14c46a', '#032014'],
        ['TURBO-X', 'BOOST YOUR LIFE', '#e5262d', '#2a0508'],
        ['HORIZON FM', '99.9 · DRIVE RADIO', '#9b3bff', '#12042a'],
        ['ROAD KING', 'RULE THE ASPHALT', '#ff6a00', '#1f0a00'],
      ];
      const mats = brands.map((b) => new Material({
        name: 'bb', roughness: 0.8, tex: { base: TX.makeBannerTexture(gl, r.caps, b[0], b[1], b[2], b[3], r.q) },
        lightsEmissive: true, doubleSided: true,
      }));
      const boards = brands.map(() => new MeshBuilder());
      const posts = new MeshBuilder();
      const spacing = 190;
      let n = 0;
      for (let s = 140; s < tr.length - 80; s += spacing + rng() * 70) {
        const i = Math.floor(s / tr.ds) % N;
        if (Math.abs(tr.curv[i]) > 0.004) continue;
        const side = n % 2 === 0 ? 1 : -1;
        n++;
        const [lx, lz] = left(i);
        const off = 17 + rng() * 5;
        const cx = tr.x[i] + lx * side * off, cz = tr.z[i] + lz * side * off;
        const gy = this.heightAt(cx, cz);
        const yaw = Math.atan2(tr.tx[i], tr.tz[i]);
        const bi = n % brands.length;
        for (const sx of [-4, 4]) {
          const px = cx + tr.tx[i] * sx, pz = cz + tr.tz[i] * sx;
          posts.box(px, gy + 2.3, pz, 0.14, 2.8, 0.14, [0.18, 0.19, 0.21, 1], yaw);
        }
        // board faces the incoming traffic and the road
        this._quadFacing(boards[bi], cx, gy + 4.4, cz, tr.tz[i], -tr.tx[i], 10.0, 2.7, -tr.tx[i] - lx * side * 0.55, -tr.tz[i] - lz * side * 0.55, false);
      }
      this._addProp(posts, this.matPaint);
      boards.forEach((b, k) => this._addProp(b, mats[k], { emissiveBoost: 0.4 }));
    }
    // ---------- chevrons on sharp bends ----------
    {
      const mbL = new MeshBuilder(), mbR = new MeshBuilder(), posts = new MeshBuilder();
      for (let i = 0; i < N; i += 5) {
        const kv = tr.curv[i];
        if (Math.abs(kv) < 0.0068) continue;
        const side = -Math.sign(kv); // outside of the bend
        const [lx, lz] = left(i);
        const off = WALL + 1.6;
        const cx = tr.x[i] + lx * side * off, cz = tr.z[i] + lz * side * off;
        const gy = this.heightAt(cx, cz);
        const yaw = Math.atan2(tr.tx[i], tr.tz[i]);
        posts.box(cx, gy + 0.9, cz, 0.05, 0.9, 0.05, [0.2, 0.2, 0.22, 1], yaw);
        // facing the oncoming driver and inside of the bend
        const target = kv > 0 ? mbL : mbR;
        this._quadFacing(target, cx, gy + 1.9, cz, lx, lz, 1.5, 1.5, -tr.tx[i] - lx * side * 0.35, -tr.tz[i] - lz * side * 0.35, kv > 0);
      }
      const cm = new Material({ name: 'chevron', roughness: 0.5, tex: { base: this.texChevron }, lightsEmissive: true, doubleSided: true });
      this._addProp(mbL, cm, { emissiveBoost: 0.3 });
      this._addProp(mbR, cm, { emissiveBoost: 0.3 });
      this._addProp(posts, this.matPaint);
    }
    // ---------- street lamps + light pools ----------
    const pools = [];
    if (env.lamps) {
      const poles = new MeshBuilder(), heads = new MeshBuilder();
      let k = 0;
      for (let s = 20; s < tr.length; s += 38) {
        const i = Math.floor(s / tr.ds) % N;
        const side = k++ % 2 === 0 ? 1 : -1;
        const [lx, lz] = left(i);
        const off = WALL + 1.1;
        const px = tr.x[i] + lx * side * off, pz = tr.z[i] + lz * side * off;
        const gy = tr.y[i];
        poles.cylinder(px, gy - 0.3, pz, 0.11, 9.3, 8, [0.2, 0.21, 0.23, 1], false);
        // arm toward the road
        const ax = px - lx * side * 1.1, az = pz - lz * side * 1.1;
        const yaw = Math.atan2(-lx * side, -lz * side);
        poles.box(ax, gy + 9.15, az, 0.07, 0.07, 1.2, [0.2, 0.21, 0.23, 1], yaw);
        const hx = px - lx * side * 2.2, hz = pz - lz * side * 2.2;
        heads.box(hx, gy + 9.05, hz, 0.28, 0.07, 0.6, [0.1, 0.1, 0.1, 1], yaw);
        const gx = tr.x[i] - lx * side * 2.5, gz = tr.z[i] - lz * side * 2.5;
        pools.push(hx, gy + 0.09, hz - 0, 15, 1.7, 1.25, 0.78, 0.9);
        this.lampHeads = this.lampHeads || [];
        this.lampHeads.push([hx, gy + 9.0, hz]);
      }
      this._addProp(poles, this.matPaint);
      const hm = new Material({ name: 'lamp', baseColor: [0.2, 0.2, 0.2, 1], roughness: 0.4, emissive: [14, 10, 5.5], doubleSided: true });
      this._addProp(heads, hm);
      // flat light pools on the road under each lamp
      const data = new Float32Array(pools.length);
      for (let n = 0; n < pools.length; n += 8) {
        data[n] = pools[n]; data[n + 1] = pools[n + 1]; data[n + 2] = pools[n + 2]; data[n + 3] = pools[n + 3];
        data[n + 4] = pools[n + 4] * 0.35; data[n + 5] = pools[n + 5] * 0.35; data[n + 6] = pools[n + 6] * 0.3; data[n + 7] = 1;
      }
      this.decals = this.r.makeDecalBatch(data);
    }
  }

  // oriented quad: center, "across" vector (lx,lz) horizontal, width/height; facing direction (fx,fz); mirrorU flips texture
  _quadFacing(mb, cx, cy, cz, ax, az, w, h, fx, fz, mirrorU) {
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;
    // make the "across" axis perpendicular to facing for a clean quad
    let rx = fz, rz = -fx; // right-handed horizontal perpendicular
    const hw = w / 2, hh = h / 2;
    const u0 = mirrorU ? 1 : 0, u1 = mirrorU ? 0 : 1;
    const b = mb.vcount;
    mb.vert(cx - rx * hw, cy - hh, cz - rz * hw, fx, 0, fz, u0, 1);
    mb.vert(cx + rx * hw, cy - hh, cz + rz * hw, fx, 0, fz, u1, 1);
    mb.vert(cx + rx * hw, cy + hh, cz + rz * hw, fx, 0, fz, u1, 0);
    mb.vert(cx - rx * hw, cy + hh, cz - rz * hw, fx, 0, fz, u0, 0);
    mb.tri(b, b + 1, b + 2); mb.tri(b, b + 2, b + 3);
  }

  // ------------------------------------------------------------------ forest
  _scatterTrees() {
    const env = this.env, tr = this.track, g = this.grid;
    const types = env.trees.filter(([k]) => this.trees[k]);
    const total = types.reduce((s, t) => s + t[1], 0);
    this.instances = {};
    for (const [k] of types) this.instances[k] = [];
    const rng = mulberry32(env.seed * 131 + 7);
    const density = this.q.treeDensity;
    const tmp = {};
    const step = 7.2;
    const x0 = g.minx + 30, x1 = g.maxx - 30, z0 = g.minz + 30, z1 = g.maxz - 30;
    const cheap = types.filter(([k]) => ['pine_b', 'pine_fbx', 'fir_spruce'].includes(k));
    const pickType = (list) => {
      const t = list.reduce((s, v) => s + v[1], 0);
      let r = rng() * t;
      for (const [k, w] of list) { r -= w; if (r <= 0) return k; }
      return list[list.length - 1][0];
    };
    for (let z = z0; z < z1; z += step) {
      for (let x = x0; x < x1; x += step) {
        const px = x + (rng() - 0.5) * step * 0.95, pz = z + (rng() - 0.5) * step * 0.95;
        const gi = Math.round((pz - g.minz) / CS) * g.nx + Math.round((px - g.minx) / CS);
        const d = g.dist[gi];
        // near-road forest band; also a sparser outer forest on the hills
        let p;
        const far = d >= 99;
        if (!far && d < WALL + 5.5) continue;
        if (!far) p = 0.92 * (1 - smoothstep(90, 105, d));
        else p = 0.48;
        // forest clearings (noise-driven)
        const cl = fbm2(px * 0.008 + 41, pz * 0.008 - 13, 3, env.seed + 23);
        p *= smoothstep(0.28, 0.45, cl) * 0.8 + 0.2;
        // thin near the road edge so the verge feels open at first
        if (!far) p *= 0.5 + 0.5 * smoothstep(WALL + 5, WALL + 20, d);
        if (rng() > p * density) continue;
        const ny = this.normals[gi * 3 + 1];
        if (ny < 0.78) continue;
        const key = far && cheap.length ? pickType(cheap) : pickType(types);
        const m = this.trees[key];
        const hgt = m.heightRange[0] + rng() * (m.heightRange[1] - m.heightRange[0]);
        const y = this.heightAt(px, pz) - 0.12;
        this.instances[key].push(px, y, pz, hgt / m.height, rng() * TAU, (rng() - 0.5) * 0.05, (rng() - 0.5) * 0.05, rng());
      }
    }
    // pack into typed arrays + preallocate LOD staging buffers
    this.treeData = {};
    let count = 0;
    for (const k in this.instances) {
      const arr = new Float32Array(this.instances[k]);
      const m = this.trees[k];
      const staging = m.lods.map(() => new Float32Array(arr.length));
      const shadowStaging = m.lods.map(() => new Float32Array(Math.min(arr.length, 8 * 900)));
      this.treeData[k] = { arr, n: arr.length / 8, staging, shadowStaging, counts: new Int32Array(m.lods.length) };
      count += arr.length / 8;
    }
    this.treeCount = count;
  }

  _lodIndex(model, d2, scale) {
    const L = model.lods.length;
    const d = Math.sqrt(d2) / scale;
    if (L === 1) return 0;
    const th = [38, 88, 175];
    for (let i = 0; i < L - 1; i++) if (d < th[Math.min(i, 2)]) return i;
    return L - 1;
  }

  // ------------------------------------------------------------------ per-frame drawing
  _cullTrees(camPos, shadow, focus, shadowRadius) {
    const r = this.r;
    const maxD = (shadow ? 0 : 420 * this.q.viewDist) + 0;
    const scale = this.q.treeLodScale;
    for (const k in this.treeData) {
      const td = this.treeData[k];
      const m = this.trees[k];
      td.counts.fill(0);
      const arr = td.arr;
      const rr = m.radius;
      const maxDist2 = maxD * maxD;
      for (let i = 0; i < arr.length; i += 8) {
        const x = arr[i], y = arr[i + 1], z = arr[i + 2], s = arr[i + 3];
        let lod;
        if (!shadow) {
          const dx = x - camPos[0], dz = z - camPos[2], dy = y - camPos[1];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > maxDist2) continue;
          const rad = rr * s;
          if (!r.inFrustum(x, y + m.height * s * 0.5, z, Math.max(rad, m.height * s * 0.5))) continue;
          lod = this._lodIndex(m, d2, scale);
        } else {
          const dx = x - focus[0], dz = z - focus[2];
          const d2 = dx * dx + dz * dz;
          const lim = shadowRadius + 40;
          if (d2 > lim * lim) continue;
          if (!r.inShadowFrustum(x, y + m.height * s * 0.5, z, Math.max(rr * s, m.height * s * 0.5))) continue;
          // shadows use coarser LODs (nested card selection keeps silhouettes close)
          const d = Math.sqrt(d2);
          const L = m.lods.length;
          lod = d < 26 * scale ? Math.min(1, L - 1) : d < 70 * scale ? Math.min(2, L - 1) : L - 1;
        }
        const st = shadow ? td.shadowStaging[lod] : td.staging[lod];
        const c = td.counts[lod];
        if (shadow && (c + 1) * 8 > st.length) continue;
        st.set(arr.subarray(i, i + 8), c * 8);
        td.counts[lod] = c + 1;
      }
      for (let l = 0; l < m.lods.length; l++) {
        const st = shadow ? td.shadowStaging[l] : td.staging[l];
        m.setInstances(l, st, td.counts[l]);
      }
    }
  }

  _drawTrees() {
    const r = this.r;
    for (const k in this.treeData) {
      const m = this.trees[k];
      for (let l = m.lods.length - 1; l >= 0; l--) {
        const L = m.lods[l];
        if (L.count === 0) continue;
        for (const p of L.prims) r.drawInstanced(p.mesh, p.mat, L.count, m.height);
      }
    }
  }

  drawShadow(focus, camPos) {
    const r = this.r;
    this._cullTrees(camPos, true, focus, r.shadowRadius);
    this._drawTrees();
    for (const c of this.chunks.barrier) {
      if (!r.inShadowFrustum(c.c[0], c.c[1], c.c[2], c.rad)) continue;
      r.drawMesh(c.mesh, c.mat, this.identity);
    }
    for (const p of this.props) {
      if (!r.inShadowFrustum(p.c[0], p.c[1], p.c[2], p.rad)) continue;
      if (p.emissiveBoost !== undefined) continue;
      r.drawMesh(p.mesh, p.mat, this.identity);
    }
  }

  drawMain(camPos) {
    const r = this.r;
    const maxD = 760 * this.q.viewDist;
    for (const c of this.chunks.terrain) {
      const dx = c.c[0] - camPos[0], dz = c.c[2] - camPos[2];
      if (dx * dx + dz * dz > (maxD + c.rad) * (maxD + c.rad)) continue;
      if (!r.inFrustum(c.c[0], c.c[1], c.c[2], c.rad)) continue;
      r.drawMesh(c.mesh, this.matTerrain, this.identity);
    }
    for (const c of this.chunks.road) {
      if (!r.inFrustum(c.c[0], c.c[1], c.c[2], c.rad)) continue;
      r.drawMesh(c.mesh, this.matRoad, this.identity);
    }
    r.drawMesh(this.startLine.mesh, this.startLine.mat, this.identity);
    for (const c of this.chunks.barrier) {
      if (!r.inFrustum(c.c[0], c.c[1], c.c[2], c.rad)) continue;
      r.drawMesh(c.mesh, c.mat, this.identity);
    }
    for (const p of this.props) {
      if (!r.inFrustum(p.c[0], p.c[1], p.c[2], p.rad)) continue;
      r.drawMesh(p.mesh, p.mat, this.identity, p.emissiveBoost !== undefined ? { emissiveBoost: p.emissiveBoost } : undefined);
    }
    this._cullTrees(camPos, false);
    this._drawTrees();
  }

  drawDecals() {
    if (this.decals) this.r.drawDecals(this.decals);
  }
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}
