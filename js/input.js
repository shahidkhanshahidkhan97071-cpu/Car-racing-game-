// Keyboard + gamepad input. Steering: + = left.
const KEYMAP = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  handbrake: ['Space'], nitro: ['ShiftLeft', 'ShiftRight', 'KeyN'],
};
const EDGE = { camera: ['KeyC'], reset: ['KeyR'], pause: ['Escape', 'KeyP'], mute: ['KeyM'], look: ['KeyV'] };

export class Input {
  constructor() {
    this.down = new Set();
    this.edge = new Set();
    this.pad = { steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: 0 };
    this.padPrev = {};
    this.usingPad = false;
    this.enabled = true;
    addEventListener('keydown', (e) => {
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.edge.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => this.down.clear());
  }
  held(list) { for (const k of list) if (this.down.has(k)) return true; return false; }
  pressed(name) {
    for (const k of EDGE[name]) if (this.edge.has(k)) return true;
    return !!this.padEdge && !!this.padEdge[name];
  }
  poll() {
    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    this.padEdge = {};
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const b = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
      const steer = -dz(gp.axes[0] || 0);
      const p = {
        steer: Math.sign(steer) * Math.pow(Math.abs(steer), 1.35),
        throttle: Math.max(b(7), b(0) ? 0 : 0),
        brake: b(6),
        handbrake: b(2) || b(5) ? 1 : 0,
        nitro: b(0) || b(1) ? 1 : 0,
      };
      if (!gp.buttons[7] || (!gp.buttons[7].value && !gp.buttons[6].value && gp.axes.length >= 6)) {
        // some browsers expose triggers as axes
        const a5 = gp.axes[5] !== undefined ? (gp.axes[5] + 1) / 2 : 0;
        const a4 = gp.axes[4] !== undefined ? (gp.axes[4] + 1) / 2 : 0;
        if (a5 > 0.05 && b(7) === 0) p.throttle = a5;
        if (a4 > 0.05 && b(6) === 0) p.brake = a4;
      }
      const edges = { camera: 3, reset: 8, pause: 9, look: 4 };
      for (const k in edges) {
        const on = !!(gp.buttons[edges[k]] && gp.buttons[edges[k]].pressed);
        if (on && !this.padPrev[k]) this.padEdge[k] = true;
        this.padPrev[k] = on;
      }
      this.pad = p;
      if (p.steer || p.throttle > 0.05 || p.brake > 0.05) this.usingPad = true;
    } else this.pad = { steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: 0 };
  }
  // consume edge flags at end of frame
  endFrame() { this.edge.clear(); this.padEdge = {}; }
  get() {
    this.poll();
    const k = this.down;
    let steer = (this.held(KEYMAP.left) ? 1 : 0) - (this.held(KEYMAP.right) ? 1 : 0);
    let throttle = this.held(KEYMAP.up) ? 1 : 0;
    let brake = this.held(KEYMAP.down) ? 1 : 0;
    let handbrake = this.held(KEYMAP.handbrake) ? 1 : 0;
    let nitro = this.held(KEYMAP.nitro) ? 1 : 0;
    const p = this.pad;
    if (Math.abs(p.steer) > Math.abs(steer)) steer = p.steer;
    throttle = Math.max(throttle, p.throttle);
    brake = Math.max(brake, p.brake);
    handbrake = Math.max(handbrake, p.handbrake);
    nitro = Math.max(nitro, p.nitro);
    if (!this.enabled) return { steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: 0 };
    return { steer, throttle, brake, handbrake, nitro };
  }
}
