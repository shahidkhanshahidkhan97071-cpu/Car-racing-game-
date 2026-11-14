// ASPHALT FOREST — game orchestration: boot, menu / garage, race flow, camera, effects.
import { Renderer, Material, QUALITY_PRESETS } from './renderer.js';
import { ENVIRONMENTS } from './environments.js';
import { m4, DEG, clamp, lerp, wrapAngle, damp, smoothstep, mulberry32 } from './math.js';
import { MeshBuilder } from './gl.js';
import { loadCar, drawCar, loadTree, PAINTS, paintUniform, TREE_SPECS } from './assets.js';
import { preloaded } from './gltf.js';
import { Track } from './track.js';
import { World } from './world.js';
import { Vehicle, AIDriver, collideVehicles } from './physics.js';
import { Input } from './input.js';
import { GameAudio } from './audio.js';
import { HUD, fmtTime, ordinal } from './ui.js';
import { FX, drawContactShadow } from './fx.js';

const _dummy = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, children: [], textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, addEventListener() {}, appendChild() {}, removeChild() {}, getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }, focus() {}, offsetWidth: 0 });
const $ = (id) => document.getElementById(id) || _dummy();
const STEP = 1 / 100;                       // fixed physics step
const AI_NAMES = ['VIPER', 'NOVA', 'RAVEN', 'BLAZE', 'GHOST', 'TITAN', 'ECHO', 'DRIFTER', 'SPECTRE', 'COMET'];
const DIFFS = [
  { name: 'EASY', skill: 0.86, aggr: 0.25 },
  { name: 'NORMAL', skill: 0.93, aggr: 0.5 },
  { name: 'HARD', skill: 0.985, aggr: 0.7 },
  { name: 'LEGEND', skill: 1.04, aggr: 0.9 },
];
const SETTINGS_KEY = 'asphalt_forest_v1';
const DEFAULTS = { quality: 'high', dyn: true, fx: true, units: 'kmh', vol: { master: 80, sfx: 100, music: 50 }, track: 0, laps: 3, opp: 5, diff: 1, car: 0, paints: {} };

function loadSettings() {
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); return { ...DEFAULTS, ...s, vol: { ...DEFAULTS.vol, ...(s.vol || {}) }, paints: s.paints || {} }; } catch (e) { return { ...DEFAULTS }; }
}
function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ } }

const hslCss = (p) => {
  // approximate CSS colour of a paint preset (for UI swatches / minimap)
  const l = Math.max(0.12, Math.min(0.72, 0.18 + p.val * 0.22));
  const sat = Math.min(100, p.sat * 90);
  return `hsl(${Math.round(p.hue * 360)} ${p.sat < 0.2 ? Math.round(p.sat * 60) : Math.round(sat)}% ${Math.round(l * 100)}%)`;
};

class Game {
  constructor() {
    this.S = loadSettings();
    this.state = 'boot';
    this.time = 0;
    this.input = new Input();
    this.audio = new GameAudio();
    this.hud = new HUD();
    this.cars = [];
    this.tracks = [];
    this.worlds = {};
    this.trees = {};
    this.treeQuality = null;
    this.camMode = 0;
    this.orbit = { yaw: 0.6, drag: false, last: 0, idle: 0 };
    this.fpsAcc = 0; this.fpsN = 0; this.fps = 60;
    this.dynFrames = 0; this.dynAcc = 0; this.dynScale = 1;
    this.view = m4.create(); this.proj = m4.create();
    this.eye = [0, 2, 0]; this.camPos = [0, 2, 0]; this.camYaw = 0; this.camFov = 60;
    this.shake = 0; this.flash = 0; this.flashCol = [1, 0.8, 0.5];
    this._m = m4.create(); this._ry = m4.create(); this._rx = m4.create(); this._rz = m4.create(); this._t = m4.create();
    this.tmpAt = {};
    this.rng = Math.random;
  }

  // ------------------------------------------------------------------ boot
  async boot() {
    const bootMsg = (m, p) => { if ($('bootMsg')) $('bootMsg').textContent = m; if (p !== undefined) { const w = Math.max(this._bw || 0, p * 100); this._bw = w; if ($('bootBar')) $('bootBar').style.width = w + '%'; } };
    bootMsg('Starting renderer…', 0.05);
    try {
      this.r = new Renderer($('c'), this.S.quality);
    } catch (e) {
      $('boot').classList.add('hidden'); $('nogl').classList.remove('hidden'); console.error(e); return;
    }
    const r = this.r;
    this.fx = new FX(r);
    r.setEnvironment(ENVIRONMENTS[this.S.track] || ENVIRONMENTS[0]);
    // car list
    bootMsg('Looking for cars…', 0.12);
    let files = [];
    try { const res = await fetch('/api/cars'); if (res.ok) files = await res.json(); } catch (e) { /* ignore */ }
    if (!files.length) { try { const res = await fetch('cars/cars.json'); if (res.ok) files = await res.json(); } catch (e) { /* ignore */ } }
    if (!files.length) files = ['lamborghini_asterion.glb'];
    // ---- download everything up front with a progress screen ----
    await this._download([...files.map((f) => 'cars/' + f), ...Object.values(TREE_SPECS).map((t) => t.file)]);
    bootMsg('Preparing cars…', 0.8);
    const q = r.q.maxTexSize;
    r.q.maxTexSize = 2048; // cars always use full-resolution textures
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      bootMsg('Loading car: ' + f.replace(/\.glb$/i, ''), 0.15 + 0.4 * (i / files.length));
      let cfg = {};
      try { const res = await fetch('cars/' + f.replace(/\.glb$/i, '.json')); if (res.ok) cfg = await res.json(); } catch (e) { /* optional */ }
      try { this.cars.push(await loadCar(r, 'cars/' + f, cfg)); } catch (e) { console.error('car failed', f, e); }
    }
    r.q.maxTexSize = q;
    if (!this.cars.length) { bootMsg('No car could be loaded. Check the cars folder.'); return; }
    this.S.car = clamp(this.S.car, 0, this.cars.length - 1);
    // tracks (cheap) for menu previews
    bootMsg('Surveying tracks…', 0.65);
    await new Promise((r2) => setTimeout(r2, 0));
    for (const env of ENVIRONMENTS) this.tracks.push(new Track(env));
    // showroom
    this._buildShowroom();
    bootMsg('Building menu…', 0.85);
    this._buildMenu();
    this.audio.setVolumes({ master: this.S.vol.master / 100, sfx: this.S.vol.sfx / 100, music: this.S.vol.music / 100 });
    window.addEventListener('resize', () => r.resize());
    document.addEventListener('visibilitychange', () => { if (document.hidden && (this.state === 'racing' || this.state === 'countdown')) this.pause(true); });
    // user gesture unlock for audio
    const unlock = () => { this.audio.start(); };
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    bootMsg('Ready', 1);
    await new Promise((r2) => setTimeout(r2, 250));
    $('boot').classList.add('hidden');
    this.enterMenu();
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    window.__game = this;
    window.__ready = true;
  }

  async _download(urls) {
    const EST = { 'fir_spruce.glb': 4825992, 'red_oak.glb': 24964400, 'black_spruce.glb': 17426872, 'pine_fbx.glb': 5233568, 'pine_b.glb': 3446832 };
    const mb = (b) => (b / 1048576).toFixed(1);
    const sizes = await Promise.all(urls.map(async (u) => {
      try { const h = await fetch(u, { method: 'HEAD' }); const n = +h.headers.get('content-length'); if (n > 0) return n; } catch (e) { /* ignore */ }
      return EST[u.split('/').pop()] || 2600000;
    }));
    const total = sizes.reduce((a, b) => a + b, 0);
    let loaded = 0, last = performance.now(), lastBytes = 0, speed = 0;
    const dummy = { style: {}, textContent: '' };
    const bar = $('bootBar') || dummy, msg = $('bootMsg') || dummy, bytes = $('bootBytes') || dummy;
    const tips = ['Drift through corners to fill your nitro', 'Hold the throttle before GO for a perfect start', 'Press C to change the camera', 'Press R if you get stuck', 'Handbrake + steer = drift'];
    ($('bootTip') || dummy).textContent = tips[(Math.random() * tips.length) | 0];
    const ui = (name) => {
      const now = performance.now();
      if (now - last > 400) { speed = speed * 0.5 + ((loaded - lastBytes) / ((now - last) / 1000)) * 0.5; last = now; lastBytes = loaded; }
      const l = Math.min(loaded, total);
      bar.style.width = ((l / total) * 78 + 4).toFixed(1) + '%';
      bytes.textContent = `${mb(l)} MB / ${mb(total)} MB  ·  ${Math.floor((l / total) * 100)}%` + (speed > 0 ? `  ·  ${mb(speed)} MB/s` : '');
      if (name) msg.textContent = 'Downloading ' + name.replace(/\.glb$/, '').replace(/_/g, ' ');
    };
    ui('assets');
    let idx = 0;
    const worker = async () => {
      while (idx < urls.length) {
        const i = idx++;
        const u = urls[i];
        const res = await fetch(u);
        if (!res.ok) throw new Error('Download failed: ' + u);
        const reader = res.body.getReader();
        const chunks = []; let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length; loaded += value.length; ui(u.split('/').pop());
        }
        const buf = new Uint8Array(got); let o = 0;
        for (const c of chunks) { buf.set(c, o); o += c.length; }
        preloaded.set(u, buf.buffer);
        loaded += Math.max(0, sizes[i] - got); // keep the bar exact if sizes differ
        ui(u.split('/').pop());
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    loaded = total; ui('assets');
    bytes.textContent = `${mb(total)} MB / ${mb(total)} MB  ·  100%`;
  }

  // ------------------------------------------------------------------ showroom
  _buildShowroom() {
    const r = this.r, gl = r.gl;
    const mb = new MeshBuilder();
    mb.cylinder(0, -0.5, 0, 700, 0.5, 48, [0.07, 0.075, 0.085, 1], true);
    this.floorMesh = mb.build(gl);
    this.floorMat = new Material({ name: 'showfloor', roughness: 0.62, metallic: 0.0, baseColor: [0.55, 0.55, 0.6, 1] });
    const pb = new MeshBuilder();
    pb.cylinder(0, -0.06, 0, 3.6, 0.07, 64, [0.16, 0.17, 0.19, 1], true);
    pb.cylinder(0, -0.0, 0, 3.5, 0.012, 64, [0.75, 0.32, 0.08, 1], true);
    pb.cylinder(0, 0.0, 0, 3.38, 0.014, 64, [0.14, 0.15, 0.17, 1], true);
    this.padMesh = pb.build(gl);
    this.padMat = new Material({ name: 'showpad', roughness: 0.28, metallic: 0.6, baseColor: [1, 1, 1, 1] });
    this.ident = m4.create();
  }

  // ------------------------------------------------------------------ menu
  _seg(id, items, getter, setter) {
    const el = $(id); el.innerHTML = '';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.textContent = it.label; b.dataset.v = it.value;
      b.addEventListener('click', () => { this.audio.click(); setter(it.value); render(); });
      el.appendChild(b);
    });
    const render = () => { [...el.children].forEach((c, i) => c.classList.toggle('on', String(items[i].value) === String(getter()))); };
    render();
    return render;
  }

  _buildMenu() {
    const S = this.S, save = () => saveSettings(S);
    // tabs
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
      this.audio.click();
      document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.menu-left .panel').forEach((p) => p.classList.add('hidden'));
      $('tab-' + b.dataset.tab).classList.remove('hidden');
      this.menuTab = b.dataset.tab;
    }));
    this.menuTab = 'race';
    // tracks
    const list = $('trackList'); list.innerHTML = '';
    ENVIRONMENTS.forEach((env, i) => {
      const t = this.tracks[i];
      const d = document.createElement('div'); d.className = 'tcard' + (i === S.track ? ' sel' : '');
      const cv = document.createElement('canvas'); cv.width = cv.height = 128;
      this._drawTrackPreview(cv, t);
      d.appendChild(cv);
      const info = document.createElement('div');
      info.innerHTML = `<div class="tn">${env.name}</div><div class="ts">${env.subtitle}</div>`;
      d.appendChild(info);
      const meta = document.createElement('div'); meta.className = 'tm';
      meta.innerHTML = `${(t.length / 1000).toFixed(2)} KM<br>${env.night ? 'NIGHT' : (env.wet > 0.1 ? 'MISTY' : 'GOLDEN HOUR')}`;
      d.appendChild(meta);
      d.addEventListener('click', () => {
        this.audio.click(); S.track = i; save();
        [...list.children].forEach((c, k) => c.classList.toggle('sel', k === i));
        this.r.setEnvironment(ENVIRONMENTS[i]);
      });
      list.appendChild(d);
    });
    this._seg('segLaps', [1, 2, 3, 5, 8].map((v) => ({ label: v, value: v })), () => S.laps, (v) => { S.laps = +v; save(); });
    this._seg('segOpp', [0, 3, 5, 7].map((v) => ({ label: v, value: v })), () => S.opp, (v) => { S.opp = +v; save(); });
    this._seg('segDiff', DIFFS.map((d, i) => ({ label: d.name, value: i })), () => S.diff, (v) => { S.diff = +v; save(); });
    this._seg('segQuality', ['low', 'medium', 'high', 'ultra'].map((k) => ({ label: QUALITY_PRESETS[k].name, value: k })), () => S.quality, (v) => { S.quality = v; save(); this._qualityDirty = true; });
    this._seg('segDyn', [{ label: 'ON', value: 1 }, { label: 'OFF', value: 0 }], () => (S.dyn ? 1 : 0), (v) => { S.dyn = !!+v; save(); });
    this._seg('segFx', [{ label: 'ON', value: 1 }, { label: 'OFF', value: 0 }], () => (S.fx ? 1 : 0), (v) => { S.fx = !!+v; save(); });
    this._seg('segUnit', [{ label: 'KM/H', value: 'kmh' }, { label: 'MPH', value: 'mph' }], () => S.units, (v) => { S.units = v; save(); });
    const vol = (id, key) => {
      const el = $(id); el.value = S.vol[key];
      el.addEventListener('input', () => { S.vol[key] = +el.value; this.audio.setVolumes({ [key]: +el.value / 100 }); });
      el.addEventListener('change', save);
    };
    vol('volMaster', 'master'); vol('volSfx', 'sfx'); vol('volMusic', 'music');
    // garage
    $('carPrev').addEventListener('click', () => { this.audio.click(); this._selectCar(S.car - 1); });
    $('carNext').addEventListener('click', () => { this.audio.click(); this._selectCar(S.car + 1); });
    const sw = $('swatches'); sw.innerHTML = '';
    PAINTS.forEach((p, i) => {
      const d = document.createElement('div'); d.className = 'sw'; d.style.background = hslCss(p); d.title = p.name;
      d.addEventListener('click', () => { this.audio.click(); this._setPaint(i); });
      sw.appendChild(d);
    });
    this._selectCar(S.car, true);
    // buttons
    $('btnStart').addEventListener('click', () => { this.audio.start(); this.audio.click(); this.startRace(); });
    $('btnResume').addEventListener('click', () => this.pause(false));
    $('btnRestart').addEventListener('click', () => { $('pause').classList.add('hidden'); this.startRace(true); });
    $('btnQuit').addEventListener('click', () => { $('pause').classList.add('hidden'); this.enterMenu(); });
    $('btnAgain').addEventListener('click', () => { $('results').classList.add('hidden'); this.startRace(true); });
    $('btnMenu').addEventListener('click', () => { $('results').classList.add('hidden'); this.enterMenu(); });
    // orbit drag
    const cv = $('c');
    cv.addEventListener('pointerdown', (e) => { if (this.state === 'menu') { this.orbit.drag = true; this.orbit.last = e.clientX; cv.setPointerCapture(e.pointerId); } });
    cv.addEventListener('pointermove', (e) => { if (this.orbit.drag) { this.orbit.yaw -= (e.clientX - this.orbit.last) * 0.008; this.orbit.last = e.clientX; this.orbit.idle = 0; } });
    cv.addEventListener('pointerup', () => { this.orbit.drag = false; });
    document.querySelectorAll('button').forEach((b) => b.addEventListener('mouseenter', () => this.audio.hover()));
  }

  _drawTrackPreview(cv, t) {
    const g = cv.getContext('2d'), S = cv.width;
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < t.N; i++) { minx = Math.min(minx, t.x[i]); maxx = Math.max(maxx, t.x[i]); minz = Math.min(minz, t.z[i]); maxz = Math.max(maxz, t.z[i]); }
    const pad = 10, sc = (S - pad * 2) / Math.max(maxx - minx, maxz - minz);
    const ox = pad + ((S - pad * 2) - (maxx - minx) * sc) / 2, oz = pad + ((S - pad * 2) - (maxz - minz) * sc) / 2;
    g.lineJoin = 'round';
    const path = () => { g.beginPath(); for (let i = 0; i < t.N; i += 3) { const X = ox + (t.x[i] - minx) * sc, Y = S - (oz + (t.z[i] - minz) * sc); i === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y); } g.closePath(); };
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 9; path(); g.stroke();
    g.strokeStyle = '#e8eef8'; g.lineWidth = 5; path(); g.stroke();
    g.strokeStyle = '#ff7a1a'; g.lineWidth = 2; path(); g.stroke();
  }

  _selectCar(i, silent) {
    const n = this.cars.length;
    i = ((i % n) + n) % n;
    this.S.car = i; saveSettings(this.S);
    const car = this.cars[i];
    $('carName').textContent = car.name;
    $('carCount').textContent = n > 1 ? `${i + 1} / ${n}` : 'More cars can be added anytime';
    $('carPrev').disabled = $('carNext').disabled = n < 2;
    const st = car.stats, bar = (v) => Math.round(clamp(v, 0, 1) * 100);
    const rows = [
      ['Top speed', bar(st.topSpeed / 110), Math.round(st.topSpeed * 3.6) + ' km/h'],
      ['Acceleration', bar(st.accel / 1.6), (st.accel * 10).toFixed(1)],
      ['Handling', bar(st.handling / 1.6), (st.handling * 10).toFixed(1)],
      ['Grip', bar(st.grip / 1.6), (st.grip * 10).toFixed(1)],
      ['Braking', bar(st.brake / 1.6), (st.brake * 10).toFixed(1)],
      ['Nitro', bar(st.nitro / 1.6), (st.nitro * 10).toFixed(1)],
    ];
    $('carStats').innerHTML = rows.map(([n2, p, v]) => `<div class="stat"><span>${n2}</span><div class="meter"><i style="width:${p}%"></i></div><span class="v">${v}</span></div>`).join('');
    this._setPaint(this.S.paints[car.id] ?? 1, true);
  }

  _setPaint(pi, silent) {
    const car = this.cars[this.S.car];
    this.S.paints[car.id] = pi; if (!silent) saveSettings(this.S);
    this.paintIdx = pi;
    [...$('swatches').children].forEach((c, k) => c.classList.toggle('sel', k === pi));
    $('paintName').textContent = PAINTS[pi].name;
  }

  enterMenu() {
    this.state = 'menu';
    this.hud.hide();
    $('menu').classList.remove('hidden');
    $('loading').classList.add('hidden');
    this.input.enabled = true;
    this.audio.setMusicMode('menu');
    this.audio.update({ active: false, rpm: 0.2, throttle: 0, speed: 0, maxSpeed: 90, nitro: 0, slip: 0, scrape: 0 }, 0.016, []);
    this.r.setEnvironment(ENVIRONMENTS[this.S.track]);
    if (this._qualityDirty) { this._applyQuality(); }
    this.race = null;
  }

  _applyQuality() {
    this._qualityDirty = false;
    if (this.S.quality !== this.r.qualityKey) {
      this.r.setQuality(this.S.quality);
      this.fx.setQuality();
      this.worlds = {}; this.trees = {};
    }
  }

  // ------------------------------------------------------------------ race setup
  async startRace(again = false) {
    if (this.state === 'loading') return;
    const S = this.S, r = this.r;
    $('menu').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('results').classList.add('hidden');
    this.state = 'loading';
    this.hud.hide();
    const L = $('loading'); L.classList.remove('hidden');
    const env = ENVIRONMENTS[S.track];
    $('loadTrack').textContent = env.name;
    const prog = (p, msg) => { $('loadBar').style.width = (p * 100).toFixed(0) + '%'; $('loadMsg').textContent = msg; };
    await new Promise((res) => setTimeout(res, 30));
    this._applyQuality();
    r.setEnvironment(env);
    // trees
    const keys = env.trees.map((t) => t[0]);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!this.trees[k]) {
        prog(0.02 + 0.4 * (i / keys.length), 'Loading trees: ' + k.replace(/_/g, ' '));
        await new Promise((res) => setTimeout(res, 10));
        try { this.trees[k] = await loadTree(r, k); } catch (e) {
          console.error(e);
          prog(0, 'Missing file for "' + k + '" - extract ALL zip parts into the same folder (assets/trees/), then restart.');
          await new Promise((res) => setTimeout(res, 6000));
          this.enterMenu();
          return;
        }
      }
    }
    // world
    let W = this.worlds[S.track];
    if (!W) {
      const track = this.tracks[S.track];
      const world = new World(r, env, track, this.trees);
      await world.build((p, msg) => prog(0.42 + p * 0.5, msg));
      W = this.worlds[S.track] = { env, track, world };
    }
    prog(0.94, 'Preparing grid');
    await new Promise((res) => setTimeout(res, 10));
    this._setupRace(W);
    // warm-up frames (compile shader variants while the overlay is still visible)
    prog(0.97, 'Compiling shaders');
    for (let i = 0; i < 3; i++) { this._renderRace(0.016); await new Promise((res) => setTimeout(res, 16)); }
    prog(1, 'Go!');
    await new Promise((res) => setTimeout(res, 200));
    L.classList.add('hidden');
    this.hud.show();
    this.audio.setMusicMode('race');
    this.last = performance.now();
    this.state = 'countdown';
    this.introT = 0;
    this.cdT = 3.0;
    this.cdShown = 4;
    this.input.enabled = true;
  }

  _setupRace(W) {
    const S = this.S, { env, track, world } = W;
    const r = this.r;
    const diff = DIFFS[S.diff];
    const playerCar = this.cars[S.car];
    const rng = mulberry32((Date.now() & 0xffff) + 7);
    const nAI = S.opp;
    const total = nAI + 1;
    const vehicles = [];
    // paint selection for opponents (avoid the player's)
    const pPaint = this.paintIdx;
    const pool = PAINTS.map((_, i) => i).filter((i) => i !== pPaint);
    for (let i = pool.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const names = AI_NAMES.slice().sort(() => rng() - 0.5);
    const player = new Vehicle(playerCar, { isPlayer: true, name: 'YOU', skill: 1 });
    player.paint = PAINTS[pPaint]; player.paintU = paintUniform(PAINTS[pPaint]); player.cssColor = '#ff7a1a';
    const ais = [];
    for (let i = 0; i < nAI; i++) {
      const model = this.cars[(rng() * this.cars.length) | 0];
      const p = PAINTS[pool[i % pool.length]];
      const v = new Vehicle(model, { name: names[i % names.length], skill: diff.skill * (0.97 + rng() * 0.06) });
      v.paint = p; v.paintU = paintUniform(p); v.cssColor = hslCss(p);
      v.ai = new AIDriver(v, { laneOffset: (rng() - 0.5) * 6, skill: diff.skill * (0.975 + rng() * 0.05), aggression: diff.aggr * (0.7 + rng() * 0.6), rng });
      ais.push(v);
    }
    // grid: 2 columns, player in the back rows
    const slots = [];
    for (let k = 0; k < total; k++) slots.push({ s: track.length - 14 - Math.floor(k / 2) * 9.5, lat: k % 2 === 0 ? -2.7 : 2.7 });
    const order = [...ais];
    const playerSlot = Math.min(total - 1, nAI >= 3 ? Math.max(2, Math.floor(total * 0.7)) : total - 1);
    let ai = 0;
    for (let k = 0; k < total; k++) {
      const v = k === playerSlot ? player : order[ai++];
      v.placeAt(track, slots[k].s, slots[k].lat, world);
      v.slot = k;
      vehicles.push(v);
    }
    this.race = {
      env, track, world, vehicles, player, ais, total, laps: S.laps, diff,
      time: 0, started: false, finishedAt: -1, resultsShown: false, countdownT: 3, bestLap: Infinity, lapStart: 0, lapTimes: [],
      sorted: vehicles.slice(), stuck: 0, driftToastT: 0, autopilot: null, perfectStart: false, thrHeldSince: -1, shakeBoost: 0,
    };
    // camera snap behind the player
    this.camYaw = player.yaw;
    this.camPos = [player.x - Math.sin(player.yaw) * 8, player.y + 2.6, player.z - Math.cos(player.yaw) * 8];
    this.camFov = 60;
    this.camMode = 0;
    this.hud.setup(track, env.name, S.laps, total, S.units);
    this.accum = 0;
    this.fx.r.particlesAlpha.n = 0; this.fx.r.particlesAdd.n = 0;
    this.sunUV = [0.5, 0.5];
  }

  // ------------------------------------------------------------------ pause / finish
  pause(on) {
    if (on) {
      if (this.state !== 'racing' && this.state !== 'countdown') return;
      this.prevState = this.state; this.state = 'paused';
      $('pause').classList.remove('hidden');
      this.audio.update({ active: false, rpm: 0.2, throttle: 0, speed: 0, maxSpeed: 90, nitro: 0, slip: 0, scrape: 0 }, 0.016, []);
    } else {
      if (this.state !== 'paused') return;
      $('pause').classList.add('hidden');
      this.state = this.prevState || 'racing';
      this.last = performance.now();
    }
  }

  _playerFinished() {
    const R = this.race, p = R.player;
    p.finished = true; p.finishTime = R.time;
    R.autopilot = new AIDriver(p, { laneOffset: 0, skill: 0.9, aggression: 0.3 });
    R.finishedAt = R.time;
    this.audio.fanfare();
    this._sortCars();
    const [n, suf] = ordinal(p.place);
    this.hud.toast('FINISH!', 'big', n + suf + ' PLACE');
    this.flash = 0.35; this.flashCol = [1, 0.9, 0.6];
  }

  _showResults() {
    const R = this.race;
    R.resultsShown = true;
    this.state = 'finished';
    const p = R.player;
    const rows = R.sorted.slice();
    // estimate finish time for cars still running
    const lenTot = R.laps * R.track.length;
    const est = (c) => (c.finished ? c.finishTime : R.time + (lenTot - c.progress) / Math.max(25, c.speed));
    rows.sort((a, b) => est(a) - est(b));
    const winnerT = est(rows[0]);
    let html = '';
    rows.forEach((c, i) => {
      const t = est(c);
      html += `<tr class="${c.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td>${c.name}</td><td>${c.finished ? '' : '~'}${fmtTime(t)}</td><td>${i === 0 ? '' : '+' + (t - winnerT).toFixed(2) + 's'}</td></tr>`;
    });
    $('resTable').innerHTML = html;
    const pl = rows.findIndex((c) => c.isPlayer) + 1;
    const [n, suf] = ordinal(pl);
    $('resPlace').innerHTML = `${n}<sup>${suf}</sup>`;
    $('resTitle').textContent = pl === 1 ? 'VICTORY' : pl <= 3 ? 'PODIUM FINISH' : 'RACE COMPLETE';
    $('resStats').textContent = `Best lap ${R.bestLap < 1e8 ? fmtTime(R.bestLap) : '--'}  ·  Top speed ${Math.round((R.topSpeed || 0) * 3.6)} km/h  ·  Total drift score ${Math.round(R.driftTotal || 0)}`;
    $('results').classList.remove('hidden');
  }

  // ------------------------------------------------------------------ frame
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0.016;
    dt = Math.min(dt, 0.1);
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; if (this.state !== 'menu') $('fps').textContent = ''; }
    const r = this.r;
    r.resize();
    try {
      if (this.state === 'menu') this._renderMenu(dt);
      else if (this.state === 'countdown' || this.state === 'racing' || this.state === 'finished') {
        this._updateRace(dt);
        this._renderRace(dt);
        this._dynRes(dt);
      } else if (this.state === 'paused' && this.race) {
        this._renderRace(0);
        if (this.input.pressed('pause')) this.pause(false);
      }
    } catch (e) {
      console.error(e);
      if (!this._errShown) { this._errShown = true; this.hud.toast('ERROR', 'warn', String(e.message).slice(0, 60)); }
    }
    if (this.state === 'menu' && false) { /* menu keys */ }
    this.input.endFrame();
  }

  _dynRes(dt) {
    const r = this.r;
    if (!this.S.dyn) { if (this.dynScale !== 1) { this.dynScale = 1; r.setDynamicScale(1); } return; }
    this.dynAcc += dt; this.dynFrames++;
    if (this.dynFrames >= 40) {
      const avg = this.dynAcc / this.dynFrames;
      this.dynFrames = 0; this.dynAcc = 0;
      let s = this.dynScale;
      if (avg > 1 / 50) s = Math.max(0.55, s - (avg > 1 / 35 ? 0.12 : 0.06));
      else if (avg < 1 / 66 && s < 1) s = Math.min(1, s + 0.04);
      if (s !== this.dynScale) { this.dynScale = s; r.setDynamicScale(s); }
    }
  }

  // ------------------------------------------------------------------ menu rendering
  _renderMenu(dt) {
    const r = this.r, env = ENVIRONMENTS[this.S.track];
    const car = this.cars[this.S.car];
    this.orbit.idle += dt;
    if (!this.orbit.drag) this.orbit.yaw += dt * 0.22;
    const garage = this.menuTab === 'garage';
    const dist = garage ? 6.4 : 7.6, h = garage ? 1.25 : 1.6;
    const a = this.orbit.yaw;
    const eye = [Math.sin(a) * dist, h, Math.cos(a) * dist];
    m4.lookAt(this.view, eye, [0, 0.62, 0], [0, 1, 0]);
    const asp = r.canvas.clientWidth / Math.max(1, r.canvas.clientHeight);
    m4.perspective(this.proj, 38 * DEG, asp, 0.1, 400);
    // shift the car to the right so the menu panel doesn't cover it
    this.proj[8] = asp > 1.2 ? -0.34 : 0;
    r.beginFrame(this.time);
    r.setCamera(this.view, this.proj, eye);
    r.spots = [];
    const model = this._carMatrix({ x: 0, y: 0, z: 0, yaw: 0.0, pitch: 0, roll: 0, bodyPitch: 0, bodyRoll: 0 }, car);
    const st = { wheelSpin: 0, steer: Math.sin(this.time * 0.8) * 0.12, paint: paintUniform(PAINTS[this.paintIdx]), tail: env.night ? 1.4 : 0.6, head: env.night ? 2.5 : 0.8 };
    r.updateShadow([0, 0, 0], 22);
    r.beginShadowPass();
    drawCar(r, car, model, st, false);
    r.endShadowPass();
    r.beginMainPass([0, 0, 0]);
    r.drawSky();
    r.drawMesh(this.floorMesh, this.floorMat, this.ident);
    r.drawMesh(this.padMesh, this.padMat, this.ident);
    drawCar(r, car, model, st, false);
    drawCar(r, car, model, st, true);
    r.endMainPass();
    r.post({
      exposure: env.exposure * (env.night ? 1.0 : 0.92), bloom: env.bloom * 0.6, bloomThreshold: Math.max(env.bloomThreshold, 1.6), saturation: env.grade.saturation, lift: env.grade.lift,
      gain: env.grade.gain, contrast: env.grade.contrast, vignette: 0.42, grain: 0.012,
    });
  }

  _carMatrix(v, car) {
    const M = this._m;
    m4.translation(M, v.x, v.y - car.dims.groundY, v.z);
    m4.rotationY(this._ry, v.yaw); m4.multiply(M, M, this._ry);
    m4.rotationX(this._rx, -((v.pitch || 0) + (v.bodyPitch || 0))); m4.multiply(M, M, this._rx);
    m4.rotationZ(this._rz, (v.roll || 0) + (v.bodyRoll || 0)); m4.multiply(M, M, this._rz);
    return M;
  }

  // ------------------------------------------------------------------ race update
  _sortCars() {
    const R = this.race;
    R.sorted.sort((a, b) => {
      const ka = a.finished ? -1e7 + a.finishTime : -a.progress;
      const kb = b.finished ? -1e7 + b.finishTime : -b.progress;
      return ka - kb;
    });
    R.sorted.forEach((c, i) => { c.place = i + 1; });
  }

  _updateRace(dt) {
    const R = this.race;
    if (!R) return;
    const inp = this.input;
    if (inp.pressed('pause') && !R.resultsShown) { this.pause(true); return; }
    if (inp.pressed('camera')) { this.camMode = (this.camMode + 1) % 3; this.hud.toast(['CHASE CAM', 'CLOSE CAM', 'BUMPER CAM'][this.camMode], '', ''); }
    if (inp.pressed('mute')) { this.audio.setMuted(!this.audio.muted); }
    const p = R.player;
    // ---- countdown ----
    this.introT += dt;
    if (this.state === 'countdown') {
      if (this.introT > 1.2) {
        const prev = R.countdownT;
        R.countdownT -= dt;
        const shown = Math.ceil(R.countdownT);
        if (shown !== this.cdShown && shown >= 1) { this.cdShown = shown; this.hud.countdown(String(shown)); this.audio.countdown(shown); }
        // rev-up timing for perfect start
        const c0 = inp.get();
        if (c0.throttle > 0.5 && R.thrHeldSince < 0) R.thrHeldSince = R.countdownT;
        if (c0.throttle < 0.5) R.thrHeldSince = -1;
        if (R.countdownT <= 0) {
          this.state = 'racing'; R.started = true; this.hud.countdown('GO!', true); this.audio.countdown(0);
          if (R.thrHeldSince >= 0 && R.thrHeldSince <= 0.85) { p.boostTimer = 1.8; p.nitro = Math.min(100, p.nitro + 20); this.hud.toast('PERFECT START', 'good', 'NITRO BOOST'); this.audio.nitroKick(); this.flash = 0.25; this.flashCol = [0.5, 0.8, 1]; }
          else if (R.thrHeldSince > 0.85) this.hud.toast('WHEELSPIN', 'warn', 'FEATHER THE THROTTLE');
          p.lapStartTime = 0;
        }
      }
    }
    // ---- fixed-step physics ----
    this.accum += dt;
    let steps = 0;
    const started = R.started;
    const ctlIn = inp.get();
    while (this.accum >= STEP && steps < 8) {
      this.accum -= STEP; steps++;
      this._step(STEP, ctlIn, started);
    }
    if (steps >= 8) this.accum = 0;
    if (started) R.time += dt;
    this._sortCars();
    // finish handling
    if (R.finishedAt >= 0 && !R.resultsShown && R.time - R.finishedAt > 3.2) this._showResults();
    if (inp.pressed('reset') && started && !p.finished) this._respawn(p, true);
    // effects / camera
    this._effects(dt);
    this._camera(dt);
    this._audio(dt);
    // HUD
    const hudData = {
      pos: p.place, total: R.total, lap: p.lap, laps: R.laps, time: R.time, bestLap: R.bestLap, speed: p.speed, gear: p.gear,
      reverse: p.vF < -1, nitro: p.nitro, nitroOn: p.nitroOn, rpm: p.rpm, wrongWay: p.wrongWay > 1.3 && !p.finished, cars: R.vehicles, player: p, sorted: R.sorted,
    };
    this.hud.update(hudData, dt);
    if (p.speed > (R.topSpeed || 0)) R.topSpeed = p.speed;
  }

  _step(dt, ctlIn, started) {
    const R = this.race, p = R.player, track = R.track, world = R.world;
    const vs = R.vehicles;
    // player control
    let pc = p.ctl;
    if (p.finished && R.autopilot) R.autopilot.control(dt, track, vs, p.progress, true);
    else if (started) { pc.steer = ctlIn.steer; pc.throttle = ctlIn.throttle; pc.brake = ctlIn.brake; pc.handbrake = ctlIn.handbrake; pc.nitro = ctlIn.nitro; }
    else { pc.steer = 0; pc.throttle = 0; pc.brake = 1; pc.handbrake = 0; pc.nitro = 0; }
    // AI
    const diff = R.diff;
    for (const a of R.ais) {
      const gap = p.progress - a.progress; // + => AI is behind the player
      a.rb = clamp(1 + gap * 0.00045, 0.93, 1.07 + diff.aggr * 0.02);
      if (a.finished) a.ai.skill = 0.7;
      a.ai.control(dt, track, vs, p.progress, started);
    }
    for (const v of vs) {
      v.update(dt, v.ctl, track, world, this.time);
      if (!started) { v.vx = v.vz = 0; v.yawRate = 0; v.nitroOn = false; }
    }
    // car vs car
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i], b = vs[j];
        const dx = a.x - b.x, dz = a.z - b.z;
        if (dx * dx + dz * dz > 36) continue;
        collideVehicles(a, b);
      }
    }
    // events
    const sr = this.camYaw;
    for (const v of vs) {
      for (const e of v.events) this._onEvent(v, e);
      // finishing
      if (!v.finished && v.progress >= R.laps * track.length) {
        if (v === p) this._playerFinished();
        else { v.finished = true; v.finishTime = R.time; }
      }
    }
    // stuck detection
    if (started && !p.finished) {
      if (p.speed < 1.2 && p.ctl.throttle > 0.5) R.stuck += dt; else R.stuck = Math.max(0, R.stuck - dt * 2);
      if (R.stuck > 3.2) { this._respawn(p, false); R.stuck = 0; }
      if (p.wrongWay > 6) { this._respawn(p, false); p.wrongWay = 0; }
    }
  }

  _respawn(v, manual) {
    const R = this.race, track = R.track;
    const s = v.s;
    const pt = track.at(s);
    const sp = clamp(v.speed, 8, 28);
    v.x = pt.x; v.z = pt.z; v.y = pt.y + 0.3; v.yaw = pt.theta;
    v.vx = pt.tx * sp; v.vz = pt.tz * sp; v.vy = 0; v.yawRate = 0; v.steerIn = 0;
    v.wrongWay = 0; v.drifting = false; v.driftTime = 0;
    v.hint = Math.floor(track.wrap(Math.floor(s / track.ds)));
    track.nearest(v.x, v.z, v.hint, v.nearest);
    this.camYaw = v.yaw;
    this.hud.toast(manual ? 'RESET' : 'BACK ON TRACK', '', '');
  }

  _onEvent(v, e) {
    const R = this.race, P = R.player;
    const near = v === P || Math.hypot(v.x - P.x, v.z - P.z) < 70;
    switch (e.type) {
      case 'wall':
        if (near) this.fx.sparks(e.x, e.y, e.z, e.nx, e.nz, v.vx, v.vz, 6 + e.v * 0.8);
        if (v === P) { this.audio.impact(e.v); this.shake = Math.min(1.2, this.shake + e.v * 0.05); if (e.v > 10) { this.flash = 0.18; this.flashCol = [1, 0.45, 0.25]; } }
        break;
      case 'scrape':
        if (near && Math.random() < 0.7) this.fx.sparks(e.x, e.y, e.z, e.nx, e.nz, v.vx, v.vz, 2);
        break;
      case 'car':
        if (near) this.fx.sparks(e.x, e.y, e.z, 0, 0, v.vx * 0.3, v.vz * 0.3, 4 + e.v);
        if (v === P) { this.audio.impact(e.v * 0.8); this.shake = Math.min(1, this.shake + e.v * 0.04); }
        break;
      case 'land':
        if (v === P) { this.audio.impact(e.v * 1.3, false); this.shake = Math.min(1, this.shake + e.v * 0.05); }
        break;
      case 'driftEnd':
        if (v === P) {
          R.driftTotal = (R.driftTotal || 0) + e.score;
          this.hud.toast('DRIFT +' + e.score, 'good', 'NITRO BOOST');
          this.audio.pickup(); this.audio.nitroKick();
        }
        break;
      case 'lap': {
        const n = e.lap;
        if (v !== P) break;
        if (n === 0) { R.lapStart = R.time; break; }
        if (n > 0) {
          const lt = R.time - R.lapStart;
          R.lapStart = R.time; R.lapTimes.push(lt);
          const best = lt < R.bestLap;
          if (best) R.bestLap = lt;
          if (n < R.laps) this.hud.toast(n === R.laps - 1 ? 'FINAL LAP' : 'LAP ' + (n + 1), 'big', (best ? 'BEST ' : '') + fmtTime(lt));
        }
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------------ effects
  _effects(dt) {
    const R = this.race, fx = this.fx, P = R.player;
    const cam = this.camPos;
    for (const v of R.vehicles) {
      const dx = v.x - cam[0], dz = v.z - cam[2];
      if (dx * dx + dz * dz > 120 * 120) continue;
      const car = v.model;
      const fx_ = Math.sin(v.yaw), fz_ = Math.cos(v.yaw), lx = fz_, lz = -fx_;
      // tyre smoke
      let smoke = 0;
      const slide = Math.abs(v.slipAngle);
      if (v.speed > 10 && v.surface === 'road' && !v.airborne) {
        if (slide > 0.16) smoke = clamp((slide - 0.12) * 2.2, 0, 1);
        if (v.braking && v.speed > 32 && v.ctl.brake > 0.8) smoke = Math.max(smoke, 0.35);
        if (v.ctl.handbrake > 0.5) smoke = Math.max(smoke, 0.7);
      }
      if (v === P && v.speed < 12 && v.ctl.throttle > 0.9 && v.vF > -1 && v.speed > 0.5 && R.started && R.time < 2.5 && R.thrHeldSince > 0.85) smoke = Math.max(smoke, 0.5);
      const rearZ = car.dims.rearAxleZ, ry = 0;
      if (smoke > 0.02) {
        for (const sx of [-0.9, 0.9]) {
          const x = v.x + lx * sx + fx_ * rearZ, z = v.z + lz * sx + fz_ * rearZ;
          fx.tyreSmoke('s' + v.slot + sx, x, v.y, z, v.vx, v.vz, smoke, dt);
        }
      }
      if (v.surface === 'shoulder' && v.speed > 12) {
        for (const sx of [-0.9, 0.9]) fx.dust('d' + v.slot + sx, v.x + lx * sx + fx_ * rearZ, v.y, v.z + lz * sx + fz_ * rearZ, v.vx, v.vz, clamp(v.speed / 50, 0.2, 1), dt);
      }
      // nitro flames
      if (v.nitroGlow > 0.2) {
        const ex = car.dims.exhaust;
        for (let k = 0; k < ex.length; k++) {
          const e = ex[k];
          const x = v.x + lx * e[0] + fx_ * e[2], z = v.z + lz * e[0] + fz_ * e[2];
          fx.nitroFlame('n' + v.slot + k, x, v.y + e[1] - car.dims.groundY, z, -fx_, -fz_, v.speed, v.nitroGlow, dt);
        }
      }
      if (v.nitroOn && !v._wasNitro) { fx.boostPuff(v.x - fx_ * 2.2, v.y + 0.4, v.z - fz_ * 2.2, v.vx, v.vz); if (v === P) { this.audio.nitroKick(); this.flash = Math.max(this.flash, 0.12); this.flashCol = [0.4, 0.7, 1]; } }
      v._wasNitro = v.nitroOn;
    }
    fx.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.4);
    this.flash = Math.max(0, this.flash - dt * 1.6);
  }

  // ------------------------------------------------------------------ camera
  _camera(dt) {
    const R = this.race, p = R.player, world = R.world;
    const car = p.model;
    const spd = p.speed;
    const sr = clamp(spd / (p.topSpeedBase * 1.15), 0, 1.2);
    const fxOn = this.S.fx;
    let eye, look, fov, up = [0, 1, 0];
    const fx_ = Math.sin(p.yaw), fz_ = Math.cos(p.yaw);
    if (this.camMode === 2) {
      // bumper cam
      const z = car.dims.maxZ - 0.55, y = 0.5 - car.dims.groundY;
      eye = [p.x + fx_ * z, p.y + y + 0.12 + p.bodyPitch * 0, p.z + fz_ * z];
      const la = 18;
      look = [eye[0] + fx_ * la, eye[1] + 0.1 + Math.tan(p.pitch) * la * 0.5, eye[2] + fz_ * la];
      fov = 70 + sr * 16 + p.nitroGlow * 6;
      this.camYaw = p.yaw;
      this.camPos = eye.slice();
    } else {
      // heading follows the velocity vector a bit, so drifts are shown at an angle
      let hd = p.yaw;
      if (spd > 7) hd = p.yaw + wrapAngle(Math.atan2(p.vx, p.vz) - p.yaw) * 0.45;
      this.camYaw += wrapAngle(hd - this.camYaw) * damp(4.6, dt);
      const close = this.camMode === 1;
      let dist = (close ? 5.6 : 7.7) + sr * (close ? 0.9 : 1.6) + p.nitroGlow * 0.9;
      const height = (close ? 1.55 : 2.25) + sr * 0.15;
      const cx = Math.sin(this.camYaw), cz = Math.cos(this.camYaw);
      const tx = p.x - cx * dist, tz = p.z - cz * dist;
      // soft follow (distance spring)
      const k = damp(this.state === 'countdown' ? 3 : 10, dt);
      this.camPos[0] += (tx - this.camPos[0]) * k;
      this.camPos[2] += (tz - this.camPos[2]) * k;
      const ty = p.y + height;
      this.camPos[1] += (ty - this.camPos[1]) * damp(7, dt);
      const gh = world.heightAt(this.camPos[0], this.camPos[2]) + 0.7;
      if (this.camPos[1] < gh) this.camPos[1] = gh;
      eye = this.camPos.slice();
      const la = 7 + sr * 7;
      look = [p.x + cx * la, p.y + (close ? 0.9 : 1.25), p.z + cz * la];
      fov = 58 + sr * 17 + p.nitroGlow * 9 + (p.boostTimer > 0 ? 3 : 0);
      // intro fly-in
      if (this.state === 'countdown' && this.introT < 2.4) {
        const t = smoothstep(0, 2.4, this.introT);
        const a = p.yaw + 2.5 - 1.8 * t;
        const rr = 5.5 + 3 * t;
        const ie = [p.x + Math.sin(a) * rr, p.y + 1.2 + 1.4 * t, p.z + Math.cos(a) * rr];
        eye = [lerp(ie[0], eye[0], t * t), lerp(ie[1], eye[1], t * t), lerp(ie[2], eye[2], t * t)];
        look = [lerp(p.x, look[0], t), lerp(p.y + 0.7, look[1], t), lerp(p.z, look[2], t)];
        fov = lerp(42, fov, t);
      }
    }
    // shake
    const sh = fxOn ? (this.shake * 0.35 + p.nitroGlow * sr * 0.03 + (p.surface === 'shoulder' ? Math.min(0.05, spd * 0.0007) : 0) + (spd > 60 ? (spd - 60) * 0.0004 : 0)) : this.shake * 0.12;
    const t = this.time;
    eye[0] += (Math.sin(t * 47) + Math.sin(t * 31 + 1)) * 0.5 * sh;
    eye[1] += (Math.sin(t * 53 + 2) + Math.sin(t * 29)) * 0.5 * sh;
    eye[2] += (Math.sin(t * 41 + 4)) * 0.5 * sh;
    // roll with lateral g
    const roll = this.camMode === 2 ? 0 : clamp(-p.yawRate * p.vF * 0.0007, -0.04, 0.04);
    up = [Math.sin(roll), Math.cos(roll), 0];
    const r = this.r;
    m4.lookAt(this.view, eye, look, up);
    const asp = r.canvas.clientWidth / Math.max(1, r.canvas.clientHeight);
    m4.perspective(this.proj, fov * DEG, asp, 0.2, 3200);
    this.eye = eye;
    this.camFov = fov;
    this.camLook = look;
    // sun on screen (for sun shafts)
    const env = R.env;
    const sd = env.sunDir;
    const sx = eye[0] + sd[0] * 1000, sy = eye[1] + sd[1] * 1000, sz = eye[2] + sd[2] * 1000;
    const vp = r.viewProj; // from last frame (good enough)
    const cwv = vp[3] * sx + vp[7] * sy + vp[11] * sz + vp[15];
    if (cwv > 0.01) {
      this.sunUV = [((vp[0] * sx + vp[4] * sy + vp[8] * sz + vp[12]) / cwv) * 0.5 + 0.5, ((vp[1] * sx + vp[5] * sy + vp[9] * sz + vp[13]) / cwv) * 0.5 + 0.5];
      this.sunVis = 1;
    } else this.sunVis = 0;
  }

  // ------------------------------------------------------------------ audio feed
  _audio(dt) {
    const R = this.race, p = R.player, a = this.audio;
    if (!a.ready) return;
    const slide = Math.abs(p.slipAngle);
    let slip = p.speed > 8 && p.surface === 'road' && !p.airborne ? clamp((slide - 0.09) * 3.2, 0, 1) : 0;
    if (p.braking && p.speed > 28 && p.ctl.brake > 0.8) slip = Math.max(slip, 0.35);
    if (p.ctl.handbrake > 0.5 && p.speed > 8) slip = Math.max(slip, 0.6);
    const voices = [];
    const near = R.ais.filter((c) => !c.finished || true).map((c) => ({ c, d: Math.hypot(c.x - p.x, c.z - p.z) })).filter((o) => o.d < 130).sort((x, y) => x.d - y.d).slice(0, 3);
    const rx = this.view[0], rz = this.view[8];
    for (const o of near) {
      const c = o.c, d = Math.max(1, o.d);
      const rel = [(c.x - p.x) / d, (c.z - p.z) / d];
      const rv = (c.vx - p.vx) * rel[0] + (c.vz - p.vz) * rel[1];
      voices.push({ rpm: c.rpm, gain: Math.pow(clamp(1 - d / 130, 0, 1), 2), pan: (rel[0] * rx + rel[1] * rz), dop: 340 / (340 + rv) });
    }
    a.update({
      active: this.state === 'racing' || this.state === 'countdown' || this.state === 'finished',
      rpm: p.rpm, throttle: p.ctl.throttle, speed: p.speed, maxSpeed: p.topSpeedBase, nitro: p.nitroGlow, slip, scrape: p.scrape, surface: p.surface,
    }, dt, voices);
    if (p.gear !== this._lastGear) { if (p.gear > (this._lastGear ?? 0)) a.shift(); this._lastGear = p.gear; }
  }

  // ------------------------------------------------------------------ race rendering
  _renderRace(dt) {
    const R = this.race, r = this.r, env = R.env, world = R.world;
    const P = R.player;
    if (!this.eye) return;
    r.beginFrame(this.time);
    r.setCamera(this.view, this.proj, this.eye);
    // headlights
    r.spots = [];
    const dark = env.night || env.wet > 0.5;
    if (dark) {
      const fx_ = Math.sin(P.yaw), fz_ = Math.cos(P.yaw), lx = fz_, lz = -fx_;
      const hy = P.y + 0.62;
      for (const sx of [-0.62, 0.62]) {
        const px = P.x + lx * sx + fx_ * 2.0, pz = P.z + lz * sx + fz_ * 2.0;
        const tilt = -0.07 + Math.tan(P.pitch) * 0.5;
        const dl = Math.hypot(1, tilt);
        r.spots.push({ pos: [px, hy, pz], dir: [fx_ / dl, tilt / dl, fz_ / dl], color: [34, 31, 24], range: 95, cosInner: Math.cos(9 * DEG), cosOuter: Math.cos(27 * DEG) });
      }
    }
    const focus = [P.x, P.y, P.z];
    r.updateShadow(focus, r.q.shadowRadius);
    r.beginShadowPass();
    world.drawShadow(focus, this.eye);
    for (const v of R.vehicles) {
      if (v !== P && Math.hypot(v.x - P.x, v.z - P.z) > r.q.shadowRadius * 1.1) continue;
      drawCar(r, v.model, this._carMatrix(v, v.model), { wheelSpin: v.wheelSpin, steer: v.steerVis, paint: v.paintU }, false);
    }
    r.endShadowPass();
    r.beginMainPass([0, 0, 0]);
    r.drawSky();
    world.drawMain(this.eye);
    const night = env.night ? 1 : 0;
    const vis = [];
    for (const v of R.vehicles) {
      const dx = v.x - this.eye[0], dz = v.z - this.eye[2];
      if (dx * dx + dz * dz > 650 * 650) continue;
      if (v !== P && !r.inFrustum(v.x, v.y + 0.7, v.z, 3.6)) continue;
      vis.push(v);
    }
    for (const v of vis) {
      const M = this._carMatrix(v, v.model);
      drawCar(r, v.model, M, { wheelSpin: v.wheelSpin, steer: v.steerVis, paint: v.paintU, tail: (v.braking ? 2.6 : 0.7) + night * 1.2, head: 0.8 + night * 2.2 }, false);
    }
    for (const v of vis) drawContactShadow(r, v, v.model, night ? 0.6 : 0.5);
    for (const v of vis) drawCar(r, v.model, this._carMatrix(v, v.model), { wheelSpin: v.wheelSpin, steer: v.steerVis, paint: v.paintU }, true);
    world.drawDecals();
    r.drawParticles();
    r.endMainPass();
    const spd = P.speed, sr = clamp(spd / (P.topSpeedBase * 1.15), 0, 1.3);
    const fxOn = this.S.fx;
    const g = env.grade;
    r.post({
      exposure: env.exposure, bloom: env.bloom, bloomThreshold: env.bloomThreshold,
      saturation: g.saturation, lift: g.lift, gain: g.gain, contrast: g.contrast,
      vignette: 0.3 + sr * 0.18 + P.nitroGlow * 0.12,
      blur: fxOn ? Math.max(0, sr - 0.4) * 0.1 + P.nitroGlow * 0.07 + (P.boostTimer > 0 ? 0.015 : 0) : 0,
      ca: fxOn ? 0.0015 + P.nitroGlow * 0.008 + Math.max(0, sr - 0.7) * 0.004 : 0.0008,
      speedLines: fxOn ? clamp((sr - 0.55) * 1.6, 0, 1) * 0.6 + P.nitroGlow * 0.8 : 0,
      flash: this.flash, flashColor: this.flashCol,
      sunU: this.sunUV ? this.sunUV[0] : 0.5, sunV: this.sunUV ? this.sunUV[1] : 0.5, sunShaft: this.sunVis ? (env.sunShaft || 0) : 0,
      blurCx: 0.5, blurCy: 0.46, grain: env.night ? 0.02 : 0.012,
    });
  }
}

const game = new Game();
if (!window.__noStart) {
  game.boot().catch((e) => {
    console.error(e);
    const m = $('bootMsg'); if (m) m.textContent = 'Error: ' + e.message;
  });
}
window.__game = game;
