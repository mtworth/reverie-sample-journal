// Ways of seeing the library (2026-11-12): notes for each entry (parsed in the browser), the
// map's layouts, cards with notation, and the faint waveforms on journal lines.
// Everything here runs client-side; the small "sounds alike" model loads only when asked for.

window.Views = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const esc = (t) =>
    String(t ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // ---------- notes ----------

  const notesCache = new Map();
  function entryNotes(id) {
    if (!notesCache.has(id)) {
      notesCache.set(
        id,
        fetch(`/api/entries/${id}/midi`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((buf) => (buf ? parseMidi(buf) : null))
          .catch(() => null),
      );
    }
    return notesCache.get(id);
  }

  // [[pitch, onset_s, duration_s, velocity]], sustain pedal folded into durations (as heard).
  function parseMidi(buf) {
    const MidiCls = window.Midi?.Midi || window.Midi;
    const midi = new MidiCls(buf);
    const out = [];
    for (const tr of midi.tracks) {
      const ccs = (tr.controlChanges[64] || []).slice().sort((a, b) => a.time - b.time);
      const downs = [];
      let down = null;
      for (const c of ccs) {
        if (c.value >= 0.5 && down === null) down = c.time;
        else if (c.value < 0.5 && down !== null) {
          downs.push([down, c.time]);
          down = null;
        }
      }
      if (down !== null) downs.push([down, midi.duration]);
      for (const n of tr.notes) {
        let end = n.time + n.duration;
        for (const [a, b] of downs) if (a <= end && end < b) end = Math.max(end, b);
        out.push([n.midi, n.time, end - n.time, Math.round(n.velocity * 127)]);
      }
    }
    return out.sort((a, b) => a[1] - b[1]);
  }

  function slice(notes, start, end) {
    return notes.filter((n) => n[1] >= start && n[1] < end).map((n) => [n[0], n[1] - start, n[2], n[3]]);
  }

  // Facts for every idea, from its first occurrence.
  const ideaCache = new Map();
  async function ideaNotes(motif) {
    const o = motif.occurrences[0];
    const key = `${o.entry_id}:${o.start}:${o.end}`;
    if (!ideaCache.has(key)) {
      ideaCache.set(
        key,
        entryNotes(o.entry_id).then((all) => (all ? slice(all, o.start, o.end) : null)),
      );
    }
    return ideaCache.get(key);
  }

  // ---------- the small "sounds alike" model, loaded on demand ----------

  let studentPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
  }
  function student() {
    if (!studentPromise) {
      studentPromise = (async () => {
        if (!window.ort) await loadScript("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js");
        ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
        if (!window.Student) await loadScript("static/student.js");
        return Student.load({ url: "static/models/student.onnx", ep: "wasm" });
      })();
    }
    return studentPromise;
  }
  // One run at a time: ONNX Runtime Web can't run a session concurrently (overlapping runs hang).
  const vecCache = new Map();
  let queue = Promise.resolve();
  function fingerprint(motifId, notes) {
    if (!vecCache.has(motifId)) {
      const job = queue.then(() => student()).then((s) => s.embed(notes.slice(0, 256)));
      queue = job.catch(() => {});
      vecCache.set(motifId, job);
    }
    return vecCache.get(motifId);
  }

  // 2-D map from fingerprints: classical MDS on cosine distances (only nearness means anything).
  function mds(vecs) {
    const n = vecs.length;
    const unit = vecs.map((v) => {
      const len = Math.hypot(...v) || 1;
      return v.map((x) => x / len);
    });
    const D2 = unit.map((a) => unit.map((b) => 2 - 2 * a.reduce((s, x, k) => s + x * b[k], 0)));
    const rowMean = D2.map((r) => r.reduce((s, x) => s + x, 0) / n);
    const all = rowMean.reduce((s, x) => s + x, 0) / n;
    let B = D2.map((r, i) => r.map((x, j) => -0.5 * (x - rowMean[i] - rowMean[j] + all)));
    const coords = [];
    for (let k = 0; k < 2; k++) {
      let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1 + k));
      let lambda = 0;
      for (let it = 0; it < 200; it++) {
        const w = B.map((r) => r.reduce((s, x, j) => s + x * v[j], 0));
        lambda = Math.hypot(...w);
        v = w.map((x) => x / (lambda || 1));
      }
      coords.push(v.map((x) => x * Math.sqrt(Math.max(lambda, 0))));
      B = B.map((r, i) => r.map((x, j) => x - lambda * v[i] * v[j])); // deflate
    }
    return vecs.map((_, i) => [coords[0][i], coords[1][i]]);
  }

  // ---------- map ----------

  const FIFTHS = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];
  const ENHARM = { "C#": "Db", "D#": "Eb", "G#": "Ab", "A#": "Bb", Gb: "F#" };
  const REL_MINOR = { C: "Am", G: "Em", D: "Bm", A: "F#m", E: "C#m", B: "G#m", "F#": "D#m", Db: "Bbm", Ab: "Fm", Eb: "Cm", Bb: "Gm", F: "Dm" };
  const PC = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  function wheelPos(keyName) {
    if (!keyName) return null;
    const [t, mode] = keyName.split(" ");
    const tonic = ENHARM[t] || t;
    if (!PC.includes(tonic)) return null;
    const minor = mode === "minor";
    const major = minor ? PC[(PC.indexOf(tonic) + 3) % 12] : tonic;
    return { minor, slot: FIFTHS.indexOf(major) };
  }

  const LAYOUTS = [
    ["wheel", "key wheel"],
    ["energy", "energy & register"],
    ["time", "timeline"],
    ["mood", "pace & mood"],
    ["alike", "sounds alike"],
  ];
  const AXES = {
    energy: { x: ["energy", "calm", "busy"], y: ["centre", "low", "high"] },
    time: { x: ["when", null, null], y: ["energy", "calm", "busy"] },
    mood: { x: ["eventsPerSec", "slow", "quick"], y: ["tension", "smooth", "tense"] },
  };
  const COLOURS = { minor: "#7d9bb8", major: "#c98a6c", none: "#cfc7ba" };
  const lastPos = new Map(); // id -> {x, y}, so switching layouts glides

  function hash(s) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return h;
  }
  const jitter = (id, amt) => {
    const h = hash(id);
    return [((h & 255) / 255 - 0.5) * amt, (((h >> 8) & 255) / 255 - 0.5) * amt];
  };

  function layoutWheel(items) {
    const cells = {};
    const ks = items.map((i) => {
      const k = wheelPos(i.facts?.key?.r >= 0.6 ? i.facts.key.name : null);
      const cell = k ? `${k.slot}-${k.minor}` : "none";
      (cells[cell] ||= []).push(i.id);
      return { k, cell };
    });
    return items.map((i, n) => {
      const { k, cell } = ks[n];
      const members = cells[cell];
      const j = members.indexOf(i.id);
      if (!k) {
        const a = (2 * Math.PI * j) / Math.max(members.length, 1);
        return { x: 50 + 5 * Math.cos(a), y: 50 + 5 * Math.sin(a), hollow: true };
      }
      const row = Math.floor(j / 4), col = j % 4, perRow = Math.min(4, members.length - row * 4);
      const r = (k.minor ? 27 : 40) + (k.minor ? -row : row) * 3.6;
      const ang = ((k.slot * 30 + (col - (perRow - 1) / 2) * 6) * Math.PI) / 180;
      return { x: 50 + r * Math.sin(ang), y: 50 - r * Math.cos(ang), hollow: false };
    });
  }

  function layoutAxes(items, which) {
    const ax = AXES[which];
    const get = (i, key) => (key === "when" ? +new Date(i.first) : i.facts && !i.facts.tooFew ? i.facts[key] : null);
    const range = (key) => {
      const v = items.map((i) => get(i, key)).filter((x) => x != null).sort((a, b) => a - b);
      const q = (f) => v[Math.min(v.length - 1, Math.max(0, Math.round(f * (v.length - 1))))];
      return v.length > 8 ? [q(0.05), q(0.95)] : [v[0], v[v.length - 1]];
    };
    const clamp = (t) => Math.max(-0.03, Math.min(1.03, t));
    const [x0, x1] = range(ax.x[0]), [y0, y1] = range(ax.y[0]);
    return items.map((i) => {
      const xv = get(i, ax.x[0]), yv = get(i, ax.y[0]);
      const [jx, jy] = jitter(i.id, 2.4);
      if (xv == null || yv == null) return { x: 97 + jx / 3, y: 97 + jy / 3, hollow: true };
      return { x: 14 + 80 * clamp((xv - x0) / (x1 - x0 || 1)) + jx, y: 90 - 82 * clamp((yv - y0) / (y1 - y0 || 1)) + jy, hollow: false };
    });
  }

  async function layoutAlike(items, status) {
    const usable = [];
    for (const i of items) if (i.notes && i.notes.length >= 4) usable.push(i);
    status("listening to each idea…");
    const vecs = await Promise.all(usable.map((i) => fingerprint(i.id, i.notes)));
    const xy = mds(vecs.map((v) => Array.from(v)));
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const [ax, bx, ay, by] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const at = new Map(usable.map((i, n) => [i.id, { x: 8 + 84 * ((xy[n][0] - ax) / (bx - ax || 1)), y: 8 + 84 * ((xy[n][1] - ay) / (by - ay || 1)), hollow: false }]));
    let k = 0;
    status("");
    return items.map((i) => at.get(i.id) || { x: 90 + (k % 4) * 2.5, y: 100 + Math.floor(k++ / 4) * 2.5, hollow: true });
  }

  function el(tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }

  function guides(g, layout, items) {
    if (layout === "wheel") {
      for (const r of [46, 33.5, 21]) g.append(el("circle", { cx: 50, cy: 50, r, class: "rv-map-guide" }));
      FIFTHS.forEach((maj, n) => {
        const a = (n * 30 * Math.PI) / 180;
        g.append(el("text", { x: 50 + 50 * Math.sin(a), y: 51 - 50 * Math.cos(a), class: "rv-map-label" }, maj));
        g.append(el("text", { x: 50 + 15.5 * Math.sin(a), y: 51 - 15.5 * Math.cos(a), class: "rv-map-label small" }, REL_MINOR[maj]));
      });
      return;
    }
    if (layout === "alike") {
      g.append(el("text", { x: 50, y: 104, class: "rv-map-label small" }, "close together = sounds alike"));
      return;
    }
    const ax = AXES[layout];
    const when = (f) => {
      const v = items.map((i) => +new Date(i.first)).filter(Boolean);
      return new Date(f(...v)).toLocaleDateString([], { day: "numeric", month: "short" });
    };
    const [xl, xh] = ax.x[0] === "when" ? [when(Math.min), when(Math.max)] : [ax.x[1], ax.x[2]];
    g.append(el("line", { x1: 10, y1: 96, x2: 98, y2: 96, class: "rv-map-axis" }));
    g.append(el("line", { x1: 10, y1: 4, x2: 10, y2: 96, class: "rv-map-axis" }));
    g.append(el("text", { x: 11, y: 100, class: "rv-map-label small", "text-anchor": "start" }, xl));
    g.append(el("text", { x: 98, y: 100, class: "rv-map-label small", "text-anchor": "end" }, xh));
    g.append(el("text", { x: 8.5, y: 94, class: "rv-map-label small", "text-anchor": "end" }, ax.y[1]));
    g.append(el("text", { x: 8.5, y: 6, class: "rv-map-label small", "text-anchor": "end" }, ax.y[2]));
  }

  async function drawMap(container, items, layout, { onPlay, status = () => {} }) {
    container.innerHTML = "";
    const svg = el("svg", { viewBox: "-6 -4 112 112", class: "rv-map" });
    const g = el("g", {});
    svg.append(g);
    container.append(svg);
    const tip = document.createElement("div");
    tip.className = "rv-map-tip hidden";
    container.append(tip);
    let pinned = null; // the dot last clicked keeps its card open, with a link to its entry
    const showTip = (i, c) => {
      tip.innerHTML = `<b>${esc(i.name)}</b>${i.line ? `<br>${esc(i.line)}` : ""}${pinned === i.id ? `<br><a href="#idea/${i.id}">open →</a>` : ""}`;
      tip.classList.remove("hidden");
      tip.classList.toggle("pinned", pinned === i.id);
      const box = container.getBoundingClientRect(), dot = c.getBoundingClientRect();
      tip.style.left = `${Math.min(box.width - 260, Math.max(0, dot.left - box.left - 20))}px`;
      tip.style.top = `${dot.bottom - box.top + 8}px`;
    };
    svg.addEventListener("click", (ev) => {
      if (ev.target.classList.contains("rv-map-dot")) return;
      pinned = null;
      tip.classList.add("hidden");
    });
    guides(g, layout, items);

    let target;
    if (layout === "wheel") target = layoutWheel(items);
    else if (layout === "alike") {
      try {
        target = await layoutAlike(items, status);
      } catch (err) {
        console.error(err);
        status("the sounds-alike model couldn't load");
        target = layoutWheel(items);
      }
    } else target = layoutAxes(items, layout);
    if (!container.isConnected) return;

    const dots = items.map((i, n) => {
      const mode = i.facts?.key?.r >= 0.6 ? i.facts.key.mode : null;
      const colour = COLOURS[mode || "none"];
      const r = 1.3 + Math.min(4, i.count - 1) * 0.45;
      const c = el("circle", { r, class: "rv-map-dot" + (target[n].hollow ? " hollow" : ""), fill: target[n].hollow ? "none" : colour, stroke: colour });
      c.dataset.id = i.id;
      c.addEventListener("mouseenter", () => {
        if (!pinned) showTip(i, c);
      });
      c.addEventListener("mouseleave", () => {
        if (!pinned) tip.classList.add("hidden");
      });
      c.addEventListener("click", () => {
        pinned = i.id;
        showTip(i, c);
        onPlay(i.id);
      });
      g.append(c);
      return c;
    });

    // Glide from where each dot was in the previous layout.
    const from = items.map((i, n) => lastPos.get(i.id) || target[n]);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      dots.forEach((d, n) => {
        const x = from[n].x + (target[n].x - from[n].x) * e, y = from[n].y + (target[n].y - from[n].y) * e;
        d.setAttribute("cx", x.toFixed(2));
        d.setAttribute("cy", y.toFixed(2));
        if (k === 1) lastPos.set(items[n].id, { x, y });
      });
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- waveforms ----------

  const peaksCache = new Map();
  function peaks(id, n) {
    const key = `${id}:${n}`;
    if (!peaksCache.has(key)) peaksCache.set(key, fetch(`/api/entries/${id}/peaks?n=${n}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    return peaksCache.get(key);
  }
  async function drawWave(canvas, id, progress = -1) {
    const w = Math.max(120, Math.round(canvas.clientWidth || 400));
    const n = Math.max(40, Math.round(w / 5));
    const p = await peaks(id, n);
    if (!p || !canvas.isConnected) return;
    canvas.width = w * 2;
    canvas.height = 36;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const step = canvas.width / p.length;
    for (let i = 0; i < p.length; i++) {
      const amp = Math.max(0.05, Math.sqrt(p[i]));
      const h = amp * canvas.height * 0.9;
      ctx.fillStyle = progress >= 0 && i / p.length < progress ? "#a49b8c" : "#e4ded2";
      ctx.fillRect(i * step, (canvas.height - h) / 2, Math.max(1.5, step * 0.5), h);
    }
  }

  // ---------- piano roll: the notes themselves, no guessing ----------
  // Time across, pitch up. The melody (smallest-leap voice above G3, as in facts.js) is dark;
  // everything else is light. Notes are drawn short (onsets, not pedal smear), louder = bolder.
  function drawRoll(container, notes, { height = 120 } = {}) {
    container.innerHTML = "";
    if (!notes || !notes.length) return;
    const ns = [...notes].sort((a, b) => a[1] - b[1] || b[0] - a[0]);
    // Melody: per onset group (60ms), the note above G3 nearest the previous melody note.
    const melody = new Set();
    let prev = null;
    for (let i = 0; i < ns.length; ) {
      let j = i;
      while (j < ns.length && ns[j][1] - ns[i][1] <= 0.06) j++;
      const upper = ns.slice(i, j).filter((n) => n[0] >= 55);
      if (upper.length) {
        const pick = prev === null ? upper.reduce((a, b) => (b[0] > a[0] ? b : a)) : upper.reduce((a, b) => (Math.abs(b[0] - prev) < Math.abs(a[0] - prev) ? b : a));
        melody.add(pick);
        prev = pick[0];
      }
      i = j;
    }
    const pitches = ns.map((n) => n[0]).sort((a, b) => a - b);
    const q = (f) => pitches[Math.min(pitches.length - 1, Math.floor(f * pitches.length))];
    const lo = Math.min(q(0.03), q(0.5) - 6) - 2, hi = Math.max(q(0.97), q(0.5) + 6) + 2;
    const span = Math.max(1, ns[ns.length - 1][1] + 0.4);
    const W = 600, H = height, row = H / (hi - lo + 1);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "rv-roll", preserveAspectRatio: "none" });
    svg.style.height = `${H}px`;
    for (let p = Math.ceil(lo / 12) * 12; p <= hi; p += 12) {
      svg.append(el("line", { x1: 0, x2: W, y1: H - (p - lo) * row, y2: H - (p - lo) * row, class: "rv-roll-c" }));
    }
    for (const n of ns) {
      const [p, t, d, v] = n;
      if (p < lo || p > hi) continue;
      const x = (t / span) * W, w = Math.max(5, (Math.min(d, 0.35) / span) * W);
      svg.append(el("rect", {
        x: x.toFixed(1), y: (H - (p - lo + 1) * row + 0.4).toFixed(1), width: w.toFixed(1), height: Math.max(2.5, row - 0.8).toFixed(1), rx: 1.2,
        class: melody.has(n) ? "rv-roll-note melody" : "rv-roll-note", "fill-opacity": (0.45 + 0.55 * (v / 127)).toFixed(2),
      }));
    }
    container.append(svg);
  }

  return { entryNotes, ideaNotes, slice, drawMap, drawWave, drawRoll, LAYOUTS };
})();
