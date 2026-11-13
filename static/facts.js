// Musical facts from a plain note list, and the one-line description written from them
// (2026-11-12). The client-side replacement for the LLM's summary (ux.md): code works out the
// facts; a sentence template turns them into words. No model, no download.
//
//   const f = Facts.of(notes);   // notes: [[pitch, onset_s, duration_s, velocity], ...]
//   Facts.describe(f)            // "a slow line that falls, in D minor, low and soft"
//   Facts.defaultName(f)         // "D minor line"
//
// Definitions follow the hand-built feature map (scripts/experiments/feature_map.py): onsets
// within 60ms are one event; the melody is the smallest-leap voice above G3 (app/phrases.py).

window.Facts = (() => {
  const GROUP_S = 0.06;
  const MELODY_FLOOR = 55; // G3
  const MAJOR_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const MINOR_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];
  const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  // Krumhansl–Kessler key profiles.
  const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const pct = (a, q) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
  };
  function corr(a, b) {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db || 1);
  }

  function key(ns) {
    const prof = new Array(12).fill(0);
    for (const n of ns) prof[n.p % 12] += Math.min(n.d, 2) * (0.5 + n.v / 254);
    const scores = [];
    for (let t = 0; t < 12; t++) {
      const rot = (k) => prof.map((_, i) => k[(i - t + 12) % 12]);
      scores.push({ tonic: t, mode: "major", r: corr(prof, rot(KK_MAJOR)) });
      scores.push({ tonic: t, mode: "minor", r: corr(prof, rot(KK_MINOR)) });
    }
    scores.sort((a, b) => b.r - a.r);
    const best = scores[0];
    const used = prof.filter((x) => x > 0.03 * prof.reduce((s, y) => s + y, 0)).length;
    if (best.r < 0.55 || used < 3) return { name: null, r: best.r };
    const name = (best.mode === "major" ? MAJOR_NAMES : MINOR_NAMES)[best.tonic];
    return { name: `${name} ${best.mode}`, tonic: name, mode: best.mode, r: best.r };
  }

  function of(notes) {
    const ns = notes
      .map((n) => ({ p: Math.round(n[0]), t: n[1], d: Math.max(0.02, n[2]), v: n[3] }))
      .sort((a, b) => a.t - b.t || a.p - b.p);
    if (ns.length < 3) return { tooFew: true, nNotes: ns.length };
    const start = ns[0].t;
    const end = Math.max(...ns.map((n) => n.t + n.d));
    const span = Math.max(1, ns[ns.length - 1].t - start);

    const groups = [];
    for (const n of ns) {
      const g = groups[groups.length - 1];
      if (g && n.t - g[0].t <= GROUP_S) g.push(n);
      else groups.push([n]);
    }

    // Melody: smallest-leap voice above G3, repeated pitches merged.
    const mel = [];
    for (const g of groups) {
      const upper = g.filter((n) => n.p >= MELODY_FLOOR).map((n) => n.p);
      if (!upper.length) continue;
      const prev = mel.length ? mel[mel.length - 1] : null;
      const p = prev === null ? Math.max(...upper) : upper.sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev) || b - a)[0];
      if (p !== prev) mel.push(p);
    }
    const leaps = mel.slice(1).map((p, i) => Math.abs(p - mel[i]));

    // Contour of the melody (or of the top notes when there's no melody above G3).
    const line = mel.length >= 4 ? mel : groups.map((g) => Math.max(...g.map((n) => n.p)));
    const third = Math.max(1, Math.floor(line.length / 3));
    const a = mean(line.slice(0, third)), b = mean(line.slice(third, line.length - third)), c = mean(line.slice(-third));
    let contour = "circling";
    if (b - Math.max(a, c) >= 3) contour = "arching";
    else if (Math.min(a, c) - b >= 3) contour = "dipping";
    else if (c - a >= 3) contour = "rising";
    else if (a - c >= 3) contour = "falling";

    // Texture.
    const chordal = groups.filter((g) => g.length >= 3).length / groups.length;
    const single = groups.filter((g) => g.length === 1).length / groups.length;
    let texture = "figure";
    if (chordal >= 0.45) texture = "chords";
    else if (single >= 0.7 && mean(leaps) >= 4 && overlap(ns) >= 1.6) texture = "arpeggios";
    else if (single >= 0.7) texture = "line";
    else if (chordal >= 0.15) texture = "melody over chords";

    // A repeated low note (pedal / ostinato): one pitch class is most of the bass.
    const bass = groups.map((g) => Math.min(...g.map((n) => n.p)));
    const lowBass = bass.filter((p) => p < 60);
    let pedal = null;
    if (lowBass.length >= 4) {
      const counts = new Array(12).fill(0);
      lowBass.forEach((p) => counts[p % 12]++);
      const top = counts.indexOf(Math.max(...counts));
      if (counts[top] / lowBass.length >= 0.55) pedal = top; // spelled once the key is known
    }

    // Register, pace, loudness.
    const weighted = [];
    for (const n of ns) for (let k = 0; k < Math.max(1, Math.round(Math.min(n.d, 2) * 4)); k++) weighted.push(n.p);
    const centre = mean(weighted);
    const register = centre < 52 ? "low" : centre < 68 ? "middle" : "high";
    const wide = pct(ns.map((n) => n.p), 0.9) - pct(ns.map((n) => n.p), 0.1) >= 30;
    const eventsPerSec = groups.length / span;
    const pace = eventsPerSec < 1.3 ? "slow" : eventsPerSec < 2.6 ? "unhurried" : eventsPerSec < 5 ? "moving" : "quick";
    const vel = ns.map((n) => n.v);
    const loud = mean(vel);
    const loudness = loud < 48 ? "soft" : loud > 88 ? "loud" : null;
    const thirdN = Math.max(1, Math.floor(ns.length / 3));
    const dv = mean(vel.slice(-thirdN)) - mean(vel.slice(0, thirdN));
    const dynamics = dv >= 14 ? "swelling" : dv <= -14 ? "fading" : null;
    // Tension: share of dissonant interval classes (1, 2, 6) among the pitch classes sounding
    // at each onset (feature_map.py's definition).
    const ic = new Array(7).fill(0);
    for (const g of groups) {
      const t = g[0].t;
      const pcs = [...new Set(ns.filter((n) => n.t <= t + GROUP_S && n.t + n.d > t).map((n) => n.p % 12))].sort((x, y) => x - y);
      for (let i = 0; i < pcs.length; i++)
        for (let j = i + 1; j < pcs.length; j++) {
          const d = (pcs[j] - pcs[i]) % 12;
          ic[Math.min(d, 12 - d)]++;
        }
    }
    const icTotal = ic.slice(1).reduce((x, y) => x + y, 0);
    const tension = icTotal ? (ic[1] + ic[2] + ic[6]) / icTotal : 0;
    // Scattered: few events with long gaps; describe it as that, not as a "line" in a key.
    const iois = groups.slice(1).map((g, i) => g[0].t - groups[i][0].t);
    const sparse = eventsPerSec < 0.8 || (pct(iois, 0.5) >= 1.2 && ns.length < 30);

    // Spell the pedal note the way the key does (G# in C# minor, Ab in Db major).
    const k = key(ns);
    const SHARP_KEYS = new Set(["G major", "D major", "A major", "E major", "B major", "F# major", "E minor", "B minor", "F# minor", "C# minor", "G# minor"]);
    const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    if (pedal !== null) pedal = (SHARP_KEYS.has(k.name) ? SHARP_NAMES : NOTE_NAMES)[pedal];
    return {
      key: k,
      pace, register, wide, loudness, dynamics, contour, texture, pedal, sparse,
      seconds: end - start,
      nNotes: ns.length,
      eventsPerSec: +eventsPerSec.toFixed(2),
      chordal: +chordal.toFixed(2),
      centre: Math.round(centre),
      velocity: Math.round(loud),
      tension: +tension.toFixed(3),
      energy: +(eventsPerSec * (loud / 80)).toFixed(3),
    };
  }

  // Average number of notes sounding at each onset: >1.6 with single onsets = broken chords.
  function overlap(ns) {
    let total = 0;
    for (const n of ns) total += ns.filter((m) => m.t <= n.t && m.t + m.d > n.t).length;
    return total / ns.length;
  }

  const CONTOUR_WORDS = {
    line: { rising: "that rises", falling: "that falls", arching: "that rises and falls back", dipping: "that dips and returns", circling: "circling one place" },
    other: { rising: "rising", falling: "falling", arching: "rising, then falling back", dipping: "dipping, then returning", circling: "turning in place" },
  };

  // How sure the key is, in words: clear → "in", fair → "around", weak → none.
  function keyPhrase(k) {
    if (!k.name || k.r < 0.6) return "with no settled key";
    return k.r >= 0.72 ? `in ${k.name}` : `around ${k.name}`;
  }
  const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0] || "");

  function describe(f) {
    if (!f || f.tooFew) return "a few scattered notes";
    if (f.sparse) {
      const where = f.wide || f.register === "middle" ? "" : `${f.register} `;
      return [`scattered ${where}notes with long silences`, f.key.r >= 0.72 ? `in ${f.key.name}` : null, f.loudness]
        .filter(Boolean)
        .join(", ");
    }
    const plural = f.texture === "chords" || f.texture === "arpeggios";
    const noun = `${f.pace} ${f.texture}`;
    let np = plural ? noun : `${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`;
    const melodic = f.texture === "line" || f.texture === "melody over chords" || f.texture === "figure";
    const motion = (melodic ? CONTOUR_WORDS.line : CONTOUR_WORDS.other)[f.contour];
    let head = `${np} ${motion}`;
    if (f.pedal) {
      // "a melody over chords and a repeated low C, circling one place"
      np += f.texture.includes(" over ") ? ` and a repeated low ${f.pedal}` : ` over a repeated low ${f.pedal}`;
      head = `${np}, ${motion}`;
    }
    const colour = andList([f.wide ? "wide-ranging" : f.register, f.loudness, f.dynamics].filter(Boolean));
    return [head, keyPhrase(f.key), colour].filter(Boolean).join(", ");
  }

  function defaultName(f) {
    if (!f || f.tooFew) return "a few notes";
    const noun = f.texture === "melody over chords" ? "melody" : f.texture;
    return f.key.name ? `${f.key.name} ${noun}` : `${noun[0].toUpperCase()}${noun.slice(1)} without a key`;
  }

  return { of, describe, defaultName };
})();
