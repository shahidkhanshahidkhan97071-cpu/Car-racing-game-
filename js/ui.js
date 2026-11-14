// HUD + small DOM helpers.
const _dummy = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, children: [], textContent: '', innerHTML: '', value: '', disabled: false, dataset: {}, addEventListener() {}, appendChild() {}, removeChild() {}, getContext() { return new Proxy({}, { get: () => () => {}, set: () => true }); }, focus() {}, offsetWidth: 0 });
const $ = (id) => document.getElementById(id) || _dummy();

export function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '--:--.--';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
export const ordinal = (n) => (n === 1 ? ['1', 'ST'] : n === 2 ? ['2', 'ND'] : n === 3 ? ['3', 'RD'] : [String(n), 'TH']);

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {
      posNum: $('posNum'), posTot: $('posTot'), lapNum: $('lapNum'), lapTot: $('lapTot'),
      raceTime: $('raceTime'), lapTime: $('lapTime'), speedNum: $('speedNum'), speedUnit: $('speedUnit'),
      gear: $('gearNum'), nitroFill: $('nitroFill'), nitroBar: $('nitroBar'), toasts: $('toasts'),
      countdown: $('countdown'), wrong: $('wrongway'), tower: $('tower'), hint: $('hintBar'), fps: $('fps'),
      trackName: $('trackName'),
    };
    this.arc = $('speedArc').getContext('2d');
    this.mm = $('minimap').getContext('2d');
    this.mmBase = null;
    this.cache = {};
    this.towerT = 0;
    this.speedSmooth = 0;
  }
  show() { this.root.classList.remove('hidden'); }
  hide() { this.root.classList.add('hidden'); }

  _set(key, el, val) {
    if (this.cache[key] !== val) { this.cache[key] = val; el.textContent = val; }
  }

  setup(track, trackName, laps, total, units) {
    this.cache = {};
    this.units = units;
    this.laps = laps; this.total = total;
    this.el.trackName.textContent = trackName;
    this.el.speedUnit.textContent = units === 'mph' ? 'MPH' : 'KM/H';
    this.el.hint.style.opacity = 1;
    this.el.hint.style.transition = 'none';
    this.el.tower.innerHTML = '';
    this.towerRows = [];
    const rows = Math.min(total, 6);
    for (let i = 0; i < rows; i++) {
      const d = document.createElement('div'); d.className = 'trow';
      d.innerHTML = '<span class="pn"></span><span class="dot"></span><span class="nm"></span><span class="gp"></span>';
      this.el.tower.appendChild(d);
      this.towerRows.push({ d, pn: d.children[0], dot: d.children[1], nm: d.children[2], gp: d.children[3] });
    }
    this._buildMinimap(track);
    setTimeout(() => { this.el.hint.style.transition = 'opacity 2s'; this.el.hint.style.opacity = 0; }, 9000);
  }

  _buildMinimap(track) {
    const S = 300;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (let i = 0; i < track.N; i++) { minx = Math.min(minx, track.x[i]); maxx = Math.max(maxx, track.x[i]); minz = Math.min(minz, track.z[i]); maxz = Math.max(maxz, track.z[i]); }
    const pad = 22, sc = (S - pad * 2) / Math.max(maxx - minx, maxz - minz);
    const ox = pad + ((S - pad * 2) - (maxx - minx) * sc) / 2, oz = pad + ((S - pad * 2) - (maxz - minz) * sc) / 2;
    // screen: +x right, +z up (flip so north-up looks natural)
    const px = (x) => ox + (x - minx) * sc, py = (z) => S - (oz + (z - minz) * sc);
    this.mmMap = { px, py };
    g.lineJoin = 'round'; g.lineCap = 'round';
    const path = () => {
      g.beginPath();
      for (let i = 0; i < track.N; i += 3) { const X = px(track.x[i]), Y = py(track.z[i]); i === 0 ? g.moveTo(X, Y) : g.lineTo(X, Y); }
      g.closePath();
    };
    g.fillStyle = 'rgba(6,9,14,.55)'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, 7); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 13; path(); g.stroke();
    g.strokeStyle = 'rgba(210,220,235,.9)'; g.lineWidth = 7; path(); g.stroke();
    g.strokeStyle = 'rgba(30,36,48,.95)'; g.lineWidth = 3.5; path(); g.stroke();
    // start line
    const a = { x: track.x[0], z: track.z[0] };
    g.fillStyle = '#fff'; g.beginPath(); g.arc(px(a.x), py(a.z), 5, 0, 7); g.fill();
    this.mmBase = c;
  }

  toast(text, cls = '', sub = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + cls;
    d.innerHTML = text + (sub ? `<small>${sub}</small>` : '');
    this.el.toasts.appendChild(d);
    while (this.el.toasts.children.length > 3) this.el.toasts.removeChild(this.el.toasts.firstChild);
    setTimeout(() => d.remove(), 1900);
  }

  countdown(txt, go = false) {
    const c = this.el.countdown;
    c.textContent = txt;
    c.className = '';
    void c.offsetWidth;
    c.className = 'pop' + (go ? ' go' : '');
  }
  clearCountdown() { this.el.countdown.textContent = ''; this.el.countdown.className = ''; }

  update(d, dt) {
    const e = this.el;
    this._set('pos', e.posNum, String(d.pos));
    this._set('tot', e.posTot, '/' + d.total);
    this._set('lap', e.lapNum, String(Math.min(Math.max(d.lap + 1, 1), d.laps)));
    this._set('laps', e.lapTot, '/' + d.laps);
    this._set('time', e.raceTime, fmtTime(Math.max(0, d.time)));
    const lt = d.bestLap < 1e8 ? 'BEST ' + fmtTime(d.bestLap) : '';
    this._set('lt', e.lapTime, lt);
    const sp = d.speed * (this.units === 'mph' ? 2.23694 : 3.6);
    this.speedSmooth += (sp - this.speedSmooth) * Math.min(1, dt * 14);
    this._set('spd', e.speedNum, String(Math.round(this.speedSmooth)));
    this._set('gear', e.gear, d.reverse ? 'R' : d.speed < 0.8 ? 'N' : String(d.gear + 1));
    const nit = Math.max(0, Math.min(100, d.nitro));
    this._set('nitro', { set textContent(v) { e.nitroFill.style.width = v + '%'; } }, nit.toFixed(0));
    e.nitroBar.classList.toggle('active', !!d.nitroOn);
    e.nitroBar.classList.toggle('full', nit > 98);
    e.wrong.classList.toggle('hidden', !d.wrongWay);
    this._drawArc(d);
    this._drawMinimap(d);
    this.towerT -= dt;
    if (this.towerT <= 0) { this.towerT = 0.2; this._tower(d); }
  }

  _drawArc(d) {
    const g = this.arc, W = 440, cx = 220, cy = 220, R = 188;
    g.clearRect(0, 0, W, W);
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    const maxKmh = 400;
    const kmh = d.speed * 3.6;
    const f = Math.max(0, Math.min(1, kmh / maxKmh));
    g.lineCap = 'butt';
    g.lineWidth = 20; g.strokeStyle = 'rgba(8,11,18,.55)';
    g.beginPath(); g.arc(cx, cy, R, a0, a0 + sweep); g.stroke();
    // ticks
    for (let i = 0; i <= 20; i++) {
      const a = a0 + (sweep * i) / 20, major = i % 5 === 0;
      g.strokeStyle = major ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.3)';
      g.lineWidth = major ? 3 : 1.5;
      const r1 = R - 18, r2 = R - (major ? 34 : 27);
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    }
    if (f > 0.002) {
      const grad = g.createLinearGradient(cx - R, cy + R, cx + R, cy - R);
      if (d.nitroOn) { grad.addColorStop(0, '#1b8cff'); grad.addColorStop(1, '#bff'); }
      else { grad.addColorStop(0, '#ffb347'); grad.addColorStop(0.55, '#ff7a1a'); grad.addColorStop(1, '#ff2d55'); }
      g.strokeStyle = grad; g.lineWidth = 20;
      g.shadowColor = d.nitroOn ? '#22d3ff' : '#ff7a1a'; g.shadowBlur = 18;
      g.beginPath(); g.arc(cx, cy, R, a0, a0 + sweep * f); g.stroke();
      g.shadowBlur = 0;
    }
    // rpm needle ring (thin inner)
    const rf = Math.max(0, Math.min(1, d.rpm));
    g.lineWidth = 5;
    g.strokeStyle = rf > 0.9 ? '#ff2d55' : 'rgba(255,255,255,.85)';
    g.beginPath(); g.arc(cx, cy, R - 46, a0, a0 + sweep * rf); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.beginPath(); g.arc(cx, cy, R - 46, a0 + sweep * rf, a0 + sweep); g.stroke();
  }

  _drawMinimap(d) {
    const g = this.mm, S = 300;
    g.clearRect(0, 0, S, S);
    if (!this.mmBase) return;
    g.drawImage(this.mmBase, 0, 0);
    const { px, py } = this.mmMap;
    for (const c of d.cars) {
      if (c.isPlayer) continue;
      g.fillStyle = c.cssColor || '#9ad';
      g.strokeStyle = 'rgba(0,0,0,.8)'; g.lineWidth = 2;
      g.beginPath(); g.arc(px(c.x), py(c.z), 5, 0, 7); g.fill(); g.stroke();
    }
    const p = d.player;
    // player arrow
    g.save();
    g.translate(px(p.x), py(p.z));
    g.rotate(p.yaw); // map is north(+z)-up, yaw 0 faces +z
    g.fillStyle = '#ff7a1a'; g.strokeStyle = '#fff'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill(); g.stroke();
    g.restore();
  }

  _tower(d) {
    const rows = this.towerRows;
    if (!rows || !rows.length) return;
    const sorted = d.sorted;
    const leaderProg = sorted[0].progress;
    // always show the player; window around them
    let start = 0;
    const pIdx = d.pos - 1;
    if (sorted.length > rows.length) start = Math.max(0, Math.min(sorted.length - rows.length, pIdx - 2));
    for (let i = 0; i < rows.length; i++) {
      const c = sorted[start + i], r = rows[i];
      if (!c) { r.d.style.display = 'none'; continue; }
      r.d.style.display = '';
      r.d.classList.toggle('me', c.isPlayer);
      r.pn.textContent = start + i + 1;
      r.dot.style.background = c.cssColor || '#9ad';
      r.nm.textContent = c.name;
      if (start + i === 0) r.gp.textContent = '';
      else {
        const gapM = leaderProg - c.progress;
        r.gp.textContent = c.finished ? 'FIN' : '+' + (gapM / Math.max(25, sorted[0].speed || 25)).toFixed(1) + 's';
      }
    }
  }
}
