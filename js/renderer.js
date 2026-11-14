// WebGL2 renderer: PBR materials, sky/environment baking, cascaded-ish shadow map, MSAA HDR target,
// bloom + composite post-processing and a small billboard particle system.
import { m4, DEG } from './math.js';
import { createContext, getCaps, ProgramCache, createDepthTexture, checkFBO } from './gl.js';
import {
  UBER_VS, UBER_FS, SKY_VS, SKY_FS, PARTICLE_VS, PARTICLE_FS,
  FULLSCREEN_VS, BLOOM_DOWN_FS, BLOOM_UP_FS, COMPOSITE_FS, DECAL_VS, DECAL_FS,
} from './shaders.js';

export const QUALITY_PRESETS = {
  ultra: { name: 'Ultra', msaa: 4, shadowSize: 4096, shadowRadius: 95, shadowFilter: 1.6, bloom: true, bloomLevels: 6, renderScale: 1.0, dprCap: 2, aniso: 16, maxTexSize: 2048, treeDensity: 1.0, treeLodScale: 1.0, viewDist: 1.0, envSize: 256, particles: 1.0, sunShafts: true },
  high: { name: 'High', msaa: 4, shadowSize: 2048, shadowRadius: 80, shadowFilter: 1.5, bloom: true, bloomLevels: 6, renderScale: 1.0, dprCap: 1.5, aniso: 8, maxTexSize: 2048, treeDensity: 0.8, treeLodScale: 0.85, viewDist: 0.85, envSize: 256, particles: 0.8, sunShafts: true },
  medium: { name: 'Medium', msaa: 2, shadowSize: 2048, shadowRadius: 65, shadowFilter: 1.4, bloom: true, bloomLevels: 5, renderScale: 0.85, dprCap: 1.25, aniso: 4, maxTexSize: 1024, treeDensity: 0.55, treeLodScale: 0.65, viewDist: 0.7, envSize: 128, particles: 0.6, sunShafts: false },
  low: { name: 'Low', msaa: 0, shadowSize: 1024, shadowRadius: 50, shadowFilter: 1.3, bloom: true, bloomLevels: 4, renderScale: 0.7, dprCap: 1, aniso: 2, maxTexSize: 512, treeDensity: 0.3, treeLodScale: 0.45, viewDist: 0.55, envSize: 128, particles: 0.35, sunShafts: false },
};

export class Material {
  constructor(p = {}) {
    this.name = p.name || 'material';
    this.baseColor = p.baseColor || [1, 1, 1, 1];
    this.metallic = p.metallic ?? 0;
    this.roughness = p.roughness ?? 0.8;
    this.emissive = p.emissive || [0, 0, 0];
    this.alphaMode = p.alphaMode || 'OPAQUE'; // OPAQUE | MASK | BLEND
    this.alphaCutoff = p.alphaCutoff ?? 0.5;
    this.doubleSided = !!p.doubleSided;
    this.normalScale = p.normalScale ?? 1;
    this.occStrength = p.occStrength ?? 1;
    this.tex = p.tex || { base: null, mr: null, normal: null, occ: null, emis: null };
    this.foliage = !!p.foliage;
    this.paint = !!p.paint;
    this.lightsEmissive = !!p.lightsEmissive;
    this.grain = !!p.grain;
    this.terrain = !!p.terrain;
    this.road = !!p.road;
    this.mipBoost = p.mipBoost ?? 0;
    this.texA = p.texA || null;
    this.texB = p.texB || null;
    this.texC = p.texC || null;
    this.role = p.role || '';
    this.unlit = !!p.unlit;
  }
}

class Particles {
  constructor(gl, max, additive) {
    this.gl = gl;
    this.max = max;
    this.additive = additive;
    this.n = 0;
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.col = new Float32Array(max * 4); this.a1 = new Float32Array(max);
    this.kind = new Float32Array(max); this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    this.data = new Float32Array(max * 12);
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 48, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
  }
  emit(kind, x, y, z, vx, vy, vz, life, size0, size1, r, g, b, a0, a1 = 0, drag = 0, grav = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = 0; this.maxLife[i] = life;
    this.s0[i] = size0; this.s1[i] = size1;
    this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a0;
    this.a1[i] = a1;
    this.kind[i] = kind; this.drag[i] = drag; this.grav[i] = grav;
  }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        // swap-remove
        const l = --this.n;
        if (i !== l) {
          this.px[i] = this.px[l]; this.py[i] = this.py[l]; this.pz[i] = this.pz[l];
          this.vx[i] = this.vx[l]; this.vy[i] = this.vy[l]; this.vz[i] = this.vz[l];
          this.life[i] = this.life[l]; this.maxLife[i] = this.maxLife[l];
          this.s0[i] = this.s0[l]; this.s1[i] = this.s1[l];
          for (let k = 0; k < 4; k++) this.col[i * 4 + k] = this.col[l * 4 + k];
          this.a1[i] = this.a1[l]; this.kind[i] = this.kind[l]; this.drag[i] = this.drag[l]; this.grav[i] = this.grav[l];
        }
        continue;
      }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vy[i] = this.vy[i] * d - this.grav[i] * dt; this.vz[i] *= d;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      i++;
    }
  }
  upload() {
    const gl = this.gl;
    const D = this.data;
    for (let i = 0; i < this.n; i++) {
      const t = this.life[i] / this.maxLife[i];
      const o = i * 12;
      D[o] = this.px[i]; D[o + 1] = this.py[i]; D[o + 2] = this.pz[i];
      D[o + 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      D[o + 4] = this.col[i * 4]; D[o + 5] = this.col[i * 4 + 1]; D[o + 6] = this.col[i * 4 + 2];
      const a0 = this.col[i * 4 + 3];
      // fade in quickly, fade out toward a1
      const fadeIn = Math.min(1, t * 12);
      D[o + 7] = (a0 + (this.a1[i] - a0) * t) * fadeIn;
      D[o + 8] = this.vx[i]; D[o + 9] = this.vy[i]; D[o + 10] = this.vz[i];
      D[o + 11] = this.kind[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, D, 0, this.n * 12);
  }
}

export class Renderer {
  constructor(canvas, qualityKey = 'high') {
    this.canvas = canvas;
    this.gl = createContext(canvas);
    this.caps = getCaps(this.gl);
    this.programs = new ProgramCache(this.gl);
    this.frameId = 0;
    this.time = 0;
    this.q = { ...QUALITY_PRESETS[qualityKey] };
    this.qualityKey = qualityKey;
    this.state = { cull: null, blend: null, frontFace: null, depthWrite: true, a2c: false, program: null };
    this.boundTex = new Array(16).fill(null);
    this.outScale = this.caps.hdr ? 1 : 0.2;
    this.view = m4.create(); this.proj = m4.create(); this.viewProj = m4.create(); this.invViewProj = m4.create();
    this.camPos = [0, 0, 0];
    this.camRight = [1, 0, 0]; this.camUp = [0, 1, 0];
    this.frustum = new Array(6);
    this.shadowMat = m4.create();
    this.shadowView = m4.create();
    this.shadowProj = m4.create();
    this.shadowFrustum = new Array(6);
    this.shadowEnabled = true;
    this.env = null;            // current environment preset
    this.spots = [];
    this.passType = 'main';
    this.wind = [0.8, 0.6, 1.0];
    this.treeH = 1;
    this.postParams = {};
    this.stats = { draws: 0, tris: 0 };
    this._modelNormal = new Float32Array(9);
    this.texCache = new Map();
    this.fsVAO = this.gl.createVertexArray();
    this._init();
  }

  _init() {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // dummy 1x1 depth texture bound while rendering the shadow map
    this.dummyDepth = createDepthTexture(gl, 1, 1, true);
    this.whiteTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.envCube = null;
    this._createShadowTarget();
    this.particlesAlpha = null;
    this.particlesAdd = null;
    this._createParticles();
    this.resize();
  }

  setQuality(key) {
    this.qualityKey = key;
    this.q = { ...QUALITY_PRESETS[key] };
    this._createShadowTarget();
    this._createParticles();
    this.resize(true);
  }

  _createParticles() {
    const gl = this.gl;
    const n = Math.floor(6000 * this.q.particles) + 400;
    this.particlesAlpha = new Particles(gl, n, false);
    this.particlesAdd = new Particles(gl, n, true);
  }

  _createShadowTarget() {
    const gl = this.gl;
    if (this.shadowFBO) {
      gl.deleteFramebuffer(this.shadowFBO);
      gl.deleteTexture(this.shadowTex);
    }
    const s = this.q.shadowSize;
    this.shadowSize = s;
    this.shadowTex = createDepthTexture(gl, s, s, true);
    this.shadowFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    checkFBO(gl, 'shadow');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- sizes / targets ----
  resize(force = false) {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, this.q.dprCap);
    const cw = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
    const ch = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
    const scale = (this.dynScale || 1) * this.q.renderScale;
    const w = Math.max(2, Math.floor(cw * scale)), h = Math.max(2, Math.floor(ch * scale));
    if (!force && this.canvas.width === cw && this.canvas.height === ch && this.w === w && this.h === h) return;
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.cw = cw; this.ch = ch;
    this.w = w; this.h = h;
    this._createMainTargets();
    this._createBloomTargets();
  }

  setDynamicScale(s) {
    s = Math.max(0.5, Math.min(1, s));
    if (Math.abs(s - (this.dynScale || 1)) < 0.02) return;
    this.dynScale = s;
    this.resize(true);
  }

  _freeTargets(list) {
    const gl = this.gl;
    for (const t of list) {
      if (!t) continue;
      if (t.fbo) gl.deleteFramebuffer(t.fbo);
      if (t.tex) gl.deleteTexture(t.tex);
      if (t.rb) gl.deleteRenderbuffer(t.rb);
      if (t.depth) gl.deleteRenderbuffer(t.depth);
    }
  }

  _createMainTargets() {
    const gl = this.gl;
    this._freeTargets([this.msaa, this.resolve]);
    const hdr = this.caps.hdr;
    const ifmt = hdr ? gl.RGBA16F : gl.RGBA8;
    const w = this.w, h = this.h;
    // resolve target (texture)
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const rfbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, rfbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.resolve = { fbo: rfbo, tex, w, h };
    let samples = Math.min(this.q.msaa, this.caps.maxSamples);
    if (samples > 0) {
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, ifmt, w, h);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      try {
        checkFBO(gl, 'msaa');
        this.msaa = { fbo, rb, depth, w, h, samples };
      } catch (e) {
        console.warn('MSAA target failed, falling back to no MSAA', e);
        gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(rb); gl.deleteRenderbuffer(depth);
        samples = 0;
      }
    }
    if (samples === 0) {
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 0, gl.DEPTH_COMPONENT24, w, h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, rfbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      checkFBO(gl, 'main');
      this.msaa = { fbo: rfbo, depth, w, h, samples: 0, shared: true };
    }
    this.samples = this.msaa.samples;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createBloomTargets() {
    const gl = this.gl;
    if (this.bloomLevels) this._freeTargets(this.bloomLevels);
    this.bloomLevels = [];
    if (!this.q.bloom) return;
    const ifmt = this.caps.hdr ? gl.RGBA16F : gl.RGBA8;
    let w = this.w, h = this.h;
    for (let i = 0; i < this.q.bloomLevels; i++) {
      w = Math.max(2, w >> 1); h = Math.max(2, h >> 1);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.bloomLevels.push({ fbo, tex, w, h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- state helpers ----
  bindTex(unit, tex, target) {
    const gl = this.gl;
    const key = unit;
    const cached = this.boundTex[key];
    if (cached && cached.tex === tex && cached.target === target) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, tex);
    this.boundTex[key] = { tex, target };
  }
  forceBindTex(unit, tex, target) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(target || gl.TEXTURE_2D, tex);
    this.boundTex[unit] = { tex, target };
  }
  setCull(mode) {
    const gl = this.gl;
    if (this.state.cull === mode) return;
    this.state.cull = mode;
    if (mode) { gl.enable(gl.CULL_FACE); gl.cullFace(mode); } else gl.disable(gl.CULL_FACE);
  }
  setBlend(mode) {
    const gl = this.gl;
    if (this.state.blend === mode) return;
    this.state.blend = mode;
    if (!mode) gl.disable(gl.BLEND);
    else {
      gl.enable(gl.BLEND);
      if (mode === 'alpha') gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      else if (mode === 'add') gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      else if (mode === 'one') gl.blendFunc(gl.ONE, gl.ONE);
    }
  }
  setDepthWrite(on) {
    if (this.state.depthWrite === on) return;
    this.state.depthWrite = on;
    this.gl.depthMask(on);
  }
  setA2C(on) {
    on = on && this.samples > 0;
    if (this.state.a2c === on) return;
    this.state.a2c = on;
    if (on) this.gl.enable(this.gl.SAMPLE_ALPHA_TO_COVERAGE); else this.gl.disable(this.gl.SAMPLE_ALPHA_TO_COVERAGE);
  }
  setFrontFace(cw) {
    const mode = cw ? this.gl.CW : this.gl.CCW;
    if (this.state.frontFace === mode) return;
    this.state.frontFace = mode;
    this.gl.frontFace(mode);
  }

  // ---- environment (sky) ----
  // env = { zenith, horizon, ground, sunDir, sunGlow, sunDisc, cloudLit, cloudDark, cloudCover, stars, horizonPow, ... }
  setEnvironment(env) {
    this.env = env;
    this.bakeEnvCube(env);
  }

  _skyProgram() {
    return this.programs.get('sky', SKY_VS, SKY_FS, {});
  }

  _setSkyUniforms(p, env, discClamp) {
    p.v3('uSunDir', ...env.sunDir);
    p.v3('uZenith', ...env.zenith);
    p.v3('uHorizon', ...env.horizon);
    p.v3('uGround', ...env.ground);
    p.v3('uSunGlow', ...env.sunGlow);
    const d = env.sunDisc.map((v) => (discClamp ? Math.min(v, discClamp) : v));
    p.v3('uSunDisc', ...d);
    p.v3('uCloudLit', ...env.cloudLit);
    p.v3('uCloudDark', ...env.cloudDark);
    p.f('uCloudCover', env.cloudCover);
    p.f('uStars', env.stars);
    p.f('uHorizonPow', env.horizonPow ?? 4);
    p.f('uOutScale', this.outScale);
  }

  bakeEnvCube(env) {
    const gl = this.gl;
    const size = this.q.envSize;
    if (this.envCube) gl.deleteTexture(this.envCube);
    const levels = Math.floor(Math.log2(size)) + 1;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, this.caps.hdr ? gl.RGBA16F : gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const p = this._skyProgram();
    p.use();
    this._setSkyUniforms(p, env, 40);
    p.f('uTime', 0);
    p.v3('uCamPos', 0, 0, 0);
    const faces = [
      [gl.TEXTURE_CUBE_MAP_POSITIVE_X, [1, 0, 0], [0, -1, 0]],
      [gl.TEXTURE_CUBE_MAP_NEGATIVE_X, [-1, 0, 0], [0, -1, 0]],
      [gl.TEXTURE_CUBE_MAP_POSITIVE_Y, [0, 1, 0], [0, 0, 1]],
      [gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, [0, -1, 0], [0, 0, -1]],
      [gl.TEXTURE_CUBE_MAP_POSITIVE_Z, [0, 0, 1], [0, -1, 0]],
      [gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, [0, 0, -1], [0, -1, 0]],
    ];
    const proj = m4.create(), view = m4.create(), vp = m4.create(), inv = m4.create();
    m4.perspective(proj, Math.PI / 2, 1, 0.1, 10);
    gl.viewport(0, 0, size, size);
    gl.disable(gl.DEPTH_TEST);
    this.setBlend(null);
    this.setCull(null);
    for (const [target, dir, up] of faces) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, target, tex, 0);
      m4.lookAt(view, [0, 0, 0], dir, up);
      m4.multiply(vp, proj, view);
      m4.invert(inv, vp);
      p.m4('uInvViewProj', inv);
      gl.bindVertexArray(this.fsVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    this.envCube = tex;
    this.envMaxLod = levels - 1;
    this.boundTex[5] = null;
  }

  // ---- camera ----
  setCamera(view, proj, camPos) {
    this.view.set(view);
    this.proj.set(proj);
    m4.multiply(this.viewProj, proj, view);
    m4.invert(this.invViewProj, this.viewProj);
    this.camPos = camPos.slice();
    this.camRight = [view[0], view[4], view[8]];
    this.camUp = [view[1], view[5], view[9]];
    m4.frustumPlanes(this.frustum, this.viewProj);
  }

  // Build a stable orthographic sun shadow matrix following `focus`.
  updateShadow(focus, radius) {
    const sd = this.env.sunDir;
    const size = this.shadowSize;
    const R = radius;
    const dist = 400;
    let up = Math.abs(sd[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
    const eye = [focus[0] + sd[0] * dist, focus[1] + sd[1] * dist, focus[2] + sd[2] * dist];
    m4.lookAt(this.shadowView, eye, focus, up);
    // snap focus to texel grid in light space
    const texel = (2 * R) / size;
    const f = [0, 0, 0];
    m4.transformPoint(f, this.shadowView, focus[0], focus[1], focus[2]);
    const sx = Math.round(f[0] / texel) * texel - f[0];
    const sy = Math.round(f[1] / texel) * texel - f[1];
    const snap = m4.create();
    m4.translation(snap, sx, sy, 0);
    const v2 = m4.create();
    m4.multiply(v2, snap, this.shadowView);
    this.shadowView.set(v2);
    m4.ortho(this.shadowProj, -R, R, -R, R, dist - R * 3.2, dist + R * 1.6);
    m4.multiply(this.shadowMat, this.shadowProj, this.shadowView);
    m4.frustumPlanes(this.shadowFrustum, this.shadowMat);
    this.shadowRadius = R;
    this.shadowTexelWorld = texel;
  }

  // ---- passes ----
  beginFrame(time) {
    this.frameId++;
    this.time = time;
    this.stats.draws = 0;
    this.stats.tris = 0;
  }

  beginShadowPass() {
    const gl = this.gl;
    this.passType = 'shadow';
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFBO);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    this.forceBindTex(6, this.dummyDepth, gl.TEXTURE_2D);
    gl.depthMask(true);
    this.state.depthWrite = true;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.setBlend(null);
    this.setA2C(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2.0, 3.0);
    this.setCull(null);
    this.curViewProj = this.shadowMat;
  }
  endShadowPass() {
    const gl = this.gl;
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.passType = 'main';
  }

  beginMainPass(clearColor = [0, 0, 0]) {
    const gl = this.gl;
    this.passType = 'main';
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msaa.fbo);
    gl.viewport(0, 0, this.w, this.h);
    gl.depthMask(true);
    this.state.depthWrite = true;
    gl.clearColor(clearColor[0] * this.outScale, clearColor[1] * this.outScale, clearColor[2] * this.outScale, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.curViewProj = this.viewProj;
    this.forceBindTex(5, this.envCube, gl.TEXTURE_CUBE_MAP);
    this.forceBindTex(6, this.shadowTex, gl.TEXTURE_2D);
    this.setCull(gl.BACK);
    this.setBlend(null);
    this.setFrontFace(false);
  }

  drawSky() {
    const gl = this.gl;
    const p = this._skyProgram();
    p.use();
    this.state.program = null;
    this._setSkyUniforms(p, this.env, 0);
    p.m4('uInvViewProj', this.invViewProj);
    p.v3('uCamPos', ...this.camPos);
    p.f('uTime', this.time);
    gl.disable(gl.DEPTH_TEST);
    this.setCull(null);
    this.setBlend(null);
    gl.bindVertexArray(this.fsVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    this.setCull(gl.BACK);
  }

  endMainPass() {
    const gl = this.gl;
    this.setA2C(false);
    if (this.msaa.samples > 0) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msaa.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolve.fbo);
      gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, this.w, this.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // ---- program variants ----
  _variant(mat, instanced) {
    const shadow = this.passType === 'shadow';
    const key = (shadow ? 's' : 'm') + (instanced ? 'i' : 'n');
    mat._variants = mat._variants || {};
    let p = mat._variants[key];
    if (p) return p;
    const d = {};
    if (shadow) d.SHADOW_PASS = true;
    if (instanced) d.INSTANCED = true;
    const masked = mat.alphaMode === 'MASK' || (mat.foliage && mat.alphaMode !== 'OPAQUE');
    if (masked) d.ALPHA_MASK = true;
    if (!shadow) {
      if (mat.alphaMode === 'BLEND' && !mat.foliage) d.ALPHA_BLEND = true;
      if (masked) d.A2C = true;
      if (mat.doubleSided) d.DOUBLE_SIDED = true;
      if (mat.foliage) d.FOLIAGE = true;
      if (mat.paint) d.PAINT = true;
      if (mat.lightsEmissive) d.LIGHTS_EMISSIVE = true;
      if (mat.grain) d.GRAIN = true;
      if (mat.terrain) d.TERRAIN = true;
      if (mat.road) d.ROAD = true;
      if (mat.tex.normal) d.TEX_NORMAL = true;
      if (mat.tex.mr) d.TEX_MR = true;
      if (mat.tex.occ) d.TEX_OCC = true;
      if (mat.tex.emis) d.TEX_EMIS = true;
    } else if (masked) {
      d.FOLIAGE = instanced && mat.foliage ? true : undefined;
    }
    if (mat.tex.base) d.TEX_BASE = true;
    p = this.programs.get('uber', UBER_VS, UBER_FS, d);
    if (!p.initialized) {
      p.initialized = true;
      p.use();
      const units = { uTexBase: 0, uTexNormal: 1, uTexMR: 2, uTexOcc: 3, uTexEmis: 4, uEnvSpec: 5, uShadowMap: 6, uTexA: 7, uTexB: 8, uTexC: 9 };
      for (const k in units) p.tex(k, units[k]);
    }
    mat._variants[key] = p;
    return p;
  }

  _applyFrame(p) {
    p.frameStamp = this.frameId;
    p.passType = this.passType;
    p.m4('uViewProj', this.curViewProj);
    p.f('uTime', this.time);
    p.v3('uWind', this.wind[0], this.wind[1], this.wind[2]);
    if (this.passType === 'shadow') return;
    const e = this.env;
    p.v3('uCamPos', ...this.camPos);
    p.v3('uSunDir', ...e.sunDir);
    p.v3('uSunColor', ...e.sunColor);
    p.f('uEnvMaxLod', this.envMaxLod);
    p.f('uAmbLod', Math.max(0, this.envMaxLod - 3));
    p.f('uEnvIntensity', e.envIntensity);
    p.v3('uAmbientTint', ...(e.ambientTint || [1, 1, 1]));
    p.m4('uShadowMat', this.shadowMat);
    const sh = this.shadowEnabled ? 1 : 0;
    p.v4('uShadowParams', 1 / this.shadowSize, this.shadowTexelWorld * 1.6, 0.0006 * (sh ? 1 : 0) - (sh ? 0 : 10), this.q.shadowFilter);
    p.v3('uFogColor', ...e.fogColor);
    p.v3('uFogSunColor', ...e.fogSunColor);
    p.f('uFogDensity', e.fogDensity);
    p.v2('uFogHeight', e.fogHeightBase ?? 0, e.fogHeightFalloff ?? 0.004);
    p.f('uOutScale', this.outScale);
    const n = Math.min(4, this.spots.length);
    p.i('uNumSpots', n);
    if (n > 0) {
      const pos = new Float32Array(16), dir = new Float32Array(16), col = new Float32Array(16);
      for (let i = 0; i < n; i++) {
        const s = this.spots[i];
        pos.set([s.pos[0], s.pos[1], s.pos[2], s.range], i * 4);
        dir.set([s.dir[0], s.dir[1], s.dir[2], s.cosOuter], i * 4);
        col.set([s.color[0], s.color[1], s.color[2], s.cosInner], i * 4);
      }
      p.v4a('uSpotPos', pos);
      p.v4a('uSpotDir', dir);
      p.v4a('uSpotColor', col);
    }
  }

  _bindMaterial(p, mat, opts) {
    const gl = this.gl;
    const shadow = this.passType === 'shadow';
    // textures
    if (mat.tex.base) this.bindTex(0, mat.tex.base, gl.TEXTURE_2D);
    if (!shadow) {
      if (mat.tex.normal) this.bindTex(1, mat.tex.normal, gl.TEXTURE_2D);
      if (mat.tex.mr) this.bindTex(2, mat.tex.mr, gl.TEXTURE_2D);
      if (mat.tex.occ) this.bindTex(3, mat.tex.occ, gl.TEXTURE_2D);
      if (mat.tex.emis) this.bindTex(4, mat.tex.emis, gl.TEXTURE_2D);
      if (mat.texA) this.bindTex(7, mat.texA, gl.TEXTURE_2D);
      if (mat.texB) this.bindTex(8, mat.texB, gl.TEXTURE_2D);
      if (mat.texC) this.bindTex(9, mat.texC, gl.TEXTURE_2D);
    }
    const bc = mat.baseColor;
    p.v4('uBaseColor', bc[0], bc[1], bc[2], bc[3]);
    p.f('uAlphaCutoff', mat.foliage || mat.alphaMode === 'MASK' ? mat.alphaCutoff : Math.min(mat.alphaCutoff, 0.4));
    if (shadow) return;
    p.v2('uMR', mat.metallic, mat.roughness);
    p.v3('uEmissive', mat.emissive[0], mat.emissive[1], mat.emissive[2]);
    p.f('uNormalScale', mat.normalScale);
    p.f('uOccStrength', mat.occStrength);
    p.f('uMipBoost', mat.mipBoost);
    p.f('uWet', opts && opts.wet !== undefined ? opts.wet : (this.env.wet || 0));
    const pa = (opts && opts.paint) || [0, 1, 1, 0];
    p.v4('uPaint', pa[0], pa[1], pa[2], pa[3]);
    p.f('uEmissiveBoost', opts && opts.emissiveBoost !== undefined ? opts.emissiveBoost : 0);
  }

  _setupMat(mat, instanced, opts) {
    const gl = this.gl;
    const p = this._variant(mat, instanced);
    if (this.state.program !== p) {
      p.use();
      this.state.program = p;
    }
    if (p.frameStamp !== this.frameId || p.passType !== this.passType) this._applyFrame(p);
    this._bindMaterial(p, mat, opts);
    const shadow = this.passType === 'shadow';
    if (shadow) {
      this.setCull(null);
    } else {
      this.setCull(mat.doubleSided ? null : gl.BACK);
      const blend = mat.alphaMode === 'BLEND' && !mat.foliage;
      this.setBlend(blend ? 'alpha' : null);
      this.setDepthWrite(!blend);
      const masked = mat.alphaMode === 'MASK' || (mat.foliage && mat.alphaMode !== 'OPAQUE');
      this.setA2C(masked);
    }
    return p;
  }

  // Draw a single mesh with a model matrix. normalMat optional (computed if omitted).
  drawMesh(mesh, mat, model, opts) {
    const p = this._setupMat(mat, false, opts);
    p.m4('uModel', model);
    if (this.passType !== 'shadow') {
      const nm = opts && opts.normalMat ? opts.normalMat : m4.normalMat3(this._modelNormal, model);
      p.m3('uNormalMat', nm);
    }
    this.setFrontFace(m4.det3(model) < 0);
    mesh.draw();
    this.stats.draws++;
    this.stats.tris += mesh.triCount;
  }

  // Draw instanced (mesh must have an instance buffer bound). count = number of instances
  drawInstanced(mesh, mat, count, treeH, opts) {
    if (count <= 0) return;
    const p = this._setupMat(mat, true, opts);
    p.f('uTreeH', treeH);
    this.setFrontFace(false);
    mesh.drawInstanced(count);
    this.stats.draws++;
    this.stats.tris += mesh.triCount * count;
  }

  // ---- flat additive decals (static batch: {vao, buf, n}) ----
  makeDecalBatch(data) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    for (let i = 0; i < 2; i++) {
      gl.enableVertexAttribArray(i);
      gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, i * 16);
      gl.vertexAttribDivisor(i, 1);
    }
    gl.bindVertexArray(null);
    return { vao, buf, n: data.length / 8, data };
  }
  drawDecals(batch, first = 0, count = batch.n) {
    if (!batch || count <= 0) return;
    const gl = this.gl;
    const p = this.programs.get('decal', DECAL_VS, DECAL_FS, {});
    p.use();
    this.state.program = null;
    p.m4('uViewProj', this.viewProj);
    p.f('uOutScale', this.outScale);
    this.setCull(null);
    this.setBlend('add');
    gl.depthMask(false);
    this.state.depthWrite = false;
    this.setA2C(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    gl.bindVertexArray(batch.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.state.depthWrite = true;
    this.setBlend(null);
    this.setCull(gl.BACK);
  }

  // ---- particles ----
  drawParticles() {
    const gl = this.gl;
    const p = this.programs.get('particle', PARTICLE_VS, PARTICLE_FS, {});
    p.use();
    this.state.program = null;
    p.m4('uViewProj', this.viewProj);
    p.v3('uCamPos', ...this.camPos);
    p.v3('uCamRight', ...this.camRight);
    p.v3('uCamUp', ...this.camUp);
    p.f('uOutScale', this.outScale);
    p.f('uTime', this.time);
    this.setCull(null);
    gl.depthMask(false);
    this.state.depthWrite = false;
    this.setA2C(false);
    for (const ps of [this.particlesAlpha, this.particlesAdd]) {
      if (ps.n === 0) continue;
      this.setBlend(ps.additive ? 'add' : 'alpha');
      ps.upload();
      gl.bindVertexArray(ps.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ps.n);
    }
    gl.depthMask(true);
    this.state.depthWrite = true;
    this.setBlend(null);
    this.setCull(gl.BACK);
  }

  // ---- post ----
  post(pp) {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    this.setCull(null);
    this.setBlend(null);
    this.setA2C(false);
    gl.bindVertexArray(this.fsVAO);
    this.state.program = null;
    const inScale = 1 / this.outScale;
    const levels = this.bloomLevels;
    let bloomTex = this.whiteTex;
    if (levels.length) {
      const down = this.programs.get('bloomdown', FULLSCREEN_VS, BLOOM_DOWN_FS, {});
      down.use();
      down.tex('uSrc', 0);
      let srcTex = this.resolve.tex, sw = this.w, sh = this.h;
      for (let i = 0; i < levels.length; i++) {
        const L = levels[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo);
        gl.viewport(0, 0, L.w, L.h);
        this.forceBindTex(0, srcTex, gl.TEXTURE_2D);
        down.v2('uTexel', 1 / sw, 1 / sh);
        down.f('uThreshold', pp.bloomThreshold ?? 1.0);
        down.f('uKnee', pp.bloomKnee ?? 0.6);
        down.i('uFirst', i === 0 ? 1 : 0);
        down.f('uInScale', i === 0 ? inScale : 1);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        srcTex = L.tex; sw = L.w; sh = L.h;
      }
      const up = this.programs.get('bloomup', FULLSCREEN_VS, BLOOM_UP_FS, {});
      up.use();
      up.tex('uSrc', 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.state.blend = 'one';
      for (let i = levels.length - 2; i >= 0; i--) {
        const L = levels[i], S = levels[i + 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, L.fbo);
        gl.viewport(0, 0, L.w, L.h);
        this.forceBindTex(0, S.tex, gl.TEXTURE_2D);
        up.v2('uTexel', 1 / S.w, 1 / S.h);
        up.f('uWeight', 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      this.setBlend(null);
      bloomTex = levels[0].tex;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.cw, this.ch);
    const c = this.programs.get('composite', FULLSCREEN_VS, COMPOSITE_FS, {});
    c.use();
    c.tex('uScene', 0);
    c.tex('uBloom', 1);
    this.forceBindTex(0, this.resolve.tex, gl.TEXTURE_2D);
    this.forceBindTex(1, bloomTex, gl.TEXTURE_2D);
    c.f('uInScale', inScale);
    c.f('uBloomStrength', levels.length ? (pp.bloom ?? 0.25) : 0);
    c.f('uExposure', pp.exposure ?? 1);
    c.f('uBlur', pp.blur ?? 0);
    c.v2('uBlurCenter', pp.blurCx ?? 0.5, pp.blurCy ?? 0.5);
    c.f('uCA', pp.ca ?? 0);
    c.f('uVignette', pp.vignette ?? 0.3);
    c.f('uSpeedLines', pp.speedLines ?? 0);
    c.f('uFlash', pp.flash ?? 0);
    const fc = pp.flashColor || [1, 0.8, 0.5];
    c.v3('uFlashColor', fc[0], fc[1], fc[2]);
    c.f('uTime', this.time);
    c.f('uSaturation', pp.saturation ?? 1.05);
    const lift = pp.lift || [0, 0, 0];
    c.v3('uLift', lift[0], lift[1], lift[2]);
    const gain = pp.gain || [1, 1, 1];
    c.v3('uGain', gain[0], gain[1], gain[2]);
    c.f('uContrast', pp.contrast ?? 1.05);
    c.v2('uSunUV', pp.sunU ?? 0.5, pp.sunV ?? 0.5);
    c.f('uSunShaft', levels.length && this.q.sunShafts ? (pp.sunShaft ?? 0) : 0);
    c.f('uAspect', this.cw / this.ch);
    c.f('uGrain', pp.grain ?? 0.012);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
  }

  // ---- visibility helpers ----
  inFrustum(x, y, z, r) {
    const f = this.frustum;
    for (let i = 0; i < 6; i++) {
      const p = f[i];
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
    }
    return true;
  }
  inShadowFrustum(x, y, z, r) {
    const f = this.shadowFrustum;
    for (let i = 0; i < 6; i++) {
      const p = f[i];
      if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
    }
    return true;
  }
}
