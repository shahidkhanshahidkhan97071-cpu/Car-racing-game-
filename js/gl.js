// Thin WebGL2 helpers: programs with uniform caching, textures, framebuffers, mesh/VAO building.

export function createContext(canvas) {
  const opts = {
    antialias: false, // we do MSAA on our own render target
    alpha: false,
    depth: true,  // default framebuffer depth is used by the lite (mobile) render path
    stencil: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    desynchronized: false,
  };
  const gl = canvas.getContext('webgl2', opts);
  if (!gl) throw new Error('WebGL2 is not supported by this browser/GPU.');
  return gl;
}

export function getCaps(gl) {
  const caps = {
    maxSamples: gl.getParameter(gl.MAX_SAMPLES),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    colorBufferHalf: !!gl.getExtension('EXT_color_buffer_half_float'),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    maxAniso: 1,
    renderer: 'unknown',
  };
  if (caps.aniso) caps.maxAniso = gl.getParameter(caps.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) caps.renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
  caps.hdr = caps.colorBufferFloat || caps.colorBufferHalf;
  return caps;
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
    console.error(`Shader compile error (${label}):\n${log}\n${lines}`);
    throw new Error(`Shader compile error (${label}): ${log}`);
  }
  return sh;
}

export class Program {
  constructor(gl, vsSrc, fsSrc, defines = {}, label = 'prog') {
    this.gl = gl;
    this.label = label;
    let pre = '#version 300 es\n';
    for (const k in defines) {
      const v = defines[k];
      if (v === false || v === undefined || v === null) continue;
      pre += v === true ? `#define ${k}\n` : `#define ${k} ${v}\n`;
    }
    const strip = (s) => s.replace(/^\s*#version 300 es\s*\n/, '');
    const vs = compile(gl, gl.VERTEX_SHADER, pre + strip(vsSrc), label + ':vs');
    const fs = compile(gl, gl.FRAGMENT_SHADER, pre + strip(fsSrc), label + ':fs');
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      console.error(`Program link error (${label}): ${log}`);
      throw new Error(`Program link error (${label}): ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = p;
    this.locs = new Map();
    this.frameStamp = -1;
  }
  use() {
    this.gl.useProgram(this.program);
  }
  loc(name) {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.locs.set(name, l);
    }
    return l;
  }
  has(name) {
    return this.loc(name) !== null;
  }
  f(name, v) { const l = this.loc(name); if (l) this.gl.uniform1f(l, v); }
  i(name, v) { const l = this.loc(name); if (l) this.gl.uniform1i(l, v); }
  v2(name, a, b) { const l = this.loc(name); if (l) this.gl.uniform2f(l, a, b); }
  v3(name, a, b, c) { const l = this.loc(name); if (l) this.gl.uniform3f(l, a, b, c); }
  v4(name, a, b, c, d) { const l = this.loc(name); if (l) this.gl.uniform4f(l, a, b, c, d); }
  v3a(name, arr) { const l = this.loc(name); if (l) this.gl.uniform3fv(l, arr); }
  v4a(name, arr) { const l = this.loc(name); if (l) this.gl.uniform4fv(l, arr); }
  m4(name, m) { const l = this.loc(name); if (l) this.gl.uniformMatrix4fv(l, false, m); }
  m3(name, m) { const l = this.loc(name); if (l) this.gl.uniformMatrix3fv(l, false, m); }
  // bind sampler uniform to texture unit
  tex(name, unit) { const l = this.loc(name); if (l) this.gl.uniform1i(l, unit); }
}

export class ProgramCache {
  constructor(gl) {
    this.gl = gl;
    this.map = new Map();
  }
  get(label, vs, fs, defines = {}) {
    const key = label + '|' + Object.keys(defines).sort().map((k) => k + '=' + defines[k]).join(',');
    let p = this.map.get(key);
    if (!p) {
      p = new Program(this.gl, vs, fs, defines, key);
      this.map.set(key, p);
    }
    return p;
  }
}

// ---------- textures ----------
export function createTexture2D(gl, opts) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const { width, height, internalFormat = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, data = null,
    min = gl.LINEAR, mag = gl.LINEAR, wrapS = gl.CLAMP_TO_EDGE, wrapT = gl.CLAMP_TO_EDGE, mips = false, levels = 1 } = opts;
  if (mips) {
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(width, height))) + 1, internalFormat, width, height);
    if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, type, data);
    gl.generateMipmap(gl.TEXTURE_2D);
  } else {
    gl.texStorage2D(gl.TEXTURE_2D, levels, internalFormat, width, height);
    if (data) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, type, data);
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, mag);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  return t;
}

// upload an ImageBitmap / canvas / ImageData to a mipmapped texture
export function textureFromSource(gl, caps, src, { srgb = false, wrap = gl.REPEAT, aniso = 8, maxSize = 4096, mirror = false } = {}) {
  let w = src.width, h = src.height;
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texStorage2D(gl.TEXTURE_2D, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (caps.aniso && aniso > 1) gl.texParameterf(gl.TEXTURE_2D, caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, caps.maxAniso));
  return t;
}


// upload raw RGBA8 bytes (Uint8Array) to a mipmapped texture
export function textureFromData(gl, caps, data, w, h, { srgb = false, wrap = gl.REPEAT, aniso = 8 } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texStorage2D(gl.TEXTURE_2D, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, w, h);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  if (caps.aniso && aniso > 1) gl.texParameterf(gl.TEXTURE_2D, caps.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, caps.maxAniso));
  return t;
}

export function createDepthTexture(gl, w, h, compare = true) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT32F, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (compare) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  }
  return t;
}

export function checkFBO(gl, label) {
  const s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (s !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete (${label}): 0x${s.toString(16)}`);
  }
}

// ---------- geometry ----------
// Standard vertex layout used by every static mesh:
// 0: position vec3, 1: normal vec3, 2: uv vec2, 3: color vec4 (normalized ubyte or float)
export class Mesh {
  constructor(gl, { positions, normals, uvs, colors, indices }) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbos = [];
    const addAttrib = (loc, data, size, type = gl.FLOAT, normalized = false) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
      this.vbos.push(b);
    };
    addAttrib(0, positions, 3);
    if (normals) addAttrib(1, normals, 3); else gl.vertexAttrib3f(1, 0, 1, 0);
    if (uvs) addAttrib(2, uvs, 2); else gl.vertexAttrib2f(2, 0, 0);
    if (colors) {
      if (colors instanceof Uint8Array) addAttrib(3, colors, 4, gl.UNSIGNED_BYTE, true);
      else addAttrib(3, colors, 4);
    } else gl.vertexAttrib4f(3, 1, 1, 1, 1);
    this.ibo = null;
    this.count = positions.length / 3;
    this.indexType = gl.UNSIGNED_SHORT;
    if (indices) {
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.count = indices.length;
      this.indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : indices instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT;
    }
    gl.bindVertexArray(null);
    this.triCount = this.count / 3;
    // instancing support: attach an instance buffer lazily
    this.instBuf = null;
    this.instCap = 0;
  }
  // attach (or grow) a dynamic per-instance buffer; layout 8 floats: vec4 @5, vec4 @6
  ensureInstanceBuffer(cap) {
    const gl = this.gl;
    if (this.instBuf && this.instCap >= cap) return;
    if (!this.instBuf) this.instBuf = gl.createBuffer();
    this.instCap = Math.max(cap, 64);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.instCap * 32, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
  }
  // share an instance buffer owned by another mesh (same layout) with this VAO
  bindInstanceBuffer(buf) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(5);
    gl.vertexAttribPointer(5, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(5, 1);
    gl.enableVertexAttribArray(6);
    gl.vertexAttribPointer(6, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null);
  }
  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.ibo) gl.drawElements(gl.TRIANGLES, this.count, this.indexType, 0);
    else gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
  drawInstanced(n) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.ibo) gl.drawElementsInstanced(gl.TRIANGLES, this.count, this.indexType, 0, n);
    else gl.drawArraysInstanced(gl.TRIANGLES, 0, this.count, n);
  }
  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const b of this.vbos) gl.deleteBuffer(b);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.instBuf) gl.deleteBuffer(this.instBuf);
  }
}

// Procedural mesh builder (positions/normals/uvs/colors/indices) used for road, props, etc.
export class MeshBuilder {
  constructor() {
    this.p = [];
    this.n = [];
    this.uv = [];
    this.c = [];
    this.i = [];
    this.vcount = 0;
  }
  vert(x, y, z, nx, ny, nz, u, v, r = 1, g = 1, b = 1, a = 1) {
    this.p.push(x, y, z);
    this.n.push(nx, ny, nz);
    this.uv.push(u, v);
    this.c.push(r, g, b, a);
    return this.vcount++;
  }
  tri(a, b, c) {
    this.i.push(a, b, c);
  }
  quad(a, b, c, d) {
    this.i.push(a, b, c, a, c, d);
  }
  // transformed box centered at origin w/ half extents; matrix m (Float32Array 16) optional
  box(cx, cy, cz, hx, hy, hz, color = [1, 1, 1, 1], yaw = 0) {
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [0, 0, 1], [-1, 0, 0]],
      [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    for (const [nrm, up, rt] of faces) {
      const base = this.vcount;
      for (let k = 0; k < 4; k++) {
        const su = k === 0 || k === 3 ? -1 : 1;
        const sv = k < 2 ? -1 : 1;
        let lx = nrm[0] * hx + rt[0] * su * hx + up[0] * sv * hx;
        let ly = nrm[1] * hy + rt[1] * su * hy + up[1] * sv * hy;
        let lz = nrm[2] * hz + rt[2] * su * hz + up[2] * sv * hz;
        // yaw rotate about Y
        const rx = lx * cs + lz * sn, rz = -lx * sn + lz * cs;
        const nx = nrm[0] * cs + nrm[2] * sn, nz = -nrm[0] * sn + nrm[2] * cs;
        this.vert(cx + rx, cy + ly, cz + rz, nx, nrm[1], nz, (su + 1) / 2, (sv + 1) / 2, color[0], color[1], color[2], color[3]);
      }
      this.quad(base, base + 1, base + 2, base + 3);
    }
  }
  cylinder(cx, cy, cz, radius, height, seg = 12, color = [1, 1, 1, 1], capTop = true) {
    const base = this.vcount;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      this.vert(cx + c * radius, cy, cz + s * radius, c, 0, s, i / seg, 0, ...color);
      this.vert(cx + c * radius, cy + height, cz + s * radius, c, 0, s, i / seg, 1, ...color);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.tri(a, a + 2, a + 1);
      this.tri(a + 1, a + 2, a + 3);
    }
    if (capTop) {
      const ctr = this.vert(cx, cy + height, cz, 0, 1, 0, 0.5, 0.5, ...color);
      const rb = this.vcount;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * radius, cy + height, cz + Math.sin(a) * radius, 0, 1, 0, 0.5, 0.5, ...color);
      }
      for (let i = 0; i < seg; i++) this.tri(ctr, rb + i + 1, rb + i);
    }
  }
  build(gl) {
    const idx = this.vcount > 65535 ? new Uint32Array(this.i) : new Uint16Array(this.i);
    return new Mesh(gl, {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.n),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.c),
      indices: idx,
    });
  }
  bounds() {
    let minx = 1e9, miny = 1e9, minz = 1e9, maxx = -1e9, maxy = -1e9, maxz = -1e9;
    for (let i = 0; i < this.p.length; i += 3) {
      minx = Math.min(minx, this.p[i]); maxx = Math.max(maxx, this.p[i]);
      miny = Math.min(miny, this.p[i + 1]); maxy = Math.max(maxy, this.p[i + 1]);
      minz = Math.min(minz, this.p[i + 2]); maxz = Math.max(maxz, this.p[i + 2]);
    }
    const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
    return { center: [cx, cy, cz], radius: Math.hypot(maxx - cx, maxy - cy, maxz - cz) };
  }
}
