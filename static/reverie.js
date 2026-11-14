// Reverie, the companion (ux.md): Today, Journal, Library, and each idea as a dictionary entry.
// Listening runs the whole time (capture.js); the pages are views of the same data. The page
// only changes when something new arrives, so nothing moves while you play.

const $ = (id) => document.getElementById(id);
const page = $("page");
const player = window.DemoPlayer || window.LocalPlayer || $("player"); // sample journal: notes; in-browser: stored audio
const listenBtn = $("listen");
const listenWord = $("listenWord");
const gate = $("gate");

const HIDDEN = new Set(["merged", "discarded"]);
const PENDING = new Set(["processing", "analyzing", "relating"]);

const store = {
  sittings: [],
  motifs: new Map(), // id -> motif (/api/motifs)
  snippets: [], // /api/snippets: every occurrence of an idea, with its stanza
  seen: new Set(), // "entryId:p|r" already shown, so only new lines fade in
  readySig: null,
  pollTimer: null,
  loaded: false,
  lastHtml: "",
  lines: new Map(), // entry id -> one line written by code from its notes (facts.js)
  ideas: new Map(), // motif id -> { notes, facts, line } from its first occurrence
};

// ============================================================================
// Data
// ============================================================================

async function refresh() {
  clearTimeout(store.pollTimer);
  try {
    const data = await (await fetch("/api/journal")).json();
    store.sittings = data.sittings;
    const sig = entries()
      .filter((e) => e.status === "ready")
      .map((e) => e.id + (e.title || ""))
      .join("|");
    if (sig !== store.readySig) {
      store.readySig = sig;
      await refreshLibrary();
    }
    await ensureFacts();
    if (!store.loaded) {
      entries().forEach((e) => store.seen.add(seenKey(e))); // nothing fades in on first load
      store.loaded = true;
    }
    render();
    backgroundNote();
  } catch (err) {
    console.error(err);
  }
  const busy = entries().some((e) => PENDING.has(e.status));
  store.pollTimer = setTimeout(refresh, busy ? 2000 : 15000);
}

async function refreshLibrary() {
  const [m, s] = await Promise.all([fetch("/api/motifs").then((r) => r.json()), fetch("/api/snippets").then((r) => r.json())]);
  store.motifs = new Map(m.motifs.map((x) => [x.id, x]));
  store.snippets = s.snippets;
  store.ideas.clear();
}

// Facts and one-line descriptions, worked out in the browser from the notes (no AI).
async function ensureFacts() {
  const jobs = [];
  for (const e of entries()) {
    if (e.status !== "ready" || store.lines.has(e.id)) continue;
    jobs.push(Views.entryNotes(e.id).then((n) => store.lines.set(e.id, n && n.length ? Facts.describe(Facts.of(n)) : null)));
  }
  for (const m of store.motifs.values()) {
    if (store.ideas.has(m.id) || !m.occurrences.length) continue;
    jobs.push(
      Views.ideaNotes(m).then((n) => {
        const f = n && n.length ? Facts.of(n) : null;
        store.ideas.set(m.id, { notes: n, facts: f, line: f ? Facts.describe(f) : null });
      }),
    );
  }
  await Promise.all(jobs);
}

function entries() {
  return store.sittings.flatMap((s) => s.entries).filter((e) => !HIDDEN.has(e.status));
}

const byCreated = (a, b) => (a.created_at || "").localeCompare(b.created_at || "");
const seenKey = (e) => `${e.id}:${PENDING.has(e.status) ? "p" : "r"}`;

// ============================================================================
// Pages
// ============================================================================

function route() {
  const [name, arg] = (location.hash.replace(/^#/, "") || "today").split("/");
  const pages = ["today", "journal", "library", "idea", ...($("aboutText") ? ["about"] : [])];
  return { name: pages.includes(name) ? name : "today", arg };
}

window.addEventListener("hashchange", () => render(true));

function render(force = false) {
  if (document.activeElement?.isContentEditable) return; // don't disturb a rename
  const r = route();
  document.querySelectorAll(".rv-nav a").forEach((a) => {
    a.classList.toggle("current", a.dataset.page === r.name || (r.name === "idea" && a.dataset.page === "library"));
  });
  const html =
    r.name === "journal" ? journalPage() : r.name === "library" ? libraryPage() : r.name === "idea" ? ideaPage(r.arg)
      : r.name === "about" ? aboutPage() : todayPage();
  if (!force && html === store.lastHtml) return; // nothing changed: leave the page still
  store.lastHtml = html;

  // A different page (or a different way of seeing the library) fades: out quickly, then in
  // slowly. Updates to the same page — a new line arriving, a map layout gliding — don't.
  const where = [r.name, r.arg || "", r.name === "library" ? `${getPref("view", "list", SEE_AS)}:${getPref("arrange", "recent", ARRANGEMENTS)}` : ""].join("/");
  const moved = store.where !== undefined && where !== store.where;
  store.where = where;
  const swap = () => {
    page.innerHTML = html;
    if (moved) window.scrollTo(0, 0);
    page.classList.remove("rv-leave", "rv-enter");
    if (moved || !store.shown) {
      void page.offsetWidth; // restart the animation
      page.classList.add("rv-enter");
      // Off again once everything has settled, so later quiet refreshes don't replay it.
      clearTimeout(store.enterTimer);
      store.enterTimer = setTimeout(() => page.classList.remove("rv-enter"), 1400);
    }
    store.shown = true;
    afterRender(r);
    markPlaying();
    revealNewest();
  };
  clearTimeout(store.fadeTimer);
  if (moved && !REDUCED_MOTION && page.childElementCount) {
    page.classList.add("rv-leave");
    store.fadeTimer = setTimeout(swap, 170);
  } else swap();
}
const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ---------- Today ----------

// The about page: its words live in the page (play.html's <template id="aboutText">).
function aboutPage() {
  return `<article class="rv-entry rv-about-page">${$("aboutText").innerHTML}</article>`;
}

function todayPage() {
  const today = new Date().toDateString();
  const list = entries()
    .filter((e) => new Date(e.created_at).toDateString() === today)
    .sort(byCreated);
  const head = `<h1 class="rv-day">${esc(longDate(new Date()))}</h1><p class="rv-daysub">${partOfDay(new Date())}</p>`;
  if (!list.length) return head + `<p class="rv-empty">Play whenever you're ready.</p>`;
  return head + `<ul class="rv-lines">${list.map(lineHtml).join("")}</ul>`;
}

// ---------- Journal ----------

function journalPage() {
  const today = new Date().toDateString();
  const days = new Map();
  for (const e of entries().sort(byCreated)) {
    const k = new Date(e.created_at).toDateString();
    if (k === today) continue;
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(e);
  }
  if (!days.size) return `<p class="rv-empty">Earlier days will collect here.</p>`;
  return [...days.values()]
    .reverse()
    .map(
      (list) => `<section class="rv-journal-day">
        <h1 class="rv-day">${esc(longDate(new Date(list[0].created_at)))}</h1>
        <p class="rv-daysub">${list.length === 1 ? "one sketch" : `${list.length} sketches`}</p>
        <ul class="rv-lines">${list.map(lineHtml).join("")}</ul>
      </section>`,
    )
    .join("");
}

// ---------- one line: one thing you played ----------

function lineHtml(e) {
  const key = seenKey(e);
  const arrive = store.seen.has(key) ? "" : " arrive";
  store.seen.add(key);
  const time = `<span class="rv-time">${esc(fmtClock(e.created_at))}</span>`;
  if (PENDING.has(e.status)) {
    // In the browser version a sketch being played gets a live piano roll (filled in by drawLive).
    const roll = window.LocalLive ? `<div class="rv-live" data-live="${e.id}"></div>` : "";
    return `<li class="rv-line pending${arrive}" data-entry="${e.id}">${time}<div><div class="rv-title">${esc(pendingCue(e.id))}</div>${roll}</div></li>`;
  }
  if (e.status === "failed") {
    return `<li class="rv-line failed${arrive}" data-entry="${e.id}">${time}<div><div class="rv-title">couldn't make this one out · <a href="#" data-retry="${e.id}">try again</a></div></div></li>`;
  }
  const ideas = (e.motifs || [])
    .map((m) => `<a href="#idea/${m.id}">${esc(m.name)}</a>${heardBefore(m.id, e) ? ", again" : ""}`)
    .join(" · ");
  const voice = (e.transcript || [])
    .map((s) => s.text)
    .join(" ")
    .trim();
  const about = store.lines.get(e.id) ?? (e.summary ? firstClause(e.summary) : "");
  return `<li class="rv-line${arrive}" data-entry="${e.id}">${time}<div>
      <div class="rv-title">${esc(e.title || "untitled")}</div>
      ${e.has_audio ? `<canvas class="rv-wave" data-wave="${e.id}"></canvas>` : ""}
      ${about ? `<div class="rv-about">${esc(about)}</div>` : ""}
      ${ideas ? `<div class="rv-ideas">${ideas}</div>` : ""}
      ${voice.length > 2 ? `<div class="rv-voice">“${esc(clip(voice, 140))}”</div>` : ""}
    </div></li>`;
}

function heardBefore(motifId, entry) {
  const m = store.motifs.get(motifId);
  const first = m?.occurrences?.[0];
  return Boolean(first && first.entry_id !== entry.id && (first.entry_created_at || "") < (entry.created_at || ""));
}

function revealNewest() {
  // A new line below the fold scrolls gently into view, unless you've been scrolling.
  const fresh = page.querySelector(".rv-line.arrive:last-of-type");
  if (fresh && Date.now() - lastScroll > 10000) fresh.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
let lastScroll = 0;
window.addEventListener("wheel", () => (lastScroll = Date.now()), { passive: true });
window.addEventListener("touchmove", () => (lastScroll = Date.now()), { passive: true });

// ---------- Library ----------

const ARRANGEMENTS = [
  ["recent", "recent"],
  ["first", "first heard"],
  ["played", "most played"],
  ["az", "a–z"],
  ["key", "key"],
  ["texture", "texture"],
];

const SEE_AS = [
  ["list", "list"],
  ["cards", "cards"],
  ["map", "map"],
];

function getPref(name, fallback, options) {
  try {
    const v = localStorage.getItem(`reverie.${name}`);
    if (options.some(([k]) => k === v)) return v;
  } catch (_) {}
  return fallback;
}
function setPref(name, v) {
  try {
    localStorage.setItem(`reverie.${name}`, v);
  } catch (_) {}
}
const choiceLine = (label, attr, options, current) =>
  `<div class="rv-arrange"><span>${label}</span>${options
    .map(([k, l]) => `<button data-${attr}="${k}" class="${k === current ? "current" : ""}">${l}</button>`)
    .join("")}</div>`;

function libraryPage() {
  const ideas = [...store.motifs.values()].map(ideaFacts);
  if (!ideas.length) return `<p class="rv-empty">${store.loaded ? "Ideas you play will collect here." : ""}</p>`;
  const view = getPref("view", "list", SEE_AS);
  let html = choiceLine("see as", "view", SEE_AS, view);
  if (view === "map") {
    const layout = getPref("layout", "wheel", Views.LAYOUTS);
    return (
      html +
      choiceLine("layout", "layout", Views.LAYOUTS, layout) +
      `<div class="rv-mapbox" id="mapbox"></div>
       <p class="rv-map-legend"><span class="sw minor"></span>minor <span class="sw major"></span>major
         <span class="sw none"></span>no clear key · bigger = played more · click a dot to hear it</p>
       <p class="rv-map-status" id="mapStatus"></p>`
    );
  }
  const arr = getPref("arrange", "recent", ARRANGEMENTS);
  html += choiceLine("arrange by", "arrange", ARRANGEMENTS, arr);
  return (
    html +
    arrange(ideas, arr)
      .map(
        (g) =>
          (g.title ? `<h2 class="rv-group">${esc(g.title)}</h2>` : "") +
          (view === "cards" ? `<div class="rv-cards">${g.ideas.map(ideaCard).join("")}</div>` : g.ideas.map(ideaRow).join("")),
      )
      .join("")
  );
}

function ideaCard(i) {
  const o = i.motif.occurrences[0];
  return `<div class="rv-card" data-play="${o.entry_id},${o.start},${o.end}">
      <a class="name" href="#idea/${i.id}">${esc(i.name)}</a>
      <div class="meta">${esc([i.key, playedText(i.count)].filter(Boolean).join(" · "))}</div>
      <div class="rv-card-roll" data-roll-idea="${i.id}"></div>
      ${i.description ? `<div class="def">${esc(i.description)}</div>` : ""}
    </div>`;
}

function ideaFacts(m) {
  const snips = store.snippets
    .filter((s) => s.theme?.id === m.id)
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "") || a.start - b.start);
  const stanza = snips.find((s) => s.stanza?.key)?.stanza || null;
  const own = store.ideas.get(m.id);
  let tags = [...new Set(snips.flatMap((s) => s.stanza?.texture_tags || []))];
  if (!tags.length && own?.facts?.texture) tags = [own.facts.texture]; // the code's texture when the AI gave none
  const codeKey = own?.facts?.key?.r >= 0.6 ? own.facts.key.name : null;
  return {
    id: m.id,
    name: m.name,
    description: own?.line || firstClause(m.description || ""),
    key: own?.facts ? codeKey : stanza?.key || null, // the code's verdict wins, including "no clear key"
    roman: stanza?.roman || [],
    tags,
    first: m.occurrences[0]?.entry_created_at || m.created_at,
    last: m.last_heard,
    count: m.occurrences.length,
    motif: m,
    snips,
  };
}

function arrange(ideas, how) {
  const one = (list) => [{ title: null, ideas: list }];
  const groupBy = (list, keyOf, order) => {
    const g = new Map();
    for (const i of list) for (const k of [].concat(keyOf(i))) (g.get(k) || g.set(k, []).get(k)).push(i);
    return [...g].sort((a, b) => order(a[0], b[0], a[1], b[1])).map(([title, ideas]) => ({ title, ideas }));
  };
  if (how === "first") {
    const list = [...ideas].sort((a, b) => (a.first || "").localeCompare(b.first || ""));
    return groupBy(list, (i) => monthLabel(i.first), () => 0);
  }
  if (how === "played") return one([...ideas].sort((a, b) => b.count - a.count || (b.last || "").localeCompare(a.last || "")));
  if (how === "az") {
    const list = [...ideas].sort((a, b) => a.name.localeCompare(b.name));
    return groupBy(list, (i) => (i.name[0] || "?").toUpperCase(), (a, b) => a.localeCompare(b));
  }
  if (how === "key") {
    const list = [...ideas].sort((a, b) => a.name.localeCompare(b.name));
    return groupBy(list, (i) => normKey(i.key) || "no settled key", (a, b) => keyOrder(a) - keyOrder(b));
  }
  if (how === "texture") {
    const list = [...ideas].sort((a, b) => a.name.localeCompare(b.name));
    return groupBy(
      list,
      (i) => (i.tags.length ? i.tags : ["not described"]),
      (a, b, la, lb) => (a === "not described") - (b === "not described") || lb.length - la.length || a.localeCompare(b),
    );
  }
  return one([...ideas].sort((a, b) => (b.last || "").localeCompare(a.last || "")));
}

function ideaRow(i) {
  return `<a class="rv-idea-row" href="#idea/${i.id}">
      <span class="name">${esc(i.name)}</span>${i.key ? `<span class="pos">${esc(i.key)}</span>` : ""}
      ${i.description ? `<div class="def">${esc(i.description)}</div>` : ""}
      <div class="note">${playedText(i.count)} · first heard ${esc(shortDate(i.first))}</div>
    </a>`;
}

// ---------- one idea, as a dictionary entry ----------

function ideaPage(id) {
  const back = `<a class="rv-back" href="#library">← library</a>`;
  const m = store.motifs.get(id);
  if (!m) return back + `<p class="rv-empty">${store.loaded ? "This idea isn't in the library any more." : ""}</p>`;
  const f = ideaFacts(m);
  const pron = [f.key, f.roman.length ? f.roman.join(" – ") : null].filter(Boolean).join(" · ");
  const heard = m.occurrences
    .map(
      (o, n) => `<li data-play="${o.entry_id},${o.start},${o.end}">
        <span class="when">${n === 0 ? "as first played" : "again"}, ${esc(shortDate(o.entry_created_at))}</span>
        <span class="how"> · ${esc(o.entry_title || "untitled")}${n > 0 && o.variation_note ? `. ${esc(capitalize(firstClause(o.variation_note)))}` : ""}</span>
        ${n > 0 ? `<button class="notthis" data-notthis="${o.entry_id},${o.phrase_id}">not this</button>` : ""}
        <div class="rv-heard-roll" data-roll="${o.entry_id},${o.start},${o.end}"></div>
      </li>`,
    )
    .join("");
  const related = new Map();
  for (const s of f.snips) for (const r of s.related || []) if (r.motif_id !== id) related.set(r.motif_id, r.name);
  for (const s of store.snippets) {
    if (s.theme && s.theme.id !== id && (s.related || []).some((r) => r.motif_id === id)) related.set(s.theme.id, s.theme.name);
  }
  const seeAlso = [...related]
    .filter(([rid]) => store.motifs.has(rid))
    .map(([rid, name]) => `<a href="#idea/${rid}">${esc(name)}</a>`)
    .join(" · ");
  return `${back}
    <article class="rv-entry">
      <h1 class="word" data-rename="${id}" title="Click to rename">${esc(f.name)}</h1>
      ${pron ? `<p class="pron">${esc(pron)}</p>` : ""}
      <p class="pos">idea · first heard ${esc(longDate(new Date(f.first)))} · ${playedText(f.count)}</p>
      ${f.description ? `<p class="definition">${esc(f.description)}</p>` : ""}
      <h2>heard</h2>
      <ol class="rv-heard">${heard}</ol>
      ${seeAlso ? `<h2>see also</h2><p class="rv-seealso">${seeAlso}</p>` : ""}
      ${closeTo(m)}
    </article>`;
}

// In-browser version: what this idea sounds close to, each with a one-tap "same idea".
function closeTo(m) {
  const list = (m.closest || []).filter((c) => store.motifs.has(c.motif_id));
  if (!list.length) return "";
  return `<h2>sounds close to</h2><ul class="rv-close">${list
    .map((c) => `<li><a href="#idea/${c.motif_id}">${esc(c.name)}</a> <button class="rv-same" data-merge="${m.id},${c.motif_id}">same idea</button></li>`)
    .join("")}</ul>`;
}

// What a sketch that isn't finished yet is doing, in a few words (on its line, in place of a title).
function pendingCue(id) {
  const live = window.LocalLive?.(id);
  if (!live) return "writing it down…"; // the whole-recording path, or after a reload
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return {
    // Closed before the transcriber finished loading (its pencil sketch is already showing).
    waiting: "heard you · notes coming in a moment",
    // After a few quiet seconds the sketch is still open (it closes after 12), so the clock stops.
    live: (Capture.debug?.().burst?.quietMs ?? 0) > 3000 ? "still listening…" : `listening along · ${clock(live.seconds)}`,
    queued: "waiting its turn…",
    finishing: "writing it down…",
    inked: "writing it down…",
  }[live.phase];
}

// The live piano roll of a sketch still being played: redrawn as each window is transcribed.
function drawLive(id) {
  const el = page.querySelector(`[data-live="${id}"]`);
  const live = window.LocalLive?.(id);
  if (!el || !live) return;
  const title = el.closest(".rv-line")?.querySelector(".rv-title");
  const cue = pendingCue(id);
  if (title && title.textContent !== cue) title.textContent = cue;
  // Pencil sketch first (Basic Pitch, a second or two behind), inked over by Transkun as it settles;
  // the pencil stays wherever the ink hasn't arrived yet.
  if (live.ink.length || live.sketch.length) Views.drawRoll(el, live.ink, { height: 56, span: 60, sketch: live.sketch });
  backgroundNote();
}
window.addEventListener("reverie:live", (ev) => drawLive(ev.detail.id));

function afterRender(r) {
  page.querySelectorAll("[data-live]").forEach((el) => drawLive(el.dataset.live));
  page.querySelectorAll("canvas[data-wave]").forEach((c) => Views.drawWave(c, c.dataset.wave, waveProgress(c.dataset.wave)));
  // Piano rolls: each occurrence on an idea's page, and each idea's card (its first occurrence).
  page.querySelectorAll("[data-roll]").forEach(async (el) => {
    const [id, start, end] = el.dataset.roll.split(",");
    const all = await Views.entryNotes(id);
    if (all && el.isConnected) Views.drawRoll(el, Views.slice(all, Number(start), Number(end)), { height: 72 });
  });
  page.querySelectorAll("[data-roll-idea]").forEach((el) => Views.drawRoll(el, store.ideas.get(el.dataset.rollIdea)?.notes, { height: 72 }));
  if (r.name !== "library") return;
  const view = getPref("view", "list", SEE_AS);
  if (view === "map") {
    const items = [...store.motifs.values()].map((m) => {
      const own = store.ideas.get(m.id) || {};
      return { id: m.id, name: m.name, count: m.occurrences.length, first: m.occurrences[0]?.entry_created_at, facts: own.facts, notes: own.notes,
               line: own.line, vec: m.vec };
    });
    Views.drawMap($("mapbox"), items, getPref("layout", "wheel", Views.LAYOUTS), {
      onPlay: (id) => {
        const o = store.motifs.get(id)?.occurrences[0];
        if (!o) return;
        const key = `${o.entry_id},${o.start},${o.end}`;
        if (playback.key === key && !player.paused) return player.pause();
        playRange(o.entry_id, o.start, o.end, key);
      },
      status: (t) => {
        const s = $("mapStatus");
        if (s) s.textContent = t;
      },
    });
  }
}

function waveProgress(id) {
  return playback.entryId === id && player.duration ? player.currentTime / player.duration : -1;
}

// ============================================================================
// Actions: play, rename, "not this", retry, arrange
// ============================================================================

document.addEventListener("click", async (e) => {
  for (const pref of ["arrange", "view", "layout"]) {
    const btn = e.target.closest(`[data-${pref}]`);
    if (btn) {
      setPref(pref, btn.dataset[pref]);
      return render(true);
    }
  }
  const retry = e.target.closest("[data-retry]");
  if (retry) {
    e.preventDefault();
    await fetch(`/api/entries/${retry.dataset.retry}/retry`, { method: "POST" });
    return refresh();
  }
  const merge = e.target.closest("[data-merge]");
  if (merge) {
    const [from, into] = merge.dataset.merge.split(",");
    merge.textContent = "joining…";
    const res = await fetch(`/api/motifs/${from}/merge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ into }) });
    await refreshLibrary();
    await ensureFacts();
    if (res.ok) location.hash = `#idea/${into}`;
    return render(true);
  }
  const notThis = e.target.closest("[data-notthis]");
  if (notThis) {
    e.stopPropagation();
    const [entryId, phraseId] = notThis.dataset.notthis.split(",");
    notThis.textContent = "moving it to its own idea…";
    notThis.style.visibility = "visible";
    await fetch(`/api/entries/${entryId}/phrases/${phraseId}/not-motif`, { method: "POST" });
    await refreshLibrary();
    return render(true);
  }
  const word = e.target.closest("[data-rename]");
  if (word && word.contentEditable !== "true") return startRename(word);
  if (e.target.closest("a")) return; // links navigate
  const item = e.target.closest("[data-play]");
  if (item) {
    const [id, start, end] = item.dataset.play.split(",");
    if (playback.key === item.dataset.play && !player.paused) return player.pause();
    return playRange(id, Number(start), Number(end), item.dataset.play);
  }
  const line = e.target.closest(".rv-line[data-entry]:not(.pending):not(.failed)");
  if (line) {
    const id = line.dataset.entry;
    if (playback.entryId === id && playback.key === "all" && !player.paused) return player.pause();
    return playRange(id, 0, null, "all");
  }
});

function startRename(el) {
  const original = el.textContent;
  el.contentEditable = "true";
  el.focus();
  document.getSelection().selectAllChildren(el);
  const finish = async (save) => {
    el.contentEditable = "false";
    el.removeEventListener("keydown", onKey);
    const name = el.textContent.trim();
    if (!save || !name || name === original) {
      el.textContent = original;
      return;
    }
    const res = await fetch(`/api/motifs/${el.dataset.rename}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) el.textContent = original;
    await refreshLibrary();
    render(true);
  };
  const onKey = (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      el.blur();
    } else if (ev.key === "Escape") {
      el.textContent = original;
      el.blur();
    }
  };
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", () => finish(true), { once: true });
}

// ---------- playback ----------

const playback = { entryId: null, stopAt: null, key: null, raf: null };

async function playRange(id, start, end, key) {
  if (playback.entryId !== id || player.readyState < 1) {
    // A new recording: load it and wait for its length before seeking. (With preload="none"
    // the browser never fetched metadata, so the first click on each recording did nothing.)
    playback.entryId = id;
    player.src = `/api/entries/${id}/audio`;
    player.load();
    const ok = await new Promise((resolve) => {
      player.addEventListener("loadedmetadata", () => resolve(true), { once: true });
      player.addEventListener("error", () => resolve(false), { once: true });
    });
    if (!ok || playback.entryId !== id) return; // failed, or another click took over
  }
  player.currentTime = Math.max(0, start - 0.05);
  playback.stopAt = end;
  playback.key = key;
  player.play();
}

player.addEventListener("play", () => {
  markPlaying();
  cancelAnimationFrame(playback.raf);
  const loop = () => {
    if (playback.stopAt != null && player.currentTime >= playback.stopAt) {
      playback.stopAt = null;
      player.pause();
    }
    const now = performance.now();
    if (now - (playback.waveAt || 0) > 120) {
      playback.waveAt = now;
      const c = page.querySelector(`canvas[data-wave="${playback.entryId}"]`);
      if (c) Views.drawWave(c, playback.entryId, waveProgress(playback.entryId));
    }
    if (!player.paused) playback.raf = requestAnimationFrame(loop);
  };
  loop();
});
player.addEventListener("pause", markPlaying);
player.addEventListener("ended", markPlaying);

function markPlaying() {
  document.querySelectorAll(".playing").forEach((el) => el.classList.remove("playing"));
  if (player.paused || !playback.key) return;
  if (playback.key === "all") page.querySelector(`.rv-line[data-entry="${playback.entryId}"]`)?.classList.add("playing");
  else page.querySelectorAll(`[data-play="${playback.key}"]`).forEach((el) => el.classList.add("playing"));
}

// ---------- listening ----------

const LISTEN_WORDS = {
  off: "listen",
  starting: "waiting for the microphone", // (the browser's permission prompt, the first time)
  listening: "listening",
  hearing: "hearing you",
  elsewhere: "listening in another tab",
  paused: "paused",
  blocked: "microphone off",
  "needs-gesture": "tap to listen",
};

Capture.on("state", (s) => {
  if (!listenBtn) return;
  listenBtn.dataset.state = s;
  listenWord.textContent = LISTEN_WORDS[s] || s;
  gate?.classList.toggle("hidden", s !== "needs-gesture");
  meterLoop();
});
// Without a gate, any tap lets the browser start the microphone again.
document.addEventListener("pointerdown", () => {
  if (!gate && Capture.state === "needs-gesture") Capture.start();
});

// The level meter beside "listening": how loud the room is, and a tick where a sketch begins.
const meter = $("meter");
let meterRunning = false;
function meterLoop() {
  if (!meter || meterRunning) return;
  meterRunning = true;
  const fill = meter.querySelector(".rv-meter-fill"), tick = meter.querySelector(".rv-meter-tick");
  const LO = -78, HI = -18; // dB across the meter
  const at = (db) => Math.min(1, Math.max(0, (db - LO) / (HI - LO)));
  const frame = () => {
    const d = Capture.debug();
    const on = Capture.state === "listening"; // (true while hearing, too)
    meter.classList.toggle("on", on && d.db != null);
    if (!on) return void (meterRunning = false);
    if (d.db != null && d.threshold != null) {
      // While a sketch is open a softer sound keeps it going, so the tick sits lower then.
      const starts = d.burst ? d.threshold - 6 : d.threshold;
      fill.style.transform = `scaleX(${at(d.db).toFixed(3)})`;
      tick.style.left = `${(100 * at(starts)).toFixed(1)}%`;
      meter.classList.toggle("over", d.db > starts);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// One quiet note in the header for what's happening in the background: the models loading
// (with a hairline that fills as they load), or sketches being written down.
const bgNote = $("modelNote");
const LONG_WAIT_MS = 4000;
function backgroundNote() {
  if (!bgNote) return;
  const m = window.ReverieModels?.state;
  let text = "", progress = null, title = "";
  const loading = m && m.phase !== "ready" && m.phase !== "idle" && m.phase !== "failed";
  // A short wait (most visits: the models are kept in this browser) isn't worth a word.
  const longWait = loading && performance.now() - (m.since ?? 0) > LONG_WAIT_MS;
  if (loading && !longWait) {
    clearTimeout(backgroundNote.later);
    backgroundNote.later = setTimeout(backgroundNote, LONG_WAIT_MS - (performance.now() - (m.since ?? 0)) + 50);
  }
  if (m && m.phase === "failed") text = "couldn't load the transcriber · reload to try again";
  else if (longWait) {
    text = "getting ready to transcribe";
    progress = m.progress;
    title = "Loading the model that turns your playing into notes. The first time takes a minute; after that it's kept in this browser. Anything you play meanwhile is kept and transcribed once it's ready.";
  } else {
    const writing = entries().filter((e) => PENDING.has(e.status) && window.LocalLive?.(e.id)?.phase !== "live").length;
    if (writing) text = writing === 1 ? "writing it down" : `writing down ${writing} sketches`;
  }
  bgNote.title = title;
  bgNote.style.setProperty("--progress", progress == null ? "0" : String(progress));
  bgNote.classList.toggle("loading", progress != null);
  if (bgNote.dataset.text === text) return;
  bgNote.dataset.text = text;
  bgNote.style.opacity = 0; // the words change by fading, not flipping
  clearTimeout(bgNote.fadeTimer);
  bgNote.fadeTimer = setTimeout(() => {
    bgNote.textContent = text;
    bgNote.style.opacity = text ? 1 : 0;
  }, 250);
}
window.addEventListener("reverie:models", backgroundNote);
Capture.on("burst", () => refresh());
window.addEventListener("reverie:changed", () => refresh()); // the in-browser version, when a sketch arrives or is done
Capture.ignorePlayback(player);

// (The sample journal has no listen button or gate.)
listenBtn?.addEventListener("click", () => (["listening", "hearing"].includes(Capture.state) ? Capture.pause() : Capture.start()));
gate?.addEventListener("click", () => {
  gate.classList.add("hidden");
  Capture.start();
});

// ============================================================================
// Words
// ============================================================================

function longDate(d) {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", ...(sameYear ? {} : { year: "numeric" }) });
}
function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString([], { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
function monthLabel(iso) {
  return iso ? new Date(iso).toLocaleDateString([], { month: "long", year: "numeric" }) : "undated";
}
function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}
function partOfDay(d) {
  const h = d.getHours();
  return h < 5 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night";
}
function playedText(n) {
  return n === 1 ? "played once" : n === 2 ? "played twice" : `played ${n} times`;
}
function firstClause(text) {
  const t = String(text || "").trim();
  const cut = t.split(/(?<=[.;:])\s/)[0].replace(/[.;:]$/, "");
  return clip(cut, 150);
}
function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}
function clip(text, n) {
  if (text.length <= n) return text;
  return text.slice(0, text.lastIndexOf(" ", n - 1) > n * 0.6 ? text.lastIndexOf(" ", n - 1) : n - 1) + "…";
}

const FIFTHS = ["C", "G", "D", "A", "E", "B", "F#", "C#", "Ab", "Eb", "Bb", "F"];
const ENHARMONIC = { Gb: "F#", Db: "C#", "G#": "Ab", "D#": "Eb", "A#": "Bb", Cb: "B", "E#": "F", Fb: "E", "B#": "C" };
function normKey(k) {
  if (!k) return null;
  const m = String(k).match(/^\s*([A-G])([#b♯♭]?)\s*(major|minor|maj|min|m)?/i);
  if (!m) return null;
  let tonic = m[1].toUpperCase() + (m[2] || "").replace("♯", "#").replace("♭", "b");
  tonic = ENHARMONIC[tonic] || tonic;
  const minor = /^(minor|min|m)$/i.test(m[3] || "") && m[3] !== "M";
  return `${tonic} ${minor ? "minor" : "major"}`;
}
function keyOrder(label) {
  if (label === "no settled key") return 999;
  const [tonic, mode] = label.split(" ");
  return FIFTHS.indexOf(tonic) * 2 + (mode === "minor" ? 1 : 0);
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ============================================================================

refresh();
if (!window.DEFER_LISTENING) Capture.start(); // the in-browser version starts after its loading screen
