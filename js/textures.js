// Procedural textures (generated at startup on a 2D canvas / typed arrays): road, asphalt detail, ground layers.
import { textureFromData } from './gl.js';
import { mulberry32 } from './math.js';

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// periodic value noise helper (tileable)
function tileNoise(period, seed) {
  const rng = mulberry32(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
    const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0], b = g[y0 * period + x1], c = g[y1 * period + x0], d = g[y1 * period + x1];
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}
function tileFbm(size, baseFreq, oct, seed) {
  const ns = [];
  for (let i = 0; i < oct; i++) ns.push(tileNoise(baseFreq << i, seed + i * 7));
  return (u, v) => {
    // u,v in [0,1)
    let s = 0, a = 0.5, n = 0;
    for (let i = 0; i < oct; i++) {
      const f = baseFreq << i;
      s += a * ns[i](u * f, v * f);
      n += a;
      a *= 0.5;
    }
    return s / n;
  };
}

function lum(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// Upload a canvas as RGBA with alpha channel replaced by a height map derived from luminance
function canvasWithHeight(gl, caps, canvas, opts, heightFn) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = heightFn ? heightFn(d[i], d[i + 1], d[i + 2], i) : Math.min(255, lum(d[i], d[i + 1], d[i + 2]) * 1.2);
  }
  return textureFromData(gl, caps, new Uint8Array(d.buffer), canvas.width, canvas.height, opts);
}

function seamlessStroke(ctx, S, x0, y0, x1, y1, w, style) {
  ctx.strokeStyle = style;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  const minx = Math.min(x0, x1) - w, maxx = Math.max(x0, x1) + w;
  const miny = Math.min(y0, y1) - w, maxy = Math.max(y0, y1) + w;
  for (let ox = -1; ox <= 1; ox++) {
    if (minx + ox * S >= S || maxx + ox * S <= 0) continue;
    for (let oy = -1; oy <= 1; oy++) {
      if (miny + oy * S >= S || maxy + oy * S <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(x0 + ox * S, y0 + oy * S);
      ctx.lineTo(x1 + ox * S, y1 + oy * S);
      ctx.stroke();
    }
  }
}

export function makeGrassTexture(gl, caps, opts, tint = [0.5, 0.55, 0.25]) {
  const S = 512;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const rng = mulberry32(1337);
  const fb = tileFbm(S, 4, 4, 5);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fb(x / S, y / S);
      const k = 0.45 + n * 0.75;
      const o = (y * S + x) * 4;
      img.data[o] = tint[0] * 255 * k * 0.75;
      img.data[o + 1] = tint[1] * 255 * k * 0.8;
      img.data[o + 2] = tint[2] * 255 * k * 0.6;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // grass blades
  for (let i = 0; i < 26000; i++) {
    const x = rng() * S, y = rng() * S;
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.5;
    const len = 5 + rng() * 11;
    const shade = 0.5 + rng() * 0.9;
    const yel = rng() * 0.35;
    const r = Math.min(255, (tint[0] * 255 * shade) * (0.8 + yel)) | 0;
    const g = Math.min(255, tint[1] * 255 * shade * 1.15) | 0;
    const b = Math.min(255, tint[2] * 255 * shade * 0.7) | 0;
    seamlessStroke(ctx, S, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 1 + rng() * 1.3, `rgb(${r},${g},${b})`);
  }
  // dry patches / clover specks
  for (let i = 0; i < 900; i++) {
    const x = rng() * S, y = rng() * S;
    ctx.fillStyle = `rgba(${120 + rng() * 60},${105 + rng() * 40},${50},${0.18 + rng() * 0.2})`;
    ctx.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 2);
  }
  return canvasWithHeight(gl, caps, c, { srgb: true, aniso: opts.aniso }, (r, g, b) => Math.min(255, g * 1.1));
}

export function makeForestFloorTexture(gl, caps, opts, tint = [0.32, 0.25, 0.17]) {
  const S = 512;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const rng = mulberry32(4242);
  const fb = tileFbm(S, 4, 5, 9);
  const mossNoise = tileFbm(S, 3, 3, 77);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fb(x / S, y / S);
      const m = mossNoise(x / S, y / S);
      const k = 0.35 + n * 0.8;
      const moss = Math.max(0, m - 0.55) * 2.2;
      const o = (y * S + x) * 4;
      img.data[o] = (tint[0] * 255 * k) * (1 - moss * 0.6) + moss * 40;
      img.data[o + 1] = (tint[1] * 255 * k) * (1 - moss * 0.2) + moss * 70;
      img.data[o + 2] = (tint[2] * 255 * k) * (1 - moss * 0.5) + moss * 15;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // pine needles / twigs
  for (let i = 0; i < 14000; i++) {
    const x = rng() * S, y = rng() * S;
    const ang = rng() * Math.PI * 2;
    const len = 6 + rng() * 20;
    const sh = 0.4 + rng() * 0.9;
    const r = Math.min(255, 150 * sh * (0.8 + rng() * 0.4)) | 0;
    const g = Math.min(255, 96 * sh * (0.8 + rng() * 0.3)) | 0;
    const b = Math.min(255, 52 * sh) | 0;
    seamlessStroke(ctx, S, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 0.8 + rng() * 0.9, `rgb(${r},${g},${b})`);
  }
  for (let i = 0; i < 160; i++) {
    const x = rng() * S, y = rng() * S, ang = rng() * 6.28, len = 18 + rng() * 40;
    seamlessStroke(ctx, S, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 1.5 + rng() * 1.5, `rgb(${60 + rng() * 25 | 0},${42 + rng() * 15 | 0},${28})`);
  }
  return canvasWithHeight(gl, caps, c, { srgb: true, aniso: opts.aniso }, (r, g, b) => Math.min(255, lum(r, g, b) * 1.5));
}

export function makeRockTexture(gl, caps, opts) {
  const S = 512;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const rng = mulberry32(999);
  const fb = tileFbm(S, 6, 5, 21);
  const fb2 = tileFbm(S, 16, 3, 33);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = fb(x / S, y / S), n2 = fb2(x / S, y / S);
      const k = 0.35 + n * 0.55 + n2 * 0.25;
      const o = (y * S + x) * 4;
      img.data[o] = 150 * k;
      img.data[o + 1] = 138 * k;
      img.data[o + 2] = 120 * k;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < 400; i++) {
    const x = rng() * S, y = rng() * S, ang = rng() * 6.28, len = 10 + rng() * 40;
    seamlessStroke(ctx, S, x, y, x + Math.cos(ang) * len, y + Math.sin(ang) * len, 0.7 + rng(), `rgba(30,26,22,${0.25 + rng() * 0.3})`);
  }
  for (let i = 0; i < 5000; i++) {
    const x = rng() * S, y = rng() * S, r = 0.6 + rng() * 1.8, v = 90 + rng() * 120;
    ctx.fillStyle = `rgb(${v},${v * 0.94},${v * 0.86})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.28); ctx.fill();
  }
  return canvasWithHeight(gl, caps, c, { srgb: true, aniso: opts.aniso }, (r, g, b) => Math.min(255, lum(r, g, b) * 1.3));
}

// Fine asphalt grain for the road detail layer. rgb: albedo variation, a: height
export function makeAsphaltDetailTexture(gl, caps, opts) {
  const S = 256;
  const rng = mulberry32(31337);
  const fbA = tileFbm(S, 16, 4, 3);
  const fbB = tileFbm(S, 3, 3, 8);
  const grain = tileNoise(128, 99);
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      const n = fbA(x / S, y / S);
      const gr = grain(x / 2, y / 2); // 2px correlated grain (avoids per-pixel sparkle)
      const speck = rng() > 0.992 ? 0.25 : 0;
      const v = 0.62 + n * 0.45 + (gr - 0.5) * 0.28 + speck;
      data[o] = Math.min(255, v * 190);
      data[o + 1] = Math.min(255, (0.6 + fbB(x / S, y / S) * 0.7) * 190);
      data[o + 2] = Math.min(255, v * 190);
      data[o + 3] = Math.min(255, (n * 0.7 + gr * 0.5 + speck) * 200);
    }
  }
  return textureFromData(gl, caps, data, S, S, { srgb: false, aniso: opts.aniso });
}

// Road albedo (+ roughness in alpha, markings encoded as alpha >= 0.9).
// u spans the full 20 m cross-section (-10..10), v spans 24 m along the road.
export const ROAD_TEX = { widthM: 20, lengthM: 24, half: 8 };
export function makeRoadTexture(gl, caps, opts, { wet = 0 } = {}) {
  const W = 1024, H = 1024;
  const rng = mulberry32(2024);
  const mx = (x) => (x / W - 0.5) * ROAD_TEX.widthM; // pixel -> meters across
  const my = (y) => (y / H) * ROAD_TEX.lengthM;
  const fbA = tileFbm(512, 4, 5, 15);
  const col = makeCanvas(W, H), rough = makeCanvas(W, H);
  const cc = col.getContext('2d'), rc = rough.getContext('2d');
  const ci = cc.createImageData(W, H), ri = rc.createImageData(W, H);
  const lanes = [-6, -2, 2, 6];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = mx(x);
      const n = fbA((x % 512) / 512, (y % 512) / 512);
      const o = (y * W + x) * 4;
      let r, g, b, rg;
      const onRoad = Math.abs(m) <= ROAD_TEX.half;
      if (onRoad) {
        let base = 0.17 + n * 0.045 + (rng() - 0.5) * 0.03;
        // worn wheel paths: darker, polished
        let wear = 0;
        for (const lc of lanes) {
          for (const off of [-0.85, 0.85]) {
            const d = (m - (lc + off)) / 0.42;
            wear = Math.max(wear, Math.exp(-d * d));
          }
        }
        base *= 1 - wear * 0.22;
        r = base * 255 * 1.02; g = base * 255 * 1.0; b = base * 255 * 1.06;
        rg = 0.66 - wear * 0.2 + (n - 0.5) * 0.12;
      } else {
        const base = 0.26 + n * 0.12 + (rng() - 0.5) * 0.05;
        r = base * 255 * 1.1; g = base * 255 * 1.02; b = base * 255 * 0.9;
        rg = 0.9;
      }
      ci.data[o] = r; ci.data[o + 1] = g; ci.data[o + 2] = b; ci.data[o + 3] = 255;
      const rv = Math.max(0, Math.min(1, rg)) * 255;
      ri.data[o] = rv; ri.data[o + 1] = rv; ri.data[o + 2] = rv; ri.data[o + 3] = 255;
    }
  }
  cc.putImageData(ci, 0, 0);
  rc.putImageData(ri, 0, 0);
  const px = (m) => (m / ROAD_TEX.widthM + 0.5) * W;
  const py = (m) => (m / ROAD_TEX.lengthM) * H;
  // patched repairs
  for (let i = 0; i < 5; i++) {
    const x = px(-7 + rng() * 14), y = rng() * H, w = 50 + rng() * 90, h = 40 + rng() * 120;
    const v = 0.95 + rng() * 0.2;
    cc.fillStyle = `rgba(${44 * v},${44 * v},${46 * v},0.22)`;
    cc.fillRect(x, y, w, h);
    rc.fillStyle = 'rgba(190,190,190,0.2)';
    rc.fillRect(x, y, w, h);
  }
  // cracks
  cc.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    let x = px(-7.5 + rng() * 15), y = rng() * H;
    cc.strokeStyle = `rgba(14,14,15,${0.18 + rng() * 0.22})`;
    cc.lineWidth = 0.6 + rng() * 0.9;
    cc.beginPath(); cc.moveTo(x, y);
    const seg = 4 + (rng() * 8 | 0);
    let a = rng() * 6.28;
    for (let k = 0; k < seg; k++) {
      a += (rng() - 0.5) * 1.2;
      x += Math.cos(a) * (14 + rng() * 26); y += Math.sin(a) * (14 + rng() * 26);
      cc.lineTo(x, y);
    }
    cc.stroke();
  }
  // oil stains
  for (let i = 0; i < 7; i++) {
    const x = px(-6 + rng() * 12), y = rng() * H, r = 20 + rng() * 40;
    const gr = cc.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(8,8,10,0.28)'); gr.addColorStop(1, 'rgba(5,5,7,0)');
    cc.fillStyle = gr; cc.fillRect(x - r, y - r, r * 2, r * 2);
    const gr2 = rc.createRadialGradient(x, y, 0, x, y, r);
    gr2.addColorStop(0, 'rgba(60,60,60,0.8)'); gr2.addColorStop(1, 'rgba(60,60,60,0)');
    rc.fillStyle = gr2; rc.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // rubber marks near edges + tire streaks along the road
  for (let i = 0; i < 40; i++) {
    const lane = lanes[(rng() * 4) | 0] + (rng() < 0.5 ? -0.85 : 0.85);
    const x = px(lane + (rng() - 0.5) * 0.2), y = rng() * H, len = 80 + rng() * 300;
    cc.fillStyle = `rgba(6,6,8,${0.04 + rng() * 0.05})`;
    cc.fillRect(x - 6, y, 12, len);
  }
  // ---- markings ----
  const drawMark = (xm, w, dashed, color) => {
    const x0 = px(xm - w / 2), wpx = (w / ROAD_TEX.widthM) * W;
    const dash = 3.0, gap = 9.0; // meters, period 12 => tile of 24 m holds exactly two
    if (!dashed) {
      cc.fillStyle = color; cc.fillRect(x0, 0, wpx, H);
      rc.fillStyle = '#fff'; rc.fillRect(x0, 0, wpx, H);
    } else {
      for (let m = 1.0; m < ROAD_TEX.lengthM; m += dash + gap) {
        cc.fillStyle = color; cc.fillRect(x0, py(m), wpx, py(dash));
        rc.fillStyle = '#fff'; rc.fillRect(x0, py(m), wpx, py(dash));
      }
    }
  };
  drawMark(-7.8, 0.22, false, 'rgb(215,215,208)');
  drawMark(7.8, 0.22, false, 'rgb(215,215,208)');
  drawMark(-4, 0.16, true, 'rgb(205,205,198)');
  drawMark(0, 0.16, true, 'rgb(205,205,198)');
  drawMark(4, 0.16, true, 'rgb(205,205,198)');
  // weathering on marks
  const mi = cc.getImageData(0, 0, W, H);
  const rI = rc.getImageData(0, 0, W, H);
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const rv = rI.data[o];
    let r = mi.data[o], g = mi.data[o + 1], b = mi.data[o + 2];
    let a = rv;
    if (rv > 250) {
      const w = 0.78 + rng() * 0.22;
      r *= w; g *= w; b *= w;
      a = 245 + (rng() * 9 | 0); // markings: alpha >= 0.96
    } else {
      a = Math.min(rv, 225);
    }
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
  return textureFromData(gl, caps, out, W, H, { srgb: true, wrap: gl.REPEAT, aniso: opts.aniso });
}

// checkered start/finish line texture (opaque RGBA, sRGB)
export function makeCheckerTexture(gl, caps, opts) {
  const c = makeCanvas(256, 64);
  const ctx = c.getContext('2d');
  const n = 16, s = 256 / n;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = (x + y) % 2 ? '#101010' : '#f2f2f2';
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  const d = ctx.getImageData(0, 0, 256, 64);
  return textureFromData(gl, caps, new Uint8Array(d.data.buffer), 256, 64, { srgb: true, wrap: gl.CLAMP_TO_EDGE, aniso: opts.aniso });
}

// banner / billboard textures with fictional brands (opaque)
export function makeBannerTexture(gl, caps, text, sub, c1, c2, opts, w = 1024, h = 256) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // diagonal stripes
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#fff';
  for (let i = -h; i < w; i += 60) {
    ctx.beginPath(); ctx.moveTo(i, h); ctx.lineTo(i + 30, h); ctx.lineTo(i + 30 + h, 0); ctx.lineTo(i + h, 0); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `italic 900 ${h * 0.46}px "Arial Black", Impact, sans-serif`;
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 4;
  ctx.fillText(text, w / 2, h * 0.44);
  ctx.shadowColor = 'transparent';
  if (sub) {
    ctx.font = `600 ${h * 0.14}px Arial, sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(sub, w / 2, h * 0.82);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 6; ctx.strokeRect(10, 10, w - 20, h - 20);
  const d = ctx.getImageData(0, 0, w, h);
  return textureFromData(gl, caps, new Uint8Array(d.data.buffer), w, h, { srgb: true, wrap: gl.CLAMP_TO_EDGE, aniso: opts.aniso });
}

// chevron (turn warning) sign texture
export function makeChevronTexture(gl, caps, opts) {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#ffc400'; ctx.fillRect(10, 10, S - 20, S - 20);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 34; ctx.lineJoin = 'miter';
  ctx.beginPath(); ctx.moveTo(70, 50); ctx.lineTo(190, 128); ctx.lineTo(70, 206); ctx.stroke();
  const d = ctx.getImageData(0, 0, S, S);
  return textureFromData(gl, caps, new Uint8Array(d.data.buffer), S, S, { srgb: true, wrap: gl.CLAMP_TO_EDGE, aniso: opts.aniso });
}

// radial glow sprite (used for fake light pools / flares)
export function makeGlowTexture(gl, caps) {
  const S = 128;
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
      const r = Math.hypot(dx, dy);
      const a = Math.max(0, 1 - r);
      const v = a * a * (3 - 2 * a);
      const o = (y * S + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = v * 255;
    }
  }
  return textureFromData(gl, caps, data, S, S, { srgb: false, wrap: gl.CLAMP_TO_EDGE, aniso: 1 });
}
