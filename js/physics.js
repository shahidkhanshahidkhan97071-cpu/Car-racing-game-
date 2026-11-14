// Arcade vehicle physics + AI driver. Conventions: yaw 0 faces +Z, +X is the vehicle's LEFT, steer > 0 = steer left.
import { clamp, lerp, wrapAngle, damp } from './math.js';
import { ROAD_HALF, SHOULDER, CAR_LIMIT } from './track.js';

const G = 9.81;
const GEARS = [0.17, 0.29, 0.42, 0.57, 0.76, 1.0]; // gear top speeds as fraction of base top speed

export class Vehicle {
  constructor(model, { isPlayer = false, name = 'Car', color = null, skill = 1 } = {}) {
    this.model = model;
    this.isPlayer = isPlayer;
    this.name = name;
    this.color = color;
    this.skill = skill;
    const d = model.dims;
    this.halfW = Math.max(0.9, d.width / 2 - 0.05);
    this.halfL = d.length / 2;
    this.wheelbase = d.wheelbase;
    this.wheelRadius = d.wheelRadius;
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vz = 0; this.vy = 0;
    this.yaw = 0; this.yawRate = 0;
    this.steerIn = 0;       // smoothed input (+ left)
    this.steerVis = 0;      // rad, front wheel visual
    this.pitch = 0; this.roll = 0; this.bob = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.nitro = 35;
    this.nitroOn = false;
    this.nitroGlow = 0;
    this.drifting = false;
    this.driftTime = 0;
    this.driftAngle = 0;
    this.driftScore = 0;
    this.slipAngle = 0;
    this.rpm = 0.2; this.gear = 0; this.shiftTimer = 0;
    this.braking = false;
    this.airborne = false;
    this.hint = -1;
    this.s = 0; this.lat = 0; this.lap = -1; this.progress = 0; this.lastS = 0;
    this.finished = false; this.finishTime = 0;
    this.impact = 0;
    this.scrape = 0;
    this.events = [];
    this.speed = 0; this.vF = 0; this.vL = 0;
    this.surface = 'road';
    this.nearest = {};
    this.lapTimes = []; this.lapStart = 0; this.bestLap = Infinity;
    this.wrongWay = 0;
    this.boostTimer = 0;
    this.topSpeedBase = model.stats.topSpeed;
    this.radius = 1.15;
    this.ctl = { steer: 0, throttle: 0, brake: 0, handbrake: 0, nitro: 0 };
    this.place = 1;
    this.rb = 1;
  }

  placeAt(track, s, lat, world) {
    const p = track.at(s);
    const lx = p.tz, lz = -p.tx;
    this.x = p.x + lx * lat; this.z = p.z + lz * lat;
    this.yaw = p.theta;
    this.y = p.y + 0.035;
    this.vx = this.vz = this.vy = 0; this.yawRate = 0;
    this.hint = Math.floor(track.wrap(Math.floor(s / track.ds)));
    track.nearest(this.x, this.z, this.hint, this.nearest);
    this.s = this.nearest.s; this.lastS = this.s; this.lat = this.nearest.lat;
    // lap starts at -1 if we're behind the start line (s close to the end of the lap)
    this.lap = this.s > track.length * 0.5 ? -1 : 0;
    this.progress = this.lap * track.length + this.s;
    this.nitro = 35;
    this.finished = false;
    this.lapTimes = []; this.bestLap = Infinity;
  }

  surfaceY(track, world, x, z, hint) {
    const n = track.nearest(x, z, hint, this._sn || (this._sn = {}));
    if (n.i >= 0 && Math.abs(n.lat) < SHOULDER) return n.y + 0.035;
    return world.heightAt(x, z);
  }

  gearInfo(v) {
    const vm = this.topSpeedBase;
    let g = 0;
    while (g < GEARS.length - 1 && v > GEARS[g] * vm * 0.985) g++;
    const top = GEARS[g] * vm;
    const lo = g > 0 ? GEARS[g - 1] * vm * 0.62 : 0;
    const r = clamp((v - lo) / Math.max(1, top - lo), 0, 1);
    return { g, rpm: 0.22 + r * 0.78 };
  }

  update(dt, ctl, track, world, time) {
    const st = this.model.stats;
    this.events.length = 0;
    this.wallCd = (this.wallCd || 0) - dt;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const lx = fz, lz = -fx;
    let vF = this.vx * fx + this.vz * fz;
    let vL = this.vx * lx + this.vz * lz;
    const speed = Math.hypot(this.vx, this.vz);
    const absF = Math.abs(vF);

    // surface
    const nr = track.nearest(this.x, this.z, this.hint, this.nearest);
    if (nr.i >= 0) this.hint = nr.i;
    this.lat = nr.lat;
    const aLat = Math.abs(nr.lat);
    this.surface = aLat > ROAD_HALF + 1.2 ? 'shoulder' : 'road';

    // ---- inputs ----
    const throttleIn = clamp(ctl.throttle, 0, 1);
    const brakeIn = clamp(ctl.brake, 0, 1);
    const hb = ctl.handbrake > 0.5;
    const wantNitro = ctl.nitro > 0.5 && this.nitro > 0.5 && !this.finishedLocked;
    // steering smoothing (keyboard-friendly)
    const target = clamp(ctl.steer, -1, 1);
    const rate = Math.abs(target) > Math.abs(this.steerIn) ? 7.5 : 12;
    this.steerIn += (target - this.steerIn) * damp(rate, dt);

    // ---- engine ----
    let vmax = this.topSpeedBase * (this.isPlayer ? 1 : this.skill);
    let accel = 15.5 * st.accel * (this.isPlayer ? 1 : this.skill * this.rb);
    this.nitroOn = wantNitro && throttleIn > 0.1 || (wantNitro && !this.isPlayer);
    if (this.boostTimer > 0) this.boostTimer -= dt;
    let boost = 1;
    if (this.nitroOn) {
      boost = 1.85;
      vmax *= 1.2 * (0.9 + 0.1 * st.nitro);
      this.nitro = Math.max(0, this.nitro - 21 * dt / Math.max(0.6, st.nitro));
      accel += 5;
    }
    if (this.boostTimer > 0) { vmax *= 1.06; boost *= 1.25; }
    if (this.surface === 'shoulder') vmax *= 0.8;
    const ratio = clamp(vF / vmax, 0, 1.4);
    let aEng = throttleIn * accel * boost * Math.max(0, 1 - Math.pow(ratio, 1.7));
    // gear shifts: brief torque cut
    const gi = this.gearInfo(Math.max(0, vF));
    if (gi.g !== this.gear) { if (gi.g > this.gear) this.shiftTimer = 0.12; this.gear = gi.g; }
    if (this.shiftTimer > 0) { this.shiftTimer -= dt; aEng *= 0.35; }
    // traction limit
    aEng = Math.min(aEng, 17 * st.grip * (hb ? 0.6 : 1));
    // over-speed bleed
    let aDrag = 0.0007 * vF * Math.abs(vF) + 1.1 * Math.sign(vF);
    if (vF > vmax) aDrag += (vF - vmax) * 2.2;
    if (this.surface === 'shoulder') aDrag += 5 * Math.sign(vF);
    let aBrake = 0;
    this.braking = false;
    if (brakeIn > 0.05) {
      if (vF > 1.2) { aBrake = -brakeIn * 34 * st.brake; this.braking = true; }
      else {
        // reverse
        aEng = -brakeIn * 9;
        if (vF < -14) aEng = 0;
      }
    }
    if (hb && vF > 2) aBrake -= 7;
    let dvF = (aEng - aDrag + aBrake) * dt;
    // don't let drag/brake flip the sign of vF
    if ((vF > 0 && vF + dvF < 0 && aEng <= 0) || (vF < 0 && vF + dvF > 0 && aEng >= 0)) vF = 0; else vF += dvF;

    // ---- steering / yaw ----
    const L = this.wheelbase;
    const vref = 30;
    const maxSteer = 0.52 / (1 + Math.pow(absF / vref, 1.6)) * (0.85 + 0.25 * st.handling);
    const delta = this.steerIn * maxSteer;
    const dir = vF >= 0 ? 1 : -1;
    let omegaT = (dir * absF * Math.tan(delta)) / L;
    // tire grip limits
    const down = 0.0014 * absF * absF;                       // aero downforce
    let grip = (14.5 + down) * st.grip;
    const slideFactor = this.surface === 'shoulder' ? 0.7 : 1;
    grip *= slideFactor;
    let rearGrip = grip;
    const steerAbs = Math.abs(this.steerIn);
    // brake-drift: braking while turning unloads the rear axle
    if (this.braking && steerAbs > 0.35 && absF > 24) rearGrip *= 1 - 0.55 * brakeIn * steerAbs;
    if (hb) rearGrip *= 0.3;
    const driftAssist = hb && absF > 14;
    const wMaxGrip = grip / Math.max(absF, 4);
    let wMax = wMaxGrip * (driftAssist ? 2.1 : (rearGrip < grip ? 1.6 : 1.0));
    omegaT = clamp(omegaT * (driftAssist ? 1.35 : 1), -wMax, wMax);
    // slide counter-steer help: when sliding, yaw tends to follow the velocity
    this.yawRate += (omegaT - this.yawRate) * damp(driftAssist ? 5.5 : 9, dt);
    // limit spin-out: damp yaw when slip angle is huge
    const slip = Math.atan2(vL, Math.max(Math.abs(vF), 1));
    if (Math.abs(slip) > 0.9) this.yawRate *= 1 - damp(3, dt);

    // ---- lateral grip ----
    const Ca = 11.5 * (this.surface === 'shoulder' ? 0.7 : 1);
    let dvL = -vL * (1 - Math.exp(-Ca * (rearGrip / grip) * dt));
    const maxDv = rearGrip * dt;
    dvL = clamp(dvL, -maxDv, maxDv);
    vL += dvL;
    // scrub: a part of the removed lateral speed is converted into forward speed (drifts keep momentum)
    vF += Math.abs(dvL) * 0.55 * Math.sign(vF || 1);
    // world velocity from car frame (heading BEFORE rotation)
    this.vx = fx * vF + lx * vL;
    this.vz = fz * vF + lz * vL;
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    // ---- integrate position ----
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.speed = Math.hypot(this.vx, this.vz);
    this.vF = vF; this.vL = vL;
    this.slipAngle = Math.atan2(vL, Math.max(Math.abs(vF), 0.5)) * (vF >= 0 ? 1 : -1);

    // ---- drift bookkeeping ----
    const slideAng = Math.abs(this.slipAngle);
    const isDrift = absF > 16 && slideAng > 0.15 && slideAng < 1.25 && this.surface === 'road';
    if (isDrift) {
      this.drifting = true;
      this.driftTime += dt;
      this.driftAngle = slideAng;
      this.nitro = Math.min(100, this.nitro + dt * (8 + 20 * slideAng) * (this.nitroOn ? 0.0 : 1));
      this.driftScore += dt * absF * slideAng * 2.2;
    } else if (this.drifting && slideAng < 0.1) {
      if (this.driftTime > 0.9) {
        this.nitro = Math.min(100, this.nitro + 6);
        this.boostTimer = Math.min(1.4, this.boostTimer + 0.7);
        this.events.push({ type: 'driftEnd', score: Math.round(this.driftScore), time: this.driftTime });
      }
      this.drifting = false; this.driftTime = 0; this.driftScore = 0;
    } else if (!isDrift && this.driftTime > 0 && slideAng < 0.15) {
      this.driftTime = Math.max(0, this.driftTime - dt * 3);
      if (this.driftTime === 0) { this.drifting = false; this.driftScore = 0; }
    }

    // ---- walls ----
    this._collideWalls(track, dt);

    // ---- vertical ----
    const hint = this.hint;
    const sf = this.surfaceY(track, world, this.x, this.z, hint);
    const fz2 = Math.sin(this.yaw) * 0 + Math.cos(this.yaw), fx2 = Math.sin(this.yaw);
    const lx2 = fz2, lz2 = -fx2;
    const hf = this.surfaceY(track, world, this.x + fx2 * 1.35, this.z + fz2 * 1.35, hint);
    const hr = this.surfaceY(track, world, this.x - fx2 * 1.35, this.z - fz2 * 1.35, hint);
    const hl = this.surfaceY(track, world, this.x + lx2 * 0.95, this.z + lz2 * 0.95, hint);
    const hrr = this.surfaceY(track, world, this.x - lx2 * 0.95, this.z - lz2 * 0.95, hint);
    const groundY = (hf + hr) * 0.5;
    this.groundY = groundY;
    const targetPitch = Math.atan2(hf - hr, 2.7);
    const targetRoll = Math.atan2(hl - hrr, 1.9);
    // ballistic vs ground contact
    const prevY = this.y;
    let ny = prevY + this.vy * dt - 0.5 * G * dt * dt;
    if (ny <= groundY + 0.002) {
      const impactV = -this.vy;
      if (this.airborne && impactV > 3) this.events.push({ type: 'land', v: impactV });
      this.airborne = false;
      this.vy = (groundY - prevY) / dt;
      this.y = groundY;
      this.vy = clamp(this.vy, -20, 20);
    } else {
      this.vy -= G * dt;
      this.y = ny;
      this.airborne = this.y - groundY > 0.25;
    }
    this.pitch += (targetPitch - this.pitch) * damp(12, dt);
    this.roll += (targetRoll - this.roll) * damp(10, dt);

    // ---- visuals ----
    this.steerVis = this.steerIn * 0.45 * (1 - clamp(absF / 120, 0, 0.6));
    const spinBase = (this.vF / this.wheelRadius) * dt;
    for (let i = 0; i < 4; i++) {
      this.wheelSpin[i] = (this.wheelSpin[i] + spinBase * (hb && i >= 2 ? 0.15 : 1)) % (Math.PI * 2);
    }
    this.nitroGlow += ((this.nitroOn ? 1 : 0) - this.nitroGlow) * damp(this.nitroOn ? 14 : 5, dt);
    const gi2 = this.gearInfo(Math.max(0, vF));
    this.rpm += (gi2.rpm - this.rpm) * damp(12, dt);
    if (throttleIn < 0.05) this.rpm = Math.max(0.2, this.rpm - 0.15 * dt);
    // body dynamics (visual): longitudinal accel -> pitch, lateral -> roll
    const accelF = (aEng - aDrag + aBrake);
    this.bodyPitch = (this.bodyPitch || 0) + ((accelF * 0.0018) - (this.bodyPitch || 0)) * damp(8, dt);
    const latAcc = this.yawRate * vF;
    this.bodyRoll = (this.bodyRoll || 0) + ((latAcc * 0.0030) - (this.bodyRoll || 0)) * damp(8, dt);
    this.impact *= Math.exp(-4 * dt);
    this.scrape = Math.max(0, this.scrape - dt * 4);

    // ---- progress ----
    const prevS = this.lastS;
    this.s = nr.s;
    let ds = this.s - prevS;
    if (ds < -track.length / 2) { this.lap++; this.events.push({ type: 'lap', lap: this.lap }); }
    else if (ds > track.length / 2) { this.lap--; }
    this.lastS = this.s;
    this.progress = this.lap * track.length + this.s;
    // wrong way
    const heading = nr.i >= 0 ? (this.vx * nr.tx + this.vz * nr.tz) : 1;
    this.wrongWay = heading < -4 ? this.wrongWay + dt : Math.max(0, this.wrongWay - dt * 2);
  }

  _collideWalls(track, dt) {
    const n = this.nearest;
    if (n.i < 0) return;
    const tlx = n.tz, tlz = -n.tx; // left unit vector of the track at nearest
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const lx = fz, lz = -fx;
    let worst = 0, wr = null, wSide = 0;
    const hw = this.halfW, hl = this.halfL - 0.1;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const rx = lx * sx * hw + fx * sz * hl, rz = lz * sx * hw + fz * sz * hl;
        const latC = n.lat + rx * tlx + rz * tlz;
        const pen = Math.abs(latC) - CAR_LIMIT;
        if (pen > worst) { worst = pen; wr = [rx, rz]; wSide = Math.sign(latC); }
      }
    }
    if (worst <= 0) return;
    // push back
    this.x -= tlx * wSide * worst;
    this.z -= tlz * wSide * worst;
    const nx = tlx * wSide, nz = tlz * wSide; // outward normal
    const vn = this.vx * nx + this.vz * nz;
    if (vn > 0) {
      const e = 0.25;
      this.vx -= (1 + e) * vn * nx;
      this.vz -= (1 + e) * vn * nz;
      // friction along the wall: a small one-off loss per impact + time based scrape deceleration
      const sp0 = Math.hypot(this.vx, this.vz);
      if (sp0 > 0.01) {
        const dec = Math.min(sp0, vn * 0.1 + (3.0 + 0.9 * vn) * dt * 2);
        this.vx -= (this.vx / sp0) * dec; this.vz -= (this.vz / sp0) * dec;
      }
      // torque: contact lever -> rotate nose away
      const Fx = -nx, Fz = -nz;
      this.yawRate += clamp((wr[1] * Fx - wr[0] * Fz) * vn * 0.06, -1.6, 1.6);
      this.yawRate *= 0.9;
      this.impact = Math.max(this.impact, vn);
      this.scrape = 1;
      if (vn > 2.5 && this.wallCd <= 0) {
        this.wallCd = 0.18;
        this.events.push({ type: 'wall', v: vn, x: this.x + wr[0], y: this.y + 0.3, z: this.z + wr[1], nx, nz });
      } else this.events.push({ type: 'scrape', x: this.x + wr[0], y: this.y + 0.3, z: this.z + wr[1], nx, nz, v: this.speed });
    } else {
      // sliding along the wall
      this.scrape = Math.max(this.scrape, 0.6);
      { const sp0 = Math.hypot(this.vx, this.vz); const dec = Math.min(sp0, 7 * dt); if (sp0 > 0.01) { this.vx -= (this.vx / sp0) * dec; this.vz -= (this.vz / sp0) * dec; } }
      this.events.push({ type: 'scrape', x: this.x + wr[0], y: this.y + 0.3, z: this.z + wr[1], nx, nz, v: this.speed });
    }
  }
}

// circle-based car vs car collision
export function collideVehicles(a, b) {
  const af = [Math.sin(a.yaw), Math.cos(a.yaw)], bf = [Math.sin(b.yaw), Math.cos(b.yaw)];
  const ac = [[a.x + af[0] * 1.2, a.z + af[1] * 1.2], [a.x - af[0] * 1.2, a.z - af[1] * 1.2]];
  const bc = [[b.x + bf[0] * 1.2, b.z + bf[1] * 1.2], [b.x - bf[0] * 1.2, b.z - bf[1] * 1.2]];
  let hit = false;
  for (const p of ac) {
    for (const q of bc) {
      let dx = p[0] - q[0], dz = p[1] - q[1];
      const d = Math.hypot(dx, dz);
      const R = a.radius + b.radius;
      if (d >= R || d < 1e-4) continue;
      dx /= d; dz /= d;
      const pen = R - d;
      a.x += dx * pen * 0.5; a.z += dz * pen * 0.5;
      b.x -= dx * pen * 0.5; b.z -= dz * pen * 0.5;
      const rvx = a.vx - b.vx, rvz = a.vz - b.vz;
      const vn = rvx * dx + rvz * dz;
      if (vn < 0) {
        const j = -(1 + 0.35) * vn * 0.5;
        a.vx += j * dx; a.vz += j * dz;
        b.vx -= j * dx; b.vz -= j * dz;
        // lateral kick: yaw response (cross of contact lever and impulse)
        const ra = [p[0] - a.x, p[1] - a.z], rb = [q[0] - b.x, q[1] - b.z];
        a.yawRate += clamp((ra[1] * dx - ra[0] * dz) * j * 0.05, -1.5, 1.5);
        b.yawRate -= clamp((rb[1] * dx - rb[0] * dz) * j * 0.05, -1.5, 1.5);
        const imp = -vn;
        a.impact = Math.max(a.impact, imp); b.impact = Math.max(b.impact, imp);
        a.vx *= 0.995; a.vz *= 0.995; b.vx *= 0.995; b.vz *= 0.995;
        a.events.push({ type: 'car', v: imp, x: (p[0] + q[0]) / 2, y: a.y + 0.5, z: (p[1] + q[1]) / 2 });
        hit = true;
      }
    }
  }
  return hit;
}

// ---------------------------------------------------------------- AI
export class AIDriver {
  constructor(vehicle, { laneOffset = 0, skill = 0.95, aggression = 0.5, rng = Math.random } = {}) {
    this.v = vehicle;
    this.lane = laneOffset;
    this.laneTarget = laneOffset;
    this.skill = skill;
    this.aggr = aggression;
    this.rng = rng;
    this.nitroCool = 2 + rng() * 6;
    this.mistake = 0;
    this.mistakeTimer = 6 + rng() * 14;
    this.steerSmooth = 0;
  }

  control(dt, track, others, playerProgress, started) {
    const v = this.v;
    const ctl = v.ctl;
    if (!started || v.finished && false) { ctl.throttle = 0; ctl.brake = 0; ctl.steer = 0; ctl.nitro = 0; ctl.handbrake = 0; return ctl; }
    const speed = Math.max(v.vF, 1);
    // lane avoidance: look for cars ahead in my path
    let avoid = 0;
    for (const o of others) {
      if (o === v) continue;
      let ds = o.progress - v.progress;
      if (ds > 0 && ds < 28 + speed * 0.4) {
        const dl = o.lat - v.lat;
        if (Math.abs(dl) < 3.4) avoid += -Math.sign(dl || (this.rng() - 0.5)) * (1 - ds / (28 + speed * 0.4)) * 4.2;
      }
    }
    const maxLane = 5.2;
    this.laneTarget = clamp(this.lane + avoid, -maxLane, maxLane);
    // racing line: cut toward the inside of upcoming bends slightly
    const lookAhead = 9 + speed * 0.5;
    const tp = track.at(v.s + lookAhead);
    const kv = track.maxCurv(v.s + lookAhead * 0.5, lookAhead * 1.5);
    const inside = clamp(tp.curv * 300, -1, 1); // + => left bend
    const lineOff = clamp(this.laneTarget + inside * 3.0 * this.aggr, -maxLane, maxLane);
    const tx = tp.x + tp.lx * lineOff, tz = tp.z + tp.lz * lineOff;
    const desired = Math.atan2(tx - v.x, tz - v.z);
    const err = wrapAngle(desired - v.yaw);
    let steer = clamp(err * 2.3, -1, 1);
    this.steerSmooth += (steer - this.steerSmooth) * damp(10, dt);
    ctl.steer = this.steerSmooth;
    // occasional human-like mistakes
    this.mistakeTimer -= dt;
    if (this.mistakeTimer < 0) {
      this.mistake = 0.6 + this.rng() * 0.8;
      this.mistakeTimer = 10 + this.rng() * 25;
    }
    let skill = this.skill;
    if (this.mistake > 0) { this.mistake -= dt; skill *= 0.88; }
    // speed planning: braking distance to upcoming curvature
    const aLat = (13.5 + 0.0014 * speed * speed) * 0.74 * skill;
    let vTarget = 1e9;
    const brakeDecel = 24;
    for (let d = 4; d <= 150; d += 8) {
      const kk = Math.abs(track.at(v.s + d).curv) + 1e-4;
      const vs = Math.sqrt(aLat / kk);
      const vReach = Math.sqrt(vs * vs + 2 * brakeDecel * d * 0.9);
      if (vReach < vTarget) vTarget = vReach;
    }
    const vcap = v.topSpeedBase * skill * v.rb;
    vTarget = Math.min(vTarget, vcap * 1.2);
    ctl.throttle = speed < vTarget ? 1 : 0;
    ctl.brake = speed > vTarget + 2.5 ? clamp((speed - vTarget) / 10, 0.2, 1) : 0;
    if (ctl.brake > 0) ctl.throttle = 0;
    ctl.handbrake = 0;
    // nitro on straights
    this.nitroCool -= dt;
    ctl.nitro = 0;
    if (kv < 0.0022 && v.nitro > 40 && this.nitroCool < 0 && Math.abs(err) < 0.1 && speed > 30) {
      ctl.nitro = 1;
      if (v.nitro < 6) this.nitroCool = 3 + this.rng() * 6;
    } else if (v.nitroOn && (kv > 0.004 || v.nitro < 2)) {
      this.nitroCool = 2 + this.rng() * 5;
    }
    return ctl;
  }
}
