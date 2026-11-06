"use strict";

/* ============================================================
   Data
   ============================================================ */

const COLORS = { yellow: "#F7C948", green: "#3DBE6B", purple: "#8E5CD9", blue: "#3B82F6", pink: "#F06BAA" };
const COLOR_ORDER = Object.keys(COLORS);
const JOKER_COLOR = "#E8E8F0";

const SIDES = {
  A: [
    { id: "artist",   color: "yellow", name: "Artist",       rule: "For collabs, the main artist counts" },
    { id: "title",    color: "green",  name: "Song name",    rule: "Close enough? The others decide" },
    { id: "decade",   color: "purple", name: "Decade",       rule: "e.g. 1980s" },
    { id: "closest",  color: "blue",   name: "Closest wins", rule: "Guess the year; only the closest scores" },
    { id: "soloBand", color: "pink",   name: "Solo or band", rule: "Collabs and features count as band" }
  ],
  B: [
    { id: "otherSong", color: "yellow", name: "Different song", rule: "Another song by the same artist" },
    { id: "origin",    color: "green",  name: "Origin",         rule: "Artist's home country" },
    { id: "double",    color: "purple", name: "Double",         rule: "Two random Side A categories, both correct", draw: 2 },
    { id: "intro",     color: "blue",   name: "Intro only",     rule: "Track stops after 10 s – artist or song", introSeconds: 10 },
    { id: "pm2",       color: "pink",   name: "Year ±2",        rule: "Within 2 years counts", tolerance: 2 }
  ]
};

const JOKER = { id: "joker", name: "Joker", rule: "Everyone picks a colour on their card before the song; right → cross a box of it", chance: 1 / 12 };

const EMOJIS = ["🎸", "🎤", "🎧", "🥁", "🎹", "🎺", "🎷", "🪩", "🦄", "🐙", "🦊", "🐸",
                "🐼", "🦁", "🌵", "🍕", "🌈", "⭐", "🔥", "👑", "🚀", "🍉", "🤠", "👽"];
const JOKER_OPTIONS = [0, 8, 12, 20]; // "1 in N" spins; 0 = off
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const MAX_UNDO = 60;
const SPIN_MS = 3200;
const STORE_KEY = "hitster-bingo-v1";

// All 12 bingo lines on a 5×5 card (indices 0..24, row-major)
const LINES = (() => {
  const r = [0, 1, 2, 3, 4], lines = [];
  r.forEach(i => lines.push(r.map(j => i * 5 + j)));   // rows
  r.forEach(j => lines.push(r.map(i => i * 5 + j)));   // columns
  lines.push(r.map(i => i * 6));                        // diagonal ↘
  lines.push(r.map(i => (i + 1) * 4));                  // diagonal ↙
  return lines;
})();

/* ============================================================
   Helpers
   ============================================================ */

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const catFor = (color, side) => SIDES[side].find(c => c.color === color);
const catById = id => SIDES.A.concat(SIDES.B).find(c => c.id === id);

// Can colour c go at index i, given cells 0..i-1? Keeps colours spread out:
//  - never two of the same colour side by side or on top of each other
//  - never three in a diagonal run
//  - at most 2 of a colour per row and per column
function fitsSpread(cells, i, c) {
  const r = Math.floor(i / 5), col = i % 5;
  if (col > 0 && cells[i - 1] === c) return false;
  if (r > 0 && cells[i - 5] === c) return false;
  if (r >= 2 && col >= 2 && cells[i - 6] === c && cells[i - 12] === c) return false;
  if (r >= 2 && col <= 2 && cells[i - 4] === c && cells[i - 8] === c) return false;
  let inRow = 0, inCol = 0;
  for (let k = 0; k < col; k++) if (cells[r * 5 + k] === c) inRow++;
  for (let k = 0; k < r; k++) if (cells[k * 5 + col] === c) inCol++;
  return inRow < 2 && inCol < 2;
}

// Random 5×5 card, each colour 5 times, filled box by box with backtracking
function makeCard() {
  for (;;) {
    const cells = [], left = Object.fromEntries(COLOR_ORDER.map(c => [c, 5]));
    const fill = i => {
      if (i === 25) return true;
      for (const c of shuffle(COLOR_ORDER)) {
        if (!left[c] || !fitsSpread(cells, i, c)) continue;
        cells[i] = c;
        left[c]--;
        if (fill(i + 1)) return true;
        left[c]++;
      }
      cells.length = i;
      return false;
    };
    if (fill(0) && LINES.every(line => new Set(line.map(i => cells[i])).size > 1)) return cells;
  }
}

const completedLines = p => LINES.filter(line => line.every(i => p.marks[i]));

/* ============================================================
   State + persistence
   ============================================================ */

let state, history, rotation;

function freshState() {
  return {
    screen: "setup",
    setup: {
      players: [{ name: "", emoji: "🎸" }, { name: "", emoji: "🎤" }],
      side: "A",
      timer: 0,           // seconds; 0 = no timer
      jokerEvery: 12
    },
    game: null
  };
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && saved.state && saved.state.setup) {
      state = saved.state;
      history = saved.history || [];
      rotation = saved.rotation || 0;
      return;
    }
  } catch (e) { /* corrupt or blocked storage – start fresh */ }
  state = freshState();
  history = [];
  rotation = 0;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ state, history, rotation }));
  } catch (e) { /* storage unavailable – game still works, just won't resume */ }
}

function pushHistory() {
  history.push(JSON.stringify(state.game));
  if (history.length > MAX_UNDO) history.shift();
}

function buildGame(players, side, timer, jokerEvery) {
  const seen = new Set();
  const ps = players.map((p, i) => {
    let card;
    do card = makeCard(); while (seen.has(card.join()));
    seen.add(card.join());
    return { id: "p" + i, name: p.name, emoji: p.emoji, card, marks: Array(25).fill(false) };
  });
  return {
    side, timer, jokerEvery,
    players: ps,

    roundNo: 1,
    phase: "idle",      // idle | spinning | result
    result: null,       // colour key or "joker"
    double: [],         // two Side A category ids for "Double"
    placed: {},         // this round: playerId -> index of the cross they placed
    picks: {},          // Joker round: playerId -> colour they picked on their card
    tie: null,          // playerIds in a tie-break
    tieRight: {},       // tie-break round: playerId -> true if right
    winner: null        // { id }
  };
}

const G = () => state.game;
const playerById = id => G().players.find(p => p.id === id);

/* ============================================================
   Audio + wake lock
   ============================================================ */

let actx = null;
function ensureAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) actx = new AC();
  }
  if (actx && actx.state === "suspended") actx.resume();
}

function beep(freq, dur = 0.15, { type = "sine", vol = 0.2, delay = 0 } = {}) {
  if (!actx) return;
  const t = actx.currentTime + delay;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const sounds = {
  tick: () => beep(1200, 0.05, { type: "square", vol: 0.08 }),
  land: () => { beep(784, 0.12); beep(1047, 0.25, { delay: 0.1 }); },
  stop: () => { beep(660, 0.25, { type: "square", vol: 0.15 }); beep(440, 0.4, { type: "square", vol: 0.15, delay: 0.25 }); },
  alarm: () => [0, 0.3, 0.6].forEach(d => beep(880, 0.22, { type: "square", vol: 0.2, delay: d })),
  win: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => beep(f, 0.2, { type: "triangle", vol: 0.2, delay: i * 0.13 }))
};

let wakeLock = null;
async function keepAwake() {
  if (wakeLock || state.screen === "setup" || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (e) { /* not allowed – ignore */ }
}
document.addEventListener("visibilitychange", keepAwake);

/* ============================================================
   UI bits: toast, modal, flash
   ============================================================ */

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function openModal(html) {
  $("#modalBox").innerHTML = html;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }

function flashScreen(kind) {
  document.body.classList.remove("flash-red", "flash-white");
  void document.body.offsetWidth; // restart animation
  document.body.classList.add(kind === "white" ? "flash-white" : "flash-red");
}

/* ============================================================
   Timer (persistent DOM node, survives stage re-renders)
   ============================================================ */

const Timer = {
  SEG: 25,
  el: null,
  key: null,
  total: 25,
  intro: 0,
  mode: "answer",     // intro | answer
  remaining: 25,
  running: false,
  ended: false,
  raf: 0,
  last: 0,

  build() {
    const el = document.createElement("div");
    el.className = "timer";
    let segs = "";
    for (let i = 0; i < this.SEG; i++) {
      const a0 = (i / this.SEG) * 360 + 1.6, a1 = ((i + 1) / this.SEG) * 360 - 1.6;
      segs += `<path class="seg" d="${arcPath(100, 100, 94, 72, a0, a1)}" style="--c:${COLORS[COLOR_ORDER[i % 5]]}"/>`;
    }
    el.innerHTML = `
      <div class="timer-dial">
        <svg viewBox="0 0 200 200">${segs}</svg>
        <div class="timer-center"><div class="timer-label"></div><div class="timer-num"></div></div>
      </div>
      <div class="timer-controls">
        <button class="btn primary" data-action="timerToggle"></button>
        <button class="btn ghost" data-action="timerReset">Reset</button>
      </div>`;
    this.el = el;
    this.segEls = [...el.querySelectorAll(".seg")];
    this.reset();
  },

  prepare(key, total, intro) {
    if (key !== this.key || (!this.running && this.remaining === this.full() && (total !== this.total || intro !== this.intro))) {
      this.key = key;
      this.total = total;
      this.intro = intro;
      this.reset();
    }
  },

  full() { return this.mode === "intro" ? this.intro : this.total; },

  reset() {
    cancelAnimationFrame(this.raf);
    this.running = false;
    this.ended = false;
    this.mode = this.intro ? "intro" : "answer";
    this.remaining = this.full();
    this.el.classList.remove("ended");
    this.draw();
  },

  toggle() { this.running ? this.pause() : this.start(); },

  start() {
    if (this.ended) this.reset();
    this.running = true;
    this.last = performance.now();
    const loop = now => {
      if (!this.running) return;
      const before = this.remaining;
      this.remaining -= (now - this.last) / 1000;
      this.last = now;
      if (this.mode === "answer" && Math.ceil(this.remaining) < Math.ceil(before) && this.remaining > 0 && this.remaining <= 5) sounds.tick();
      if (this.remaining <= 0) {
        if (this.mode === "intro") {
          sounds.stop();
          flashScreen("white");
          toast("⏹ Stop the track!");
          if (!this.total) {
            // answer timer is off: the intro countdown is all there is
            this.remaining = 0;
            this.running = false;
            this.ended = true;
            this.draw();
            return;
          }
          this.mode = "answer";
          this.remaining = this.total;
        } else {
          this.remaining = 0;
          this.running = false;
          this.ended = true;
          this.el.classList.add("ended");
          sounds.alarm();
          flashScreen("red");
          this.draw();
          return;
        }
      }
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.draw();
  },

  pause() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.draw();
  },

  draw() {
    const lit = Math.ceil((this.remaining / (this.full() || 1)) * this.SEG - 1e-6);
    this.segEls.forEach((s, i) => s.classList.toggle("on", i < lit));
    this.el.classList.toggle("intro", this.mode === "intro");
    this.el.querySelector(".timer-num").textContent = this.ended ? "0" : Math.ceil(this.remaining);
    this.el.querySelector(".timer-label").textContent =
      this.ended ? (this.total ? "Time's up!" : "Stop track!") : this.mode === "intro" ? "Stop track in" : "Answer";
    this.el.querySelector('[data-action="timerToggle"]').textContent =
      this.running ? "⏸ Pause" : this.ended ? "↻ Restart" : this.remaining < this.full() ? "▶ Resume" : "▶ Start";
  }
};

function arcPath(cx, cy, rO, rI, a0, a1) {
  const p = (r, a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${p(rO, a0)} A${rO} ${rO} 0 ${large} 1 ${p(rO, a1)} L${p(rI, a1)} A${rI} ${rI} 0 ${large} 0 ${p(rI, a0)} Z`;
}

/* ============================================================
   Spinner
   ============================================================ */

function segments(g) {
  const jokerDeg = g.jokerEvery ? 360 / g.jokerEvery : 0;
  const colDeg = (360 - jokerDeg) / 5;
  const segs = COLOR_ORDER.map((c, i) => ({ key: c, start: i * colDeg, end: (i + 1) * colDeg }));
  if (jokerDeg) segs.push({ key: "joker", start: 360 - jokerDeg, end: 360 });
  return segs;
}

// f < 1 darkens towards black, f > 1 lightens towards white
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  return "#" + [16, 8, 0].map(s => {
    const c = (n >> s) & 255;
    const v = f < 1 ? c * f : c + (255 - c) * (f - 1);
    return Math.round(v).toString(16).padStart(2, "0");
  }).join("");
}

// deterministic pseudo-random, so the mirror tiles don't reshuffle on every render
const hash = i => { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); };
const polar = (r, a) => {
  const rad = ((a - 90) * Math.PI) / 180;
  return `${(r * Math.cos(rad)).toFixed(2)} ${(r * Math.sin(rad)).toFixed(2)}`;
};

let wheelKey = null;
function renderSpinner() {
  const g = G();
  const key = g.side + g.jokerEvery;
  if (key !== wheelKey) {
    wheelKey = key;
    $("#ballSvg").innerHTML = wheelSVG(g);
    if (!$("#rim").innerHTML) $("#rim").innerHTML = rimSVG();
  }
  const spinner = $("#spinner");
  const landed = !["idle", "spinning"].includes(g.phase) && g.result;
  spinner.classList.toggle("ready", g.phase === "idle");
  spinner.classList.toggle("spinning", g.phase === "spinning");
  spinner.classList.toggle("landed", !!landed);
  spinner.style.setProperty("--pc", landed ? (g.result === "joker" ? JOKER_COLOR : COLORS[g.result]) : "#ffffff");
  $("#hub").innerHTML = g.phase === "idle" ? "SPIN" : g.phase === "spinning" ? "♫" : g.result === "joker" ? "★" : "";
}

function wheelSVG(g) {
  const segs = segments(g);
  const colorAt = a => {
    const s = segs.find(s => a >= s.start && a < s.end) || segs[segs.length - 1];
    return s.key === "joker" ? JOKER_COLOR : COLORS[s.key];
  };

  const wedges = segs.map(s => {
    const fill = s.key === "joker" ? "url(#jokerFill)" : COLORS[s.key];
    const large = s.end - s.start > 180 ? 1 : 0;
    return `<path d="M0 0 L${polar(100, s.start)} A100 100 0 ${large} 1 ${polar(100, s.end)} Z" fill="${fill}"/>`;
  }).join("");

  // mirror tiles: concentric rings of small facets, each tinted by the wedge beneath it
  let tiles = "", n = 0;
  for (let r = 14; r < 100; r += 7.5) {
    const r2 = Math.min(r + 7.5, 100);
    const count = Math.max(8, Math.round((2 * Math.PI * r) / 8));
    const step = 360 / count;
    const off = (r * 7) % step;
    for (let k = 0; k < count; k++) {
      const a0 = k * step + off + 0.6, a1 = (k + 1) * step + off - 0.6;
      const mid = (((a0 + a1) / 2) % 360 + 360) % 360;
      const shine = hash(n++);
      const fill = shine > 0.92 ? "#ffffff" : shade(colorAt(mid), 0.8 + shine * 0.4);
      tiles += `<path d="M${polar(r + 0.5, a0)} A${r} ${r} 0 0 1 ${polar(r + 0.5, a1)} L${polar(r2 - 0.5, a1)} A${r2} ${r2} 0 0 0 ${polar(r2 - 0.5, a0)} Z" fill="${fill}"/>`;
    }
  }

  const dividers = segs.map(s => {
    const [x, y] = polar(100, s.start).split(" ");
    return `<line x1="0" y1="0" x2="${x}" y2="${y}"/>`;
  }).join("");

  const labels = segs.map((s, i) => {
    if (s.key === "joker") {
      const mid = (s.start + s.end) / 2;
      const [x, y] = polar(52, mid).split(" ");
      const star = `<text class="wl-star" x="${x}" y="${y}" transform="rotate(${mid} ${x} ${y})">★</text>`;
      // the joker wedge is narrow: only write the name when it fits (1 in 12 or more often)
      if (s.end - s.start < 24) return star;
      return `${star}<path id="lp${i}" d="M${polar(74, s.start + 1.5)} A74 74 0 0 1 ${polar(74, s.end - 1.5)}" fill="none"/>
        <text class="wl wl-joker"><textPath href="#lp${i}" startOffset="50%" text-anchor="middle">Joker</textPath></text>`;
    }
    const pad = 3;
    return `<path id="lp${i}" d="M${polar(72, s.start + pad)} A72 72 0 0 1 ${polar(72, s.end - pad)}" fill="none"/>
      <text class="wl"><textPath href="#lp${i}" startOffset="50%" text-anchor="middle">${esc(catFor(s.key, g.side).name)}</textPath></text>`;
  }).join("");

  return `
    <defs>
      <linearGradient id="jokerFill" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fdf6ff"/><stop offset=".5" stop-color="#cfd3e6"/><stop offset="1" stop-color="#f7e8ff"/>
      </linearGradient>
      <radialGradient id="depth" cx="0" cy="0" r="100" gradientUnits="userSpaceOnUse">
        <stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/>
      </radialGradient>
    </defs>
    <g class="wedges">${wedges}</g>
    <g class="tiles">${tiles}</g>
    <circle r="100" fill="url(#depth)"/>
    <g class="dividers">${dividers}</g>
    <g class="labels">${labels}</g>`;
}

function rimSVG() {
  const bulbs = Array.from({ length: 28 }, (_, i) => {
    const [x, y] = polar(110, (i / 28) * 360).split(" ");
    return `<circle class="bulb ${i % 2 ? "b" : "a"}" cx="${x}" cy="${y}" r="3.6"/>`;
  }).join("");
  return `
    <defs>
      <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#f4f4ff"/><stop offset=".35" stop-color="#8b86a8"/>
        <stop offset=".6" stop-color="#e8e6f5"/><stop offset="1" stop-color="#5d5878"/>
      </linearGradient>
    </defs>
    <circle r="110" fill="none" stroke="url(#chrome)" stroke-width="15"/>
    <circle r="103" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="2"/>
    ${bulbs}`;
}

function setBallRotation(animate) {
  const ball = $("#ball");
  ball.style.transition = animate ? `transform ${SPIN_MS}ms cubic-bezier(.12,.72,.18,1)` : "none";
  ball.style.transform = `rotate(${rotation}deg)`;
}

let spinTimeout;
function spin() {
  let g = G();
  if (g && g.phase === "result") {
    // tapping the ball mid-round = "next round" + spin
    finishRound();
    if (state.screen !== "game") return;
    g = G();
  }
  if (!g || g.phase !== "idle") return;
  pushHistory();

  const isJoker = g.jokerEvery > 0 && Math.random() < 1 / g.jokerEvery;
  const result = isJoker ? "joker" : COLOR_ORDER[Math.floor(Math.random() * 5)];
  const seg = segments(g).find(s => s.key === result);
  const margin = Math.min(5, (seg.end - seg.start) / 4);
  const landAt = seg.start + margin + Math.random() * (seg.end - seg.start - 2 * margin);

  // Pointer is at the top (0°): rotate so that `landAt` ends up there, after 5+ full turns.
  let target = rotation + 360 * 5;
  target += (((-landAt - target) % 360) + 360) % 360;
  rotation = target;

  g.phase = "spinning";
  g.result = result;
  g.double = shuffle(SIDES.A.filter(c => c.id !== "closest")).slice(0, 2).map(c => c.id);
  g.placed = {};
  g.picks = {};
  g.tieRight = {};
  save();
  setBallRotation(true);
  render();
  clearTimeout(spinTimeout);
  spinTimeout = setTimeout(finishSpin, SPIN_MS + 50);
}

function finishSpin() {
  const g = G();
  if (!g || g.phase !== "spinning") return;
  g.phase = "result";
  save();
  sounds.land();
  render();
}

/* ============================================================
   Round flow
   ============================================================ */

const introSecondsFor = g => (g.result && g.result !== "joker" && catFor(g.result, g.side).introSeconds) || 0;

// This round's colour for a player: the spun colour, or on a Joker the colour they picked on their card
const roundColour = (g, pid) => (g.result === "joker" ? g.picks[pid] : g.result);

// Can this box take this round's cross?
function canPlace(g, p, idx) {
  if (g.phase !== "result" || g.tie || !roundColour(g, p.id)) return false;
  if (g.placed[p.id] === idx) return true;
  if (p.marks[idx]) return false;
  return p.card[idx] === roundColour(g, p.id) || colourFull(g, p);
}

// All boxes of this round's colour already crossed (before this round's cross)? Then any free box may be crossed.
function colourFull(g, p) {
  const col = roundColour(g, p.id);
  return !!col && p.card.every((c, i) => c !== col || (p.marks[i] && g.placed[p.id] !== i));
}

// Joker: pick (or change) your colour on your own card. Changing it takes back a cross already placed.
function jokerPick(pid, color) {
  const g = G();
  if (g.phase !== "result" || g.result !== "joker" || g.tie) return;
  pushHistory();
  const placed = g.placed[pid];
  if (placed !== undefined) {
    playerById(pid).marks[placed] = false;
    delete g.placed[pid];
  }
  if (color) g.picks[pid] = color;
  else delete g.picks[pid];
  save();
  render();
}

// Tap a box = that player was right. One cross per player per round; tap again to move or remove it.
function tapCell(pid, idx) {
  const g = G();
  const p = playerById(pid);
  if (!canPlace(g, p, idx)) return;
  const prev = g.placed[pid];
  pushHistory();
  if (prev !== undefined) p.marks[prev] = false;
  if (prev === idx) {
    delete g.placed[pid];
  } else {
    p.marks[idx] = true;
    g.placed[pid] = idx;
    if (completedLines(p).length) toast(`🎉 ${p.name} has a line! Tap “Next round” when everyone's crossed`);
  }
  save();
  render();
}

function toggleTieRight(pid) {
  const g = G();
  if (g.phase !== "result" || !g.tie || !g.tie.includes(pid)) return;
  pushHistory();
  if (g.tieRight[pid]) delete g.tieRight[pid];
  else g.tieRight[pid] = true;
  save();
  render();
}

function finishRound() {
  const g = G();
  if (g.phase !== "result") return;
  pushHistory();
  Timer.pause();
  if (g.tie) {
    const right = Object.keys(g.tieRight);
    if (right.length === 1) return declareWinner(right[0]);
    toast(right.length ? "Still tied – next round!" : "Nobody got it – next round!");
    return nextRound();
  }
  const done = g.players.filter(p => completedLines(p).length);
  if (done.length === 1) return declareWinner(done[0].id);
  if (done.length > 1) {
    g.tie = done.map(p => p.id);
    toast(`Tie! ${done.map(p => p.name).join(" & ")} play on – next correct answer wins`);
  }
  nextRound();
}

function nextRound() {
  const g = G();
  g.roundNo++;
  Object.assign(g, { phase: "idle", result: null, double: [], placed: {}, picks: {}, tieRight: {} });
  save();
  render();
}

function declareWinner(id) {
  const g = G();
  g.winner = { id };
  g.phase = "idle";
  state.screen = "win";
  save();
  render();
  sounds.win();
}

function newGameSamePlayers() {
  const g = G();
  state.game = buildGame(g.players.map(p => ({ name: p.name, emoji: p.emoji })), g.side, g.timer, g.jokerEvery);
  state.screen = "game";
  history = [];
  Timer.key = null;
  save();
  closeModal();
  render();
}

function backToSetup() {
  state.screen = "setup";
  state.game = null;
  history = [];
  Timer.key = null;
  save();
  closeModal();
  render();
}

function undo() {
  const g = G();
  if (!history.length || (g && g.phase === "spinning")) return;
  const names = Object.fromEntries(g.players.map(p => [p.id, p.name])); // renames aren't undo steps
  state.game = JSON.parse(history.pop());
  state.game.players.forEach(p => { if (names[p.id]) p.name = names[p.id]; });
  state.screen = state.game.winner ? "win" : "game";
  if (state.game.phase === "idle") Timer.key = null;
  save();
  render();
  toast("↶ Undone");
}

/* ============================================================
   Rendering
   ============================================================ */

function render() {
  $("#setup").hidden = state.screen !== "setup";
  $("#game").hidden = state.screen === "setup";
  $("#win").hidden = state.screen !== "win";
  if (state.screen === "setup") {
    renderSetup();
  } else {
    renderHeader();
    renderSpinner();
    renderStage();
    renderCards();
    keepAwake();
  }
  if (state.screen === "win") renderWin();
  else Confetti.stop();
}

/* ---------- Setup ---------- */

function renderSetup() {
  const s = state.setup;
  const rows = s.players.map((p, i) => `
    <div class="player-row">
      <button class="emoji-btn" data-action="pickEmoji" data-i="${i}" aria-label="Choose emoji">${p.emoji}</button>
      <input class="name-input" data-i="${i}" maxlength="18" placeholder="Player / team ${i + 1}" value="${esc(p.name)}" autocomplete="off">
      <button class="btn ghost icon" data-action="removePlayer" data-i="${i}" aria-label="Remove"
        ${s.players.length <= MIN_PLAYERS ? "disabled" : ""}>✕</button>
    </div>`).join("");

  $("#setup").innerHTML = `
    <div class="setup-card">
      <div class="logo"><span class="logo-ball">🪩</span><h1>Hitster <em>Bingo</em></h1></div>
      <p class="tagline">Spinner, timer &amp; scorecards. The music still comes from your Hitster cards.</p>

      <div class="setup-cols">
      <div class="setup-players">
      <h2>Players / teams <small>${s.players.length} / ${MAX_PLAYERS}</small></h2>
      <div class="player-list">${rows}</div>
      <button class="btn ghost wide" data-action="addPlayer" ${s.players.length >= MAX_PLAYERS ? "disabled" : ""}>＋ Add player</button>
      </div>

      <div class="setup-settings">
      <h2>Starting side</h2>
      <div class="seg-ctrl">
        <button data-action="setupSide" data-side="A" class="${s.side === "A" ? "on" : ""}">A · Easy</button>
        <button data-action="setupSide" data-side="B" class="${s.side === "B" ? "on" : ""}">B · Hard</button>
      </div>

      <h2>Timer</h2>
      <div class="stepper">
        <button class="btn ghost icon" data-action="timerStep" data-d="-5" ${s.timer === 0 ? "disabled" : ""}>−</button>
        <span>${s.timer ? `${s.timer} s` : "Off"}</span>
        <button class="btn ghost icon" data-action="timerStep" data-d="5" ${s.timer >= 90 ? "disabled" : ""}>＋</button>
      </div>

      <h2>Joker</h2>
      <div class="seg-ctrl">
        ${JOKER_OPTIONS.map(n => `<button data-action="setJoker" data-n="${n}" class="${s.jokerEvery === n ? "on" : ""}">${n ? `1 in ${n}` : "Off"}</button>`).join("")}
      </div>

      <button class="btn primary big wide start-btn" data-action="startGame">Start game ▶</button>
      </div>
      </div>
    </div>`;
}

/* ---------- Game ---------- */

function renderHeader() {
  const g = G();
  $("#djChip").innerHTML = `<span class="round">Round ${g.roundNo}</span>`;
  document.querySelectorAll('.side-toggle button').forEach(b => b.classList.toggle("on", b.dataset.side === g.side));
  $("#undoBtn").disabled = !history.length || g.phase === "spinning";
}

function openRules() {
  const g = G();
  const row = (c, color, icon = "") => `<div class="rule-row" style="--c:${color}">
      <span class="chip">${icon}</span><div><b>${esc(c.name)}</b><small>${esc(c.rule)}</small></div></div>`;
  const rows = SIDES[g.side].map(c => row(c, COLORS[c.color]));
  if (g.jokerEvery) rows.push(row({ name: JOKER.name, rule: `${JOKER.rule} (1 in ${g.jokerEvery} spins)` }, JOKER_COLOR, "★"));
  openModal(`
    <div class="modal-title">Side ${g.side} · ${g.side === "A" ? "Easy" : "Hard"}</div>
    <div class="rule-list">${rows.join("")}</div>
    <p class="rule-foot">Correct answer → cross a free box of that colour (all of that colour crossed already? then any free box). First full row, column or diagonal wins.</p>
    <button class="btn primary wide" data-action="closeModal">Got it</button>`);
}

function renderStage() {
  const g = G();
  const stage = $("#stage");
  const tied = g.tie ? g.tie.map(id => { const p = playerById(id); return `${p.emoji} ${esc(p.name)}`; }).join(" vs ") : "";
  const tieNote = g.tie ? `⚔️ Tie-break: ${tied} – first correct answer wins · ` : "";
  let html;
  let showTimer = false;
  let live = false;

  // One slim bar, always the same height: spin hint → "Spinning…" → category + Next round
  if (g.phase === "idle") {
    html = `<div class="st-msg">${tieNote}Tap the disco ball<span class="kbd-hint"> or press <kbd>Space</kbd></span> to spin</div>`;
  } else if (g.phase === "spinning") {
    html = `<div class="st-msg spin-txt">Spinning…</div>`;
  } else {
    live = true;
    const joker = g.result === "joker";
    const c = joker ? JOKER : catFor(g.result, g.side);
    stage.style.setProperty("--c", joker ? JOKER_COLOR : COLORS[g.result]);
    const sub = g.tie
      ? `<small>⚔️ ${tied} – tap the card of whoever got it right</small>`
      : c.draw
        ? `<div class="rb-double">${g.double.map(id => {
            const d = catById(id);
            return `<span style="--c:${COLORS[d.color]}"><i></i>${esc(d.name)}</span>`;
          }).join(`<b>+</b>`)}</div>`
        : `<small>${esc(joker ? "Before the song: tap a box on your card to pick that colour – right? Cross a box of it" : c.rule)}</small>`;
    const lineDone = !g.tie && g.players.some(p => completedLines(p).length);
    showTimer = g.timer > 0 || introSecondsFor(g) > 0;
    html = `
      <span class="rb-chip">${joker ? "★" : ""}</span>
      <div class="rb-text"><b>${esc(c.name)}</b>${sub}</div>
      ${showTimer ? `<div id="timerSlot"></div>` : ""}
      <button class="btn ${lineDone ? "primary" : "ghost"}" data-action="finishRound">
        ${lineDone ? "🏆 Finish round" : "Next round ▶"}</button>`;
  }

  stage.classList.toggle("live", live);
  stage.innerHTML = html;

  if (showTimer) {
    Timer.prepare(g.roundNo, g.timer, introSecondsFor(g));
    stage.querySelector("#timerSlot").replaceWith(Timer.el);
  } else {
    Timer.pause();
  }
}

function gridHTML(p, { canTap = null, tapAction = "tapCell", placedIdx, winLines = [], edit = false } = {}) {
  const winSet = new Set(winLines.flat());
  const choose = tapAction === "jokerPickCell";
  const cells = p.card.map((col, i) => {
    const marked = p.marks[i];
    const can = canTap && canTap(i);
    const cls = ["cell", marked && "x", can && (choose ? "choose" : "pick"), placedIdx === i && "new", canTap && !can && !choose && "dim",
      winSet.has(i) && "hl", edit && "editable"].filter(Boolean).join(" ");
    if (edit) return `<button class="${cls}" style="--c:${COLORS[col]}" data-action="editCell" data-idx="${i}" aria-label="Edit box"></button>`;
    return can
      ? `<button class="${cls}" style="--c:${COLORS[col]}" data-action="${tapAction}" data-id="${p.id}" data-idx="${i}"
          aria-label="${choose ? "Pick this colour" : "Cross this box"}"></button>`
      : `<div class="${cls}" style="--c:${COLORS[col]}"></div>`;
  }).join("");
  return `<div class="grid">${cells}</div>`;
}

function renderCards() {
  const g = G();
  const scoring = g.phase === "result" && !g.tie;
  const tieRound = g.phase === "result" && g.tie;
  $("#cards").dataset.n = g.players.length;
  const joker = scoring && g.result === "joker";
  $("#cards").innerHTML = g.players.map(p => {
    const count = p.marks.filter(Boolean).length;
    const out = g.tie && !g.tie.includes(p.id);
    const pick = joker && g.picks[p.id];
    const cls = ["mini", out && "out", g.tie && !out && "tied",
      tieRound && g.tieRight[p.id] && "right", scoring && g.placed[p.id] !== undefined && "scored"].filter(Boolean).join(" ");
    // while scoring, only the header opens the big view so taps on boxes don't
    const cardAction = tieRound ? (out ? "" : "tieRight") : scoring ? "" : "enlarge";
    // Joker: the card stays fully visible – until a colour is picked, tapping any free box picks its colour
    const choosing = joker && !pick;
    const pickChip = pick
      ? `<button class="badge pick-chip" style="--c:${COLORS[pick]}" data-action="jokerPick" data-id="${p.id}"
          title="Change colour">★ ${esc(catFor(pick, g.side).name)}</button>`
      : choosing ? `<span class="badge any">★ tap a colour</span>` : "";
    return `<div class="${cls}" ${cardAction ? `data-action="${cardAction}" role="button"` : ""} data-id="${p.id}">
      <div class="mini-head" ${scoring ? `data-action="enlarge" data-id="${p.id}"` : ""}>
        <span class="em">${p.emoji}</span><span class="nm">${esc(p.name)}</span>
        ${pickChip}${tieRound && g.tieRight[p.id] ? `<span class="badge ok">✓ right</span>` : ""}${scoring && colourFull(g, p) ? `<span class="badge any">colour full – any box</span>` : ""}
        <span class="count">${count}</span></div>
      ${gridHTML(p, {
        canTap: choosing ? idx => !p.marks[idx] : scoring ? idx => canPlace(g, p, idx) : null,
        tapAction: choosing ? "jokerPickCell" : "tapCell",
        placedIdx: g.phase === "result" ? g.placed[p.id] : undefined,
        winLines: completedLines(p)
      })}
    </div>`;
  }).join("");
}

// Card editor state: which player, crosses vs colours, and the paint colour
let editor = null;

function enlarge(id) {
  editor = null;
  const p = playerById(id);
  const g = G();
  const legend = SIDES[g.side].map(c =>
    `<span class="mini-leg" style="--c:${COLORS[c.color]}"><span class="chip"></span>${esc(c.name)}</span>`).join("");
  openModal(`
    <div class="modal-title">${p.emoji} ${esc(p.name)}</div>
    <div class="big-card">${gridHTML(p, { winLines: completedLines(p) })}</div>
    <div class="mini-legend">${legend}</div>
    <div class="modal-actions">
      <button class="btn ghost" data-action="editCard" data-id="${p.id}">✏️ Edit card</button>
      <button class="btn primary" data-action="closeModal">Close</button>
    </div>`);
}

function renderEditor() {
  const p = playerById(editor.id);
  const counts = COLOR_ORDER.map(col => p.card.filter(c => c === col).length);
  const tabs = `<div class="seg-ctrl">
      <button data-action="editMode" data-mode="marks" class="${editor.mode === "marks" ? "on" : ""}">✕ Crosses</button>
      <button data-action="editMode" data-mode="colors" class="${editor.mode === "colors" ? "on" : ""}">🎨 Colours</button>
    </div>`;
  const help = editor.mode === "marks"
    ? `<p class="edit-help">Tap a box to add or remove a cross.</p>`
    : `<div class="paint-row">${COLOR_ORDER.map((col, i) => `
        <button class="paint ${editor.color === col ? "on" : ""} ${counts[i] !== 5 ? "warn" : ""}" style="--c:${COLORS[col]}"
          data-action="editPaint" data-color="${col}">${counts[i]}</button>`).join("")}</div>
      <p class="edit-help">Pick a colour, then tap boxes to repaint them. Numbers = boxes per colour (normally 5).</p>`;
  openModal(`
    <div class="modal-title">Edit card</div>
    <div class="edit-name">
      <span class="em">${p.emoji}</span>
      <input class="name-input" id="editName" maxlength="18" value="${esc(p.name)}" autocomplete="off" aria-label="Name">
    </div>
    ${tabs}
    ${help}
    <div class="big-card">${gridHTML(p, { winLines: completedLines(p), edit: true })}</div>
    <div class="modal-actions">
      <button class="btn ghost" data-action="editReroll">🎲 New random card</button>
      <button class="btn primary" data-action="editDone">Done</button>
    </div>`);
}

function editCell(idx) {
  const p = playerById(editor.id);
  const hadLine = completedLines(p).length > 0;
  pushHistory();
  if (editor.mode === "marks") p.marks[idx] = !p.marks[idx];
  else if (p.card[idx] !== editor.color) p.card[idx] = editor.color;
  else { history.pop(); return; }
  save();
  renderEditor();
  render();
  if (!hadLine && completedLines(p).length) toast(`${p.name} now has a full line – it's checked when this round is scored`);
}

function openMenu() {
  openModal(`
    <div class="modal-title">Menu</div>
    <button class="btn ghost wide" data-action="toggleTimer">⏱ Timer: ${G().timer ? `on (${G().timer} s) – turn off` : "off – turn on"}</button>
    <button class="btn ghost wide" data-action="newGame">🔄 New game – same players, new cards</button>
    <button class="btn ghost wide" data-action="toSetup">⚙️ Back to setup</button>
    <button class="btn primary wide" data-action="closeModal">Close</button>`);
}

/* ---------- Win ---------- */

function renderWin() {
  const g = G();
  const p = playerById(g.winner.id);
  $("#winBox").innerHTML = `
    <div class="win-banner">HITSTER!</div>
    <div class="win-name">${p.emoji} ${esc(p.name)} wins!</div>
    <div class="big-card">${gridHTML(p, { winLines: completedLines(p) })}</div>
    <div class="win-actions">
      <button class="btn primary big" data-action="newGame">🔄 New game (same players)</button>
      <button class="btn ghost" data-action="toSetup">⚙️ Back to setup</button>
      <button class="btn ghost" data-action="undo">↶ Undo</button>
    </div>`;
  Confetti.start();
}

const Confetti = {
  raf: 0,
  parts: [],
  start() {
    if (this.raf) return;
    const cv = $("#confetti");
    const ctx = cv.getContext("2d");
    const resize = () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; };
    resize();
    this.onResize = resize;
    addEventListener("resize", resize);
    const cols = Object.values(COLORS).concat(["#ffffff"]);
    const spawn = (initial) => ({
      x: Math.random() * cv.width,
      y: initial ? -Math.random() * cv.height : -20,
      vx: (Math.random() - 0.5) * 2 * devicePixelRatio,
      vy: (2 + Math.random() * 3) * devicePixelRatio,
      s: (6 + Math.random() * 8) * devicePixelRatio,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.2,
      c: cols[Math.floor(Math.random() * cols.length)]
    });
    this.parts = Array.from({ length: 160 }, () => spawn(true));
    const loop = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      this.parts.forEach((q, i) => {
        q.x += q.vx; q.y += q.vy; q.r += q.vr;
        if (q.y > cv.height + 20) this.parts[i] = spawn(false);
        ctx.save();
        ctx.translate(q.x, q.y);
        ctx.rotate(q.r);
        ctx.fillStyle = q.c;
        ctx.fillRect(-q.s / 2, -q.s / 4, q.s, q.s / 2);
        ctx.restore();
      });
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  },
  stop() {
    if (!this.raf) return;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    removeEventListener("resize", this.onResize);
  }
};

/* ============================================================
   Actions + events
   ============================================================ */

const actions = {
  // setup
  addPlayer() {
    const s = state.setup;
    if (s.players.length >= MAX_PLAYERS) return;
    const used = new Set(s.players.map(p => p.emoji));
    s.players.push({ name: "", emoji: EMOJIS.find(e => !used.has(e)) || "🎵" });
    save();
    render();
    const inputs = document.querySelectorAll(".name-input");
    inputs[inputs.length - 1].focus();
  },
  removePlayer({ i }) {
    if (state.setup.players.length <= MIN_PLAYERS) return;
    state.setup.players.splice(+i, 1);
    save();
    render();
  },
  pickEmoji({ i }) {
    openModal(`<div class="modal-title">Pick an emoji</div>
      <div class="emoji-grid">${EMOJIS.map(e => `<button data-action="setEmoji" data-i="${i}" data-e="${e}">${e}</button>`).join("")}</div>`);
  },
  setEmoji({ i, e }) {
    state.setup.players[+i].emoji = e;
    save();
    closeModal();
    render();
  },
  setupSide({ side }) { state.setup.side = side; save(); render(); },
  timerStep({ d }) {
    // 0 = off; below 10 s snaps to off
    const t = state.setup.timer + +d;
    state.setup.timer = t < 10 ? (d < 0 ? 0 : 10) : Math.min(90, t);
    save();
    render();
  },
  setJoker({ n }) { state.setup.jokerEvery = +n; save(); render(); },
  startGame() {
    const s = state.setup;
    const players = s.players.map((p, i) => ({ name: p.name.trim() || `Player ${i + 1}`, emoji: p.emoji }));
    state.game = buildGame(players, s.side, s.timer, s.jokerEvery);
    state.screen = "game";
    history = [];
    Timer.key = null;
    save();
    render();
  },

  // game
  side({ side }) {
    const g = G();
    if (g.side === side) return;
    g.side = side;
    save();
    render();
  },
  undo,
  menu: openMenu,
  closeModal,
  newGame: newGameSamePlayers,
  toSetup() {
    if (state.screen === "game" && !confirm("Leave this game and go back to setup?")) return;
    backToSetup();
  },
  jokerPick({ id, color }) { jokerPick(id, color); },
  jokerPickCell({ id, idx }) { jokerPick(id, playerById(id).card[+idx]); },
  toggleTimer() {
    const g = G();
    g.timer = g.timer ? 0 : state.setup.timer || 25;
    Timer.key = null;
    save();
    closeModal();
    render();
    toast(g.timer ? `⏱ Timer on (${g.timer} s)` : "⏱ Timer off");
  },
  // only a click on the ball or its chrome rim spins – not the empty corners around it
  spin(_, el, e) {
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(dx, dy) > (r.width / 2) * 1.18) return;
    spin();
  },
  tapCell({ id, idx }) { tapCell(id, +idx); },
  tieRight({ id }) { toggleTieRight(id); },
  finishRound,
  enlarge({ id }) { enlarge(id); },
  rules: openRules,
  editCard({ id }) {
    editor = { id, mode: "marks", color: COLOR_ORDER[0] };
    renderEditor();
  },
  editMode({ mode }) { editor.mode = mode; renderEditor(); },
  editPaint({ color }) { editor.color = color; renderEditor(); },
  editCell({ idx }) { editCell(+idx); },
  editReroll() {
    const p = playerById(editor.id);
    if (p.marks.some(Boolean) && !confirm(`Give ${p.name} a new random card? Their crosses will be cleared.`)) return;
    pushHistory();
    p.card = makeCard();
    p.marks = Array(25).fill(false);
    save();
    renderEditor();
    render();
  },
  editDone() {
    const id = editor.id;
    editor = null;
    enlarge(id);
  },
  timerToggle() { Timer.toggle(); },
  timerReset() { Timer.reset(); }
};

document.addEventListener("click", e => {
  ensureAudio();
  keepAwake();
  if (e.target.id === "modal") return closeModal();
  const el = e.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset, el, e);
});

document.addEventListener("input", e => {
  if (!e.target.classList.contains("name-input")) return;
  if (e.target.id === "editName") {
    playerById(editor.id).name = e.target.value.trim() || playerById(editor.id).name;
    save();
    renderHeader();
    renderCards();
    return;
  }
  state.setup.players[+e.target.dataset.i].name = e.target.value;
  save();
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#modal").hidden) closeModal();
  // Space = tap the disco ball (ends the current round first, like tapping it)
  if (e.code === "Space" && state.screen === "game" && $("#modal").hidden && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
    e.preventDefault(); // also stops a focused button from being "clicked" again
    if (e.repeat) return;
    ensureAudio();
    spin();
  }
  if (e.key === "Enter" && e.target.classList.contains("name-input")) e.target.blur();
});

/* ============================================================
   Boot
   ============================================================ */

load();
Timer.build();
if (state.game && state.game.phase !== "idle") {
  // reloaded mid-spin (or a save from an older version): land on the stored result
  Object.assign(state.game, { phase: state.game.result ? "result" : "idle", placed: state.game.placed || {}, picks: state.game.picks || {}, tieRight: state.game.tieRight || {} });
  save();
}
if (state.screen !== "setup" && !state.game) state.screen = "setup";
if (state.game) setBallRotation(false);
render();
