// Fully procedural audio (WebAudio): engine, nitro, tyres, wind, impacts, countdown beeps and a small synth music loop.
// No audio files are needed, so the game also works fully offline.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function makeNoiseBuffer(ctx, seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02; // brown-ish
    d[i] = (w * 0.6 + last * 8.0) * 0.5;
  }
  return buf;
}

function distCurve(amount = 3) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.vol = { master: 0.8, sfx: 1, music: 0.5 };
    this.muted = false;
    this.musicMode = 'menu';
    this._step = 0;
    this._nextTime = 0;
    this._timer = null;
  }

  // must be called from a user gesture
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    this.noise = makeNoiseBuffer(ctx, 3);
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.connect(this.master);
    this._buildEngine();
    this._buildLoops();
    this._buildAI();
    this.applyVolumes();
    this.ready = true;
    this._startMusic();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.vol.master, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 0.55, t, 0.05);
  }
  setVolumes(v) { Object.assign(this.vol, v); this.applyVolumes(); }
  setMuted(m) { this.muted = m; this.applyVolumes(); }

  noiseSrc(loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise; s.loop = loop;
    s.loopStart = 0; s.loopEnd = this.noise.duration;
    return s;
  }

  // ------------------------------------------------------------ engine
  _buildEngine() {
    const ctx = this.ctx;
    this.eng = {};
    const out = ctx.createGain(); out.gain.value = 0;
    const shaper = ctx.createWaveShaper(); shaper.curve = distCurve(2.2); shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2.2; lp.frequency.value = 900;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 180; body.gain.value = 6; body.Q.value = 0.8;
    const mk = (type, g) => { const o = ctx.createOscillator(); o.type = type; const gn = ctx.createGain(); gn.gain.value = g; o.connect(gn); gn.connect(shaper); o.start(); return o; };
    this.eng.o1 = mk('sawtooth', 0.5);
    this.eng.o2 = mk('square', 0.22);
    this.eng.o3 = mk('sawtooth', 0.34);
    this.eng.o4 = mk('triangle', 0.4);
    shaper.connect(body); body.connect(lp); lp.connect(out); out.connect(this.sfx);
    this.eng.out = out; this.eng.lp = lp;
    // intake / mechanical hiss
    const n = this.noiseSrc(); const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.Q.value = 0.9; nb.frequency.value = 1800;
    const ng = ctx.createGain(); ng.gain.value = 0; n.connect(nb); nb.connect(ng); ng.connect(this.sfx); n.start();
    this.eng.nf = nb; this.eng.ng = ng;
    // turbo whistle
    const tw = ctx.createOscillator(); tw.type = 'sine'; tw.frequency.value = 2000;
    const twg = ctx.createGain(); twg.gain.value = 0; tw.connect(twg); twg.connect(this.sfx); tw.start();
    this.eng.tw = tw; this.eng.twg = twg;
  }

  _buildLoops() {
    const ctx = this.ctx;
    this.loops = {};
    const mkNoise = (type, freq, q) => {
      const s = this.noiseSrc(); const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(this.sfx); s.start();
      return { f, g };
    };
    this.loops.wind = mkNoise('lowpass', 500, 0.4);
    this.loops.screech = mkNoise('bandpass', 1500, 5);
    this.loops.nitro = mkNoise('bandpass', 1400, 0.7);
    this.loops.scrape = mkNoise('bandpass', 3200, 1.6);
    this.loops.road = mkNoise('lowpass', 220, 0.5);
    // nitro low rumble
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
    const og = ctx.createGain(); og.gain.value = 0; const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 220;
    o.connect(of); of.connect(og); og.connect(this.sfx); o.start();
    this.loops.rumble = { o, g: og };
  }

  _buildAI() {
    const ctx = this.ctx;
    this.ai = [];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 100;
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 50;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; f.Q.value = 1.5;
      const g = ctx.createGain(); g.gain.value = 0;
      const sh = ctx.createWaveShaper(); sh.curve = distCurve(1.6);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      o.connect(sh); o2.connect(sh); sh.connect(f); f.connect(g);
      if (pan) { g.connect(pan); pan.connect(this.sfx); } else g.connect(this.sfx);
      o.start(); o2.start();
      this.ai.push({ o, o2, f, g, pan });
    }
  }

  // ------------------------------------------------------------ per-frame update
  // s: { rpm, throttle, speed (m/s), maxSpeed, nitro (0..1 glow), slip (0..1), scrape (0..1), surface, boost }
  update(s, dt, aiCars) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime, T = 0.04;
    const e = this.eng;
    const rpm = clamp(s.rpm, 0, 1);
    const f = 52 + rpm * 205 + (s.nitro > 0.5 ? 14 : 0);
    e.o1.frequency.setTargetAtTime(f, t, T);
    e.o2.frequency.setTargetAtTime(f * 2.005, t, T);
    e.o3.frequency.setTargetAtTime(f * 0.5, t, T);
    e.o4.frequency.setTargetAtTime(f * 3.01, t, T);
    const load = clamp(s.throttle, 0, 1);
    e.lp.frequency.setTargetAtTime(500 + rpm * 2600 + load * 1900, t, T);
    e.out.gain.setTargetAtTime(s.active ? 0.2 + load * 0.2 + rpm * 0.08 : 0.0, t, 0.06);
    e.nf.frequency.setTargetAtTime(1200 + rpm * 3000, t, T);
    e.ng.gain.setTargetAtTime(s.active ? 0.025 + load * rpm * 0.08 : 0, t, 0.08);
    e.tw.frequency.setTargetAtTime(1800 + rpm * 3800, t, 0.06);
    e.twg.gain.setTargetAtTime(s.active ? load * rpm * 0.012 + (s.nitro > 0.3 ? 0.02 : 0) : 0, t, 0.1);
    const sp = clamp(s.speed / Math.max(1, s.maxSpeed), 0, 1.2);
    this.loops.wind.g.gain.setTargetAtTime(s.active ? sp * sp * 0.45 : 0, t, 0.1);
    this.loops.wind.f.frequency.setTargetAtTime(300 + sp * 1800, t, 0.1);
    this.loops.road.g.gain.setTargetAtTime(s.active ? Math.min(0.2, sp * 0.22) * (s.surface === 'shoulder' ? 2.2 : 1) : 0, t, 0.1);
    this.loops.road.f.frequency.setTargetAtTime(s.surface === 'shoulder' ? 480 : 220 + sp * 260, t, 0.2);
    this.loops.screech.g.gain.setTargetAtTime(s.active ? clamp(s.slip, 0, 1) * 0.16 : 0, t, 0.05);
    this.loops.screech.f.frequency.setTargetAtTime(1100 + clamp(s.slip, 0, 1) * 500 + sp * 400, t, 0.1);
    this.loops.scrape.g.gain.setTargetAtTime(s.active ? clamp(s.scrape, 0, 1) * 0.28 : 0, t, 0.03);
    this.loops.scrape.f.frequency.setTargetAtTime(2400 + Math.random() * 1800, t, 0.03);
    const nit = clamp(s.nitro, 0, 1);
    this.loops.nitro.g.gain.setTargetAtTime(nit * 0.38, t, 0.06);
    this.loops.nitro.f.frequency.setTargetAtTime(900 + nit * 1700, t, 0.1);
    this.loops.rumble.g.gain.setTargetAtTime(nit * 0.24, t, 0.08);
    this.loops.rumble.o.frequency.setTargetAtTime(48 + sp * 40, t, 0.1);
    // opponents
    for (let i = 0; i < this.ai.length; i++) {
      const v = this.ai[i], c = aiCars && aiCars[i];
      if (!c) { v.g.gain.setTargetAtTime(0, t, 0.1); continue; }
      const fr = 48 + c.rpm * 150;
      v.o.frequency.setTargetAtTime(fr * c.dop, t, 0.05);
      v.o2.frequency.setTargetAtTime(fr * 2.0 * c.dop, t, 0.05);
      v.f.frequency.setTargetAtTime(400 + c.rpm * 1400, t, 0.1);
      v.g.gain.setTargetAtTime(c.gain * 0.35, t, 0.08);
      if (v.pan) v.pan.pan.setTargetAtTime(clamp(c.pan, -1, 1), t, 0.05);
    }
  }

  // ------------------------------------------------------------ one-shots
  impact(v, heavy = true) {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const a = clamp(v / 22, 0.08, 1);
    const n = this.noiseSrc(false); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500 + a * 2400;
    const g = ctx.createGain(); g.gain.setValueAtTime(a * 0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35 + a * 0.2);
    n.connect(f); f.connect(g); g.connect(this.sfx); n.start(t, Math.random() * 2, 0.7);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.28);
    const og = ctx.createGain(); og.gain.setValueAtTime(a * 0.9, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(og); og.connect(this.sfx); o.start(t); o.stop(t + 0.4);
    if (heavy && a > 0.35) { // metallic crunch
      const m = ctx.createOscillator(); m.type = 'square'; m.frequency.setValueAtTime(260 + Math.random() * 120, t);
      m.frequency.exponentialRampToValueAtTime(90, t + 0.18);
      const mg = ctx.createGain(); mg.gain.setValueAtTime(a * 0.12, t); mg.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
      m.connect(mg); mg.connect(this.sfx); m.start(t); m.stop(t + 0.25);
    }
  }

  beep(freq = 660, dur = 0.18, vol = 0.35, type = 'sine') {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfx); o.start(t); o.stop(t + dur + 0.05);
  }
  countdown(n) { if (n > 0) this.beep(520, 0.22, 0.4, 'triangle'); else { this.beep(1040, 0.6, 0.45, 'triangle'); this.beep(1560, 0.6, 0.18, 'sine'); } }
  click() { this.beep(900, 0.05, 0.12, 'square'); }
  hover() { this.beep(1400, 0.03, 0.05, 'sine'); }
  shift() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.noiseSrc(false); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(900, t + 0.14); f.Q.value = 1.2;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.05, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    n.connect(f); f.connect(g); g.connect(this.sfx); n.start(t, Math.random() * 2, 0.2);
  }
  nitroKick() {
    if (!this.ready) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this.noiseSrc(false); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(3500, t + 0.35);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
    n.connect(f); f.connect(g); g.connect(this.sfx); n.start(t, Math.random() * 2, 0.7);
  }
  pickup() { this.beep(880, 0.1, 0.25, 'triangle'); setTimeout(() => this.beep(1320, 0.18, 0.25, 'triangle'), 70); }
  fanfare() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.beep(f, 0.35, 0.3, 'triangle'), i * 120)); }

  // ------------------------------------------------------------ music
  _startMusic() {
    this._nextTime = this.ctx.currentTime + 0.1;
    this._step = 0;
    this._timer = setInterval(() => this._schedule(), 30);
  }
  setMusicMode(m) { this.musicMode = m; }

  _schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') { if (ctx) this._nextTime = Math.max(this._nextTime, ctx.currentTime); return; }
    const bpm = this.musicMode === 'race' ? 138 : 108;
    const sp = 60 / bpm / 4;
    while (this._nextTime < ctx.currentTime + 0.14) {
      this._playStep(this._step, this._nextTime, sp);
      this._nextTime += sp;
      this._step++;
    }
  }

  _env(g, t, a, d, peak) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _playStep(step, t, sp) {
    const ctx = this.ctx, mb = this.musicBus;
    const race = this.musicMode === 'race';
    const st = step % 16, bar = Math.floor(step / 16) % 8;
    // chord progression (A minor): Am F C G  (x2)
    const roots = [57, 53, 60, 55, 57, 53, 60, 55];
    const chords = [[0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7], [0, 3, 7], [0, 4, 7], [0, 4, 7], [0, 4, 7]];
    const root = roots[bar], ch = chords[bar];
    // kick
    if (race ? st % 4 === 0 : (st === 0 || st === 8 || st === 10)) {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
      const g = ctx.createGain(); this._env(g, t, 0.003, 0.22, race ? 0.9 : 0.6);
      o.connect(g); g.connect(mb); o.start(t); o.stop(t + 0.3);
    }
    // clap / snare
    if (st === 4 || st === 12) {
      const n = this.noiseSrc(false); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.9;
      const g = ctx.createGain(); this._env(g, t, 0.002, 0.16, race ? 0.5 : 0.32);
      n.connect(f); f.connect(g); g.connect(mb); n.start(t, Math.random() * 2, 0.25);
    }
    // hats
    if (race ? true : st % 2 === 0) {
      const open = st % 4 === 2;
      const n = this.noiseSrc(false); const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = ctx.createGain(); this._env(g, t, 0.001, open ? 0.09 : 0.03, (open ? 0.22 : 0.1) * (st % 2 ? 0.6 : 1));
      n.connect(f); f.connect(g); g.connect(mb); n.start(t, Math.random() * 2, 0.15);
    }
    // bass (offbeat pulse)
    const bassPat = race ? [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0] : [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    if (bassPat[st]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      const note = root - 24 + (st === 14 || st === 11 ? 12 : 0) + (st === 6 ? 7 : 0);
      o.frequency.value = midi(note);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6;
      f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(160, t + sp * 1.6);
      const g = ctx.createGain(); this._env(g, t, 0.004, sp * 1.7, 0.35);
      o.connect(f); f.connect(g); g.connect(mb); o.start(t); o.stop(t + sp * 2.2);
    }
    // arpeggio
    const arpPat = race ? [0, 1, 2, 1, 0, 1, 2, 3, 0, 1, 2, 1, 2, 1, 0, 1] : [0, -1, 1, -1, 2, -1, 1, -1, 0, -1, 1, -1, 2, -1, 3, -1];
    const ai = arpPat[st];
    if (ai >= 0) {
      const note = root + 12 + (ch[ai % 3] || 0) + (ai >= 3 ? 12 : 0);
      const o = ctx.createOscillator(); o.type = race ? 'square' : 'triangle'; o.frequency.value = midi(note);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = race ? 2600 : 1600; f.Q.value = 2;
      const g = ctx.createGain(); this._env(g, t, 0.004, sp * 1.5, race ? 0.07 : 0.09);
      o.connect(f); f.connect(g); g.connect(mb); o.start(t); o.stop(t + sp * 2);
    }
    // pad (once per bar)
    if (st === 0) {
      for (const iv of ch) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(root + 12 + iv);
        o.detune.value = (Math.random() - 0.5) * 14;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
        const g = ctx.createGain(); const dur = sp * 16;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.045, t + dur * 0.35); g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(f); f.connect(g); g.connect(mb); o.start(t); o.stop(t + dur + 0.1);
      }
    }
  }
}
