// Reverie demo mode (2026-11-12): the real app on a bundled sample journal, for sharing.
// Loaded before reverie.js in the static demo (scripts/build_demo.py). It answers the app's
// /api/... requests from data/journal.json, plays the notes through a sampled piano instead of
// recorded audio (same interface as an <audio> element), and turns recording off.

(() => {
  // Dates are stored as "@d3m540" (3 days ago, 9:00) so "today" always has entries.
  function resolveDates(x) {
    if (typeof x === "string") {
      const m = x.match(/^@d(\d+)m(\d+)$/);
      if (!m) return x;
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - Number(m[1]));
      d.setMinutes(Number(m[2]));
      return d.toISOString();
    }
    if (Array.isArray(x)) return x.map(resolveDates);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolveDates(v)]));
    return x;
  }

  const realFetch = window.fetch.bind(window);
  const DATA = realFetch("data/journal.json").then((r) => r.json()).then(resolveDates);
  const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

  // A waveform-like envelope from the notes (there is no recording to measure).
  function peaksFrom(notes, n) {
    if (!notes || !notes.length) return null;
    const end = Math.max(...notes.map((x) => x[1] + Math.min(x[2], 3)));
    const out = new Array(n).fill(0);
    for (const [, t, d, v] of notes) {
      for (let i = Math.floor((t / end) * n); i < n; i++) {
        const dt = (i / n) * end - t;
        if (dt > Math.min(d, 3)) break;
        out[i] += (v / 127) * Math.exp(-Math.max(0, dt) / 1.2);
      }
    }
    const top = Math.max(...out) || 1;
    return out.map((x) => x / top);
  }

  window.fetch = async (input, opts = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, opts);
    const d = await DATA;
    const method = (opts.method || "GET").toUpperCase();
    let m;
    if (url === "/api/journal") return json(d.journal);
    if (url === "/api/motifs") return json(d.motifs);
    if (url === "/api/snippets") return json(d.snippets);
    if ((m = url.match(/^\/api\/entries\/([\w-]+)\/midi$/))) return realFetch(`data/midi/${m[1]}.mid`);
    if ((m = url.match(/^\/api\/entries\/([\w-]+)\/peaks\?n=(\d+)$/))) return json(peaksFrom(await Views.entryNotes(m[1]), Number(m[2])));
    if ((m = url.match(/^\/api\/motifs\/([\w-]+)$/)) && method === "PATCH") {
      // Renames last for this visit only.
      const name = JSON.parse(opts.body).name.trim();
      for (const mo of d.motifs.motifs) if (mo.id === m[1]) mo.name = name;
      for (const s of d.snippets.snippets) {
        if (s.theme?.id === m[1]) s.theme.name = name;
        for (const r of s.related || []) if (r.motif_id === m[1]) r.name = name;
      }
      for (const st of d.journal.sittings) for (const e of st.entries) for (const mm of e.motifs) if (mm.id === m[1]) mm.name = name;
      return json({ ok: true });
    }
    return json({ detail: "Not available in the sample journal" }, 404);
  };

  // ---------- a sampled piano behind an <audio>-like interface ----------

  let samplerPromise = null;
  function getSampler() {
    if (!samplerPromise) {
      samplerPromise = (async () => {
        const urls = { A0: "A0.mp3", C8: "C8.mp3" };
        for (let o = 1; o <= 7; o++) Object.assign(urls, { [`C${o}`]: `C${o}.mp3`, [`D#${o}`]: `Ds${o}.mp3`, [`F#${o}`]: `Fs${o}.mp3`, [`A${o}`]: `A${o}.mp3` });
        const s = new Tone.Sampler({ urls, release: 1, baseUrl: "static/samples/" }).toDestination();
        await Tone.loaded();
        return s;
      })();
    }
    return samplerPromise;
  }

  class DemoPlayer extends EventTarget {
    constructor() {
      super();
      this.paused = true;
      this.readyState = 0;
      this.duration = NaN;
      this._src = "";
      this._notes = null;
      this._offset = 0;
      this._t0 = 0;
      this._timer = null;
    }
    get src() {
      return this._src;
    }
    set src(v) {
      this.pause();
      this._src = v;
      this._notes = null;
      this.readyState = 0;
      this._offset = 0;
    }
    load() {
      const m = this._src.match(/entries\/([\w-]+)\/audio/);
      if (!m) return this.dispatchEvent(new Event("error"));
      const src = this._src;
      Views.entryNotes(m[1]).then(
        (notes) => {
          if (src !== this._src) return;
          this._notes = (notes || []).slice().sort((a, b) => a[1] - b[1]);
          this.duration = Math.max(0.5, ...this._notes.map((n) => n[1] + Math.min(n[2], 3)));
          this.readyState = 4;
          this.dispatchEvent(new Event("loadedmetadata"));
        },
        () => this.dispatchEvent(new Event("error")),
      );
    }
    get currentTime() {
      return this.paused ? this._offset : this._offset + (performance.now() - this._t0) / 1000;
    }
    set currentTime(v) {
      const playing = !this.paused;
      if (playing) this._stop();
      this._offset = Math.max(0, v);
      if (playing) this._start();
    }
    async play() {
      if (!this._notes || !this.paused) return;
      Tone.start(); // inside the click: browsers only allow sound that a gesture started
      this._smp = await getSampler();
      if (!this.paused) return;
      this.paused = false;
      this._start();
      this.dispatchEvent(new Event("play"));
    }
    pause() {
      if (this.paused) return;
      this._offset = this.currentTime;
      this.paused = true;
      this._stop();
      this.dispatchEvent(new Event("pause"));
    }
    _start() {
      // Schedule a quarter-second ahead at a time, so pausing stops promptly.
      this._t0 = performance.now();
      const off = this._offset, at = Tone.now() + 0.05;
      let next = this._notes.findIndex((n) => n[1] >= off - 0.01);
      if (next < 0) next = this._notes.length;
      const tick = () => {
        const horizon = this.currentTime + 0.25;
        while (next < this._notes.length && this._notes[next][1] <= horizon) {
          const [p, t, d, v] = this._notes[next++];
          this._smp.triggerAttackRelease(Tone.Frequency(p, "midi").toNote(), Math.max(0.08, Math.min(d, 4)), at + (t - off), Math.max(0.05, v / 127));
        }
        if (this.currentTime >= this.duration) {
          this._offset = this.duration;
          this.paused = true;
          this._stop();
          this.dispatchEvent(new Event("pause"));
          this.dispatchEvent(new Event("ended"));
        }
      };
      tick();
      this._timer = setInterval(tick, 60);
    }
    _stop() {
      clearInterval(this._timer);
      this._timer = null;
      this._smp?.releaseAll();
    }
  }

  window.DemoPlayer = new DemoPlayer();
  window.Capture = { on() {}, ignorePlayback() {}, start() {}, pause() {}, state: "off" }; // no recording in the demo
})();
