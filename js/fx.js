// Visual effects helpers: contact shadow under cars, particle emitters (smoke, sparks, nitro flames, dust).
import { clamp } from './math.js';

const BLOB_VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat4 uViewProj;
uniform vec3 uCenter;
uniform vec3 uAx;
uniform vec3 uAz;
out vec2 vUV;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vUV = c;
  gl_Position = uViewProj * vec4(uCenter + uAx * c.x + uAz * c.y, 1.0);
}`;
const BLOB_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform float uAlpha;
out vec4 outColor;
void main() {
  vec2 q = abs(vUV);
  // rounded-rectangle falloff: dark core under the chassis, soft edges
  float d = pow(pow(q.x, 3.0) + pow(q.y, 3.0), 1.0 / 3.0);
  float a = 1.0 - smoothstep(0.25, 1.0, d);
  outColor = vec4(0.0, 0.0, 0.0, a * a * uAlpha);
}`;

export function drawContactShadow(r, v, car, alpha = 0.55) {
  const gl = r.gl;
  const p = r.programs.get('blob', BLOB_VS, BLOB_FS, {});
  p.use();
  r.state.program = null;
  const sy = Math.sin(v.yaw), cy = Math.cos(v.yaw);
  const hw = car.dims.width * 0.5 * 1.18, hl = car.dims.length * 0.5 * 1.05;
  const pitch = (v.pitch || 0), roll = (v.roll || 0);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  p.m4('uViewProj', r.viewProj);
  const lift = clamp(v.y - (v.groundY ?? v.y), 0, 3);
  p.v3('uCenter', v.x, v.y + 0.045 - lift, v.z);
  p.v3('uAx', cy * hw, Math.sin(roll) * hw, -sy * hw);
  p.v3('uAz', sy * cp * hl, sp * hl, cy * cp * hl);
  p.f('uAlpha', alpha * (1 - clamp(lift / 1.5, 0, 1)));
  r.setCull(null);
  r.setBlend('alpha');
  gl.depthMask(false);
  r.state.depthWrite = false;
  r.setA2C(false);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-2, -4);
  gl.bindVertexArray(r.fsVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.depthMask(true);
  r.state.depthWrite = true;
  r.setBlend(null);
  r.setCull(gl.BACK);
}

// ---- particles ----
// kinds: 0 soft, 1 spark streak, 2 smoke puff, 3 glow
export class FX {
  constructor(renderer) {
    this.r = renderer;
    this.acc = new Map();
    this.q = renderer.q.particles;
  }
  setQuality() { this.q = this.r.q.particles; }

  // fractional emission helper
  _count(key, rate, dt) {
    const a = (this.acc.get(key) || 0) + rate * dt * this.q;
    const n = Math.floor(a);
    this.acc.set(key, a - n);
    return n;
  }

  tyreSmoke(key, x, y, z, vx, vz, intensity, dt, color = [0.82, 0.82, 0.86]) {
    const n = this._count(key, 38 * intensity, dt);
    const P = this.r.particlesAlpha;
    for (let i = 0; i < n; i++) {
      const j = () => (Math.random() - 0.5);
      P.emit(2, x + j() * 0.3, y + 0.4, z + j() * 0.3,
        vx * 0.25 + j() * 1.6, 0.7 + Math.random() * 1.1, vz * 0.25 + j() * 1.6,
        0.8 + Math.random() * 0.7, 0.35, 1.3 + Math.random() * 0.8,
        color[0], color[1], color[2], 0.17 * intensity + 0.04, 0, 1.3, -0.12);
    }
  }

  dust(key, x, y, z, vx, vz, intensity, dt) {
    const n = this._count(key, 55 * intensity, dt);
    const P = this.r.particlesAlpha;
    for (let i = 0; i < n; i++) {
      const j = () => (Math.random() - 0.5);
      P.emit(2, x + j() * 0.6, y + 0.5, z + j() * 0.6, vx * 0.2 + j() * 2.4, 0.9 + Math.random() * 1.4, vz * 0.2 + j() * 2.4,
        1.1 + Math.random() * 0.9, 0.6, 3.4, 0.52, 0.44, 0.32, 0.34, 0, 1.6, -0.1);
    }
  }

  sparks(x, y, z, nx, nz, vx, vz, count = 6) {
    const P = this.r.particlesAdd;
    count = Math.max(1, Math.round(count * this.q + Math.random()));
    for (let i = 0; i < count; i++) {
      const sp = 3 + Math.random() * 9;
      const rx = (Math.random() - 0.5) * 5, rz = (Math.random() - 0.5) * 5;
      P.emit(1, x, y, z, vx * 0.6 - nx * sp + rx, 1.5 + Math.random() * 4, vz * 0.6 - nz * sp + rz,
        0.28 + Math.random() * 0.42, 0.22, 0.04, 7 + Math.random() * 3, 3.2 + Math.random() * 2, 0.6, 1, 0, 0.6, 14);
    }
    // flash
    P.emit(3, x, y, z, 0, 0, 0, 0.08, 0.9, 0.3, 5, 3, 1, 0.9, 0);
  }

  nitroFlame(key, x, y, z, bx, bz, speed, intensity, dt) {
    const n = this._count(key, 160 * intensity, dt);
    const P = this.r.particlesAdd;
    for (let i = 0; i < n; i++) {
      const j = () => (Math.random() - 0.5);
      const sp = 7 + speed * 0.08 + Math.random() * 4;
      P.emit(3, x + j() * 0.08, y + j() * 0.08, z + j() * 0.08, bx * sp + j() * 0.9, j() * 0.9, bz * sp + j() * 0.9,
        0.14 + Math.random() * 0.12, 0.42, 0.1, 0.5, 1.3, 4.5, 0.95, 0, 3, 0);
      if (i % 2 === 0) P.emit(3, x, y, z, bx * sp * 0.6, 0, bz * sp * 0.6, 0.09, 0.22, 0.05, 4, 4, 5, 1, 0, 3, 0);
    }
    if (Math.random() < 0.3 * this.q * intensity) {
      P.emit(1, x, y, z, bx * 14 + j2(), j2() * 1.5, bz * 14 + j2(), 0.35, 0.18, 0.03, 4, 2.2, 0.8, 1, 0, 0.3, 6);
    }
  }

  boostPuff(x, y, z, vx, vz) {
    const P = this.r.particlesAdd;
    for (let i = 0; i < 10 * this.q; i++) P.emit(3, x, y, z, vx * 0.5 + j2() * 3, 0.5 + Math.random(), vz * 0.5 + j2() * 3, 0.3, 1.2, 0.2, 0.5, 1.2, 4, 0.8, 0, 3, 0);
  }

  update(dt) {
    this.r.particlesAlpha.update(dt);
    this.r.particlesAdd.update(dt);
  }
}
function j2() { return (Math.random() - 0.5) * 2; }
