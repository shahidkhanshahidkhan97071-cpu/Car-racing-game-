// Procedural closed race track: centerline spline, elevation profile, curvature, and nearest-point queries.
import { fbm2, clamp, lerp, wrapAngle, TAU, smoothstep } from './math.js';

export const ROAD_HALF = 8.0;      // drivable half width (marked)
export const SHOULDER = 10.0;      // paved/gravel shoulder half width
export const WALL = 10.15;         // barrier center lateral offset
export const CAR_LIMIT = 9.4;      // max lateral offset of a car corner before the wall pushes back

export function terrainBase(env, x, z) {
  const t = env.track;
  const sc = t.heightScale;
  const n = fbm2(x * sc, z * sc, 4, env.seed);
  const n2 = fbm2(x * sc * 3.1 + 17, z * sc * 3.1 - 9, 3, env.seed + 3);
  return t.heightAmp * ((n - 0.42) * 2.1 + (n2 - 0.5) * 0.45);
}

export class Track {
  constructor(env) {
    this.env = env;
    this.ds = 2.0;
    const S = env.track.scale || 1.3;
    this._build(env.track.points.map((p) => [p[0] * S, p[1] * S]));
    this._heights();
    this._hash();
  }

  _catmull(pts, subdiv) {
    const n = pts.length;
    const out = [];
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
      for (let k = 0; k < subdiv; k++) {
        const t = k / subdiv, t2 = t * t, t3 = t2 * t;
        const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
        out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    return out;
  }

  _resample(poly, ds) {
    const n = poly.length;
    const cum = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      cum[i + 1] = cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const L = cum[n];
    const N = Math.max(8, Math.round(L / ds));
    const out = [];
    let j = 0;
    for (let k = 0; k < N; k++) {
      const target = (k / N) * L;
      while (j < n - 1 && cum[j + 1] < target) j++;
      const a = poly[j], b = poly[(j + 1) % n];
      const seg = cum[j + 1] - cum[j] || 1;
      const t = (target - cum[j]) / seg;
      out.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
    }
    return { pts: out, L };
  }

  _build(ctrl) {
    let dense = this._catmull(ctrl, 48);
    let r = this._resample(dense, 3.0);
    let p = r.pts;
    // Laplacian smoothing to round off curvature discontinuities
    for (let it = 0; it < 28; it++) {
      const q = new Array(p.length);
      for (let i = 0; i < p.length; i++) {
        const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
        q[i] = [0.5 * b[0] + 0.25 * (a[0] + c[0]), 0.5 * b[1] + 0.25 * (a[1] + c[1])];
      }
      p = q;
    }
    r = this._resample(p, this.ds);
    // snap start so that the start line sits on a straight: rotate so index 0 is at the first control point's neighborhood
    const N = r.pts.length;
    this.N = N;
    this.length = N * this.ds;
    this.ds = this.length / N;
    this.x = new Float32Array(N);
    this.z = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.x[i] = r.pts[i][0]; this.z[i] = r.pts[i][1]; }
    this.tx = new Float32Array(N); this.tz = new Float32Array(N);
    this.theta = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      let dx = this.x[b] - this.x[a], dz = this.z[b] - this.z[a];
      const l = Math.hypot(dx, dz) || 1;
      this.tx[i] = dx / l; this.tz[i] = dz / l;
      this.theta[i] = Math.atan2(this.tx[i], this.tz[i]);
    }
    // signed curvature (positive = left turn since +X is left of +Z travel)
    this.curv = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = (i - 2 + N) % N, b = (i + 2) % N;
      this.curv[i] = wrapAngle(this.theta[b] - this.theta[a]) / (4 * this.ds);
    }
    let maxK = 0;
    for (let i = 0; i < N; i++) maxK = Math.max(maxK, Math.abs(this.curv[i]));
    this.minRadius = maxK > 0 ? 1 / maxK : 1e9;
  }

  _heights() {
    const N = this.N, env = this.env;
    const raw = new Float32Array(N);
    for (let i = 0; i < N; i++) raw[i] = terrainBase(env, this.x[i], this.z[i]);
    // heavy circular smoothing => graded road
    const sigma = 26;
    const rad = sigma * 3;
    const w = [];
    let wsum = 0;
    for (let k = -rad; k <= rad; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); wsum += v; }
    const sm = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -rad; k <= rad; k++) s += raw[(i + k + N * 8) % N] * w[k + rad];
      sm[i] = s / wsum;
    }
    // slope limit
    const g = 0.085 * this.ds;
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < N; i++) { const p = sm[(i - 1 + N) % N]; sm[i] = clamp(sm[i], p - g, p + g); }
      for (let i = N - 1; i >= 0; i--) { const p = sm[(i + 1) % N]; sm[i] = clamp(sm[i], p - g, p + g); }
    }
    // re-smooth lightly for C1 continuity
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -4; k <= 4; k++) s += sm[(i + k + N) % N];
      out[i] = s / 9;
    }
    this.y = out;
    // pitch (slope along travel)
    this.slope = new Float32Array(N);
    for (let i = 0; i < N; i++) this.slope[i] = (out[(i + 1) % N] - out[(i - 1 + N) % N]) / (2 * this.ds);
    // bounds
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < N; i++) {
      minx = Math.min(minx, this.x[i]); maxx = Math.max(maxx, this.x[i]);
      minz = Math.min(minz, this.z[i]); maxz = Math.max(maxz, this.z[i]);
    }
    this.bounds = { minx, maxx, minz, maxz };
  }

  _hash() {
    this.cell = 40;
    this.grid = new Map();
    for (let i = 0; i < this.N; i++) {
      const k = this._key(Math.floor(this.x[i] / this.cell), Math.floor(this.z[i] / this.cell));
      let a = this.grid.get(k);
      if (!a) { a = []; this.grid.set(k, a); }
      a.push(i);
    }
    // dilated occupancy set => quick rejection for far-away queries
    this.near = new Set();
    for (const key of this.grid.keys()) {
      const cx = Math.floor(key / 8192) - 4096, cz = (key % 8192) - 4096;
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) this.near.add(this._key(cx + dx, cz + dz));
    }
  }
  _key(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }

  wrap(i) { return ((i % this.N) + this.N) % this.N; }

  // project (x,z) onto segment i -> i+1
  _proj(x, z, i) {
    const j = (i + 1) % this.N;
    const ax = this.x[i], az = this.z[i];
    const dx = this.x[j] - ax, dz = this.z[j] - az;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, pz = az + dz * t;
    return { t, px, pz, d2: (x - px) * (x - px) + (z - pz) * (z - pz) };
  }

  // Nearest point on the centerline. hint = previous sample index (fast local search).
  // result: { i, t, s, lat (+ = left), dist, y }
  nearest(x, z, hint = -1, out = {}) {
    let bestI = -1, bestT = 0, bestD = Infinity;
    const search = (lo, hi) => {
      for (let k = lo; k <= hi; k++) {
        const i = this.wrap(k);
        const p = this._proj(x, z, i);
        if (p.d2 < bestD) { bestD = p.d2; bestI = i; bestT = p.t; }
      }
    };
    if (hint >= 0) {
      search(hint - 10, hint + 10);
      if (bestD > 14 * 14) bestI = -1;
    }
    if (bestI < 0) {
      bestD = Infinity;
      const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
      if (!this.near.has(this._key(cx, cz))) { out.i = -1; out.dist = Infinity; return out; }
      let foundAt = -1;
      for (let r = 1; r <= 4; r++) {
        if (foundAt >= 0 && r > foundAt + 1) break;
        for (let ix = cx - r; ix <= cx + r; ix++) {
          for (let iz = cz - r; iz <= cz + r; iz++) {
            if (Math.max(Math.abs(ix - cx), Math.abs(iz - cz)) !== r && r > 1 && foundAt < 0) { /* inner cells already searched */ }
            const a = this.grid.get(this._key(ix, iz));
            if (!a) continue;
            for (const i0 of a) {
              for (let k = -1; k <= 0; k++) {
                const i = this.wrap(i0 + k);
                const p = this._proj(x, z, i);
                if (p.d2 < bestD) { bestD = p.d2; bestI = i; bestT = p.t; foundAt = foundAt < 0 ? r : foundAt; }
              }
            }
          }
        }
      }
    }
    if (bestI < 0) { out.i = -1; out.dist = Infinity; return out; }
    const i = bestI, j = (i + 1) % this.N, t = bestT;
    const cx = lerp(this.x[i], this.x[j], t), cz = lerp(this.z[i], this.z[j], t);
    const tx = lerp(this.tx[i], this.tx[j], t), tz = lerp(this.tz[i], this.tz[j], t);
    const tl = Math.hypot(tx, tz) || 1;
    out.i = i; out.t = t;
    out.s = (i + t) * this.ds;
    out.lat = ((x - cx) * tz - (z - cz) * tx) / tl;
    out.dist = Math.sqrt(bestD);
    out.y = lerp(this.y[i], this.y[j], t);
    out.tx = tx / tl; out.tz = tz / tl;
    out.cx = cx; out.cz = cz;
    return out;
  }

  // Sample the centerline at distance s (wraps). Returns {x,z,y,tx,tz,theta,curv}
  at(s, out = {}) {
    const f = ((s / this.ds) % this.N + this.N) % this.N;
    const i = Math.floor(f), t = f - i, j = (i + 1) % this.N;
    out.x = lerp(this.x[i], this.x[j], t);
    out.z = lerp(this.z[i], this.z[j], t);
    out.y = lerp(this.y[i], this.y[j], t);
    let tx = lerp(this.tx[i], this.tx[j], t), tz = lerp(this.tz[i], this.tz[j], t);
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    out.theta = Math.atan2(out.tx, out.tz);
    out.curv = lerp(this.curv[i], this.curv[j], t);
    out.lx = out.tz; out.lz = -out.tx; // left vector
    return out;
  }

  // max |curvature| over [s, s+dist]
  maxCurv(s, dist) {
    const n = Math.max(1, Math.ceil(dist / this.ds));
    const i0 = Math.floor(s / this.ds);
    let m = 0;
    for (let k = 0; k <= n; k++) m = Math.max(m, Math.abs(this.curv[this.wrap(i0 + k)]));
    return m;
  }
}
