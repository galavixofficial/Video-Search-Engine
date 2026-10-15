"use strict";
/* Sceneseek web UI. Plain JavaScript, no build step, no external requests. */

/* ═════════════════════════════ helpers ═════════════════════════════ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") { for (const [p, val] of Object.entries(v)) { if (p.startsWith("--")) el.style.setProperty(p, val); else el.style[p] = val; } }
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
/** replaceChildren that accepts nested arrays and skips null/false. */
function fill(el, ...kids) { el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; }
function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("class", "ic");
  const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  return s;
}
/** Thumbnails load shortly before they scroll into view. (Native lazy loading proved unreliable inside animated, scrolling panels.) */
const lazy = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { lazy.unobserve(e.target); e.target.src = e.target.dataset.src; }
}, { rootMargin: "600px" });
function img(src, alt = "") {
  const i = h("img", { alt, decoding: "async" });
  i.onload = () => i.classList.add("ok");
  i.onerror = () => { i.style.visibility = "hidden"; };
  i.dataset.src = src;
  lazy.observe(i);
  return i;
}

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: {} };
  if (opts.json !== undefined) { init.body = JSON.stringify(opts.json); init.headers["Content-Type"] = "application/json"; if (!opts.method) init.method = "POST"; }
  if (opts.form) { init.body = opts.form; init.method = "POST"; }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) throw new Error((data && (data.detail || data.error)) || `Something went wrong (${res.status})`);
  return data;
}

function toast(msg, kind = "", action) {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, h("span", {}, msg),
    action ? h("button", { type: "button", onclick: () => { action.fn(); close(); } }, action.label) : null);
  function close() { t.classList.add("out"); setTimeout(() => t.remove(), 300); }
  $("#toasts").append(t);
  setTimeout(close, action ? 7000 : kind === "err" ? 6500 : 3800);
}
const fail = (e) => toast(e.message || String(e), "err");

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtDur(sec) {
  if (!sec) return "0 s";
  if (sec < 90) return `${Math.round(sec)} s`;
  const m = Math.round(sec / 60);
  return m < 90 ? `${m} min` : `${(sec / 3600).toFixed(1)} h`;
}
function fmtSize(b) {
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
function ago(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 90) return "just now";
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} d ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
const thumbUrl = (id, t, w = 480) => `/api/thumb/${id}?t=${Math.max(0, Math.round(t))}&w=${w}`;
const verdict = (p) => (p >= 75 ? "Strong" : p >= 55 ? "Good" : p >= 35 ? "Maybe" : "Long shot");
/** Match percentage to a colour on one spectrum: red (weak), amber, yellow, lime, aqua (strong). */
const pcColor = (p) => `hsl(${Math.round(4 + Math.max(0, Math.min(1, (p - 28) / 68)) * 164)} 94% ${p > 40 ? 60 : 58}%)`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const typing = (el) => el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);
const baseName = (f) => f.split(/[\\/]/).filter(Boolean).pop() || f;
const pad = (n, w = 2) => String(n).padStart(w, "0");
const span = (...k) => h("span", {}, ...k);

/** Animate a number from 0 up to its final value. */
function countUp(el) {
  const to = +el.dataset.to, t0 = performance.now(), dur = 1100;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.firstChild.nodeValue = String(Math.round(to * e));
    if (k < 1) requestAnimationFrame(step);
  };
  el.firstChild.nodeValue = "0"; requestAnimationFrame(step);
}

/* ═════════════════════════════ state ═════════════════════════════ */
const store = {
  get(k, d) { try { const v = localStorage.getItem("sceneseek." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sceneseek." + k, JSON.stringify(v)); } catch { /* storage off */ } },
};
const prefs = { instant: store.get("instant", true), hover: store.get("hover", true), per: store.get("per", 4), view: store.get("view", "videos"), libView: store.get("libView", "list") };
function setPref(k, v) { prefs[k] = v; store.set(k, v); }

const state = {
  status: null, videos: [], videosKey: "", saved: [], concepts: null, conceptsLoading: false,
  results: null, view: "", minMatch: 0, libStatus: "all", libFolder: "", searchSeq: 0, scroll: 0,
};

/* ═════════════════════════════ theme ═════════════════════════════ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  fill($("#themeBtn"), icon(t === "light" ? "moon" : "sun"));
}
applyTheme(store.get("theme", "dark"));
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
$("#themeBtn").addEventListener("click", toggleTheme);

/* ═════════════════════════════ routing ═════════════════════════════ */
const PAGES = ["search", "explore", "saved", "library", "settings"];
function parseHash() {
  const raw = (location.hash || "#search").slice(1);
  const [path, qs] = raw.split("?");
  const parts = path.split("/");
  return { name: parts[0], id: +parts[1] || 0, params: new URLSearchParams(qs || "") };
}
async function route() {
  const { name, id, params } = parseHash();
  const page = name === "watch" ? "watch" : PAGES.includes(name) ? name : "search";
  const st = state.status;
  const view = st && !st.ready && page !== "settings" ? "setup" : page;
  const prev = state.view;
  if (prev === "search" && view !== "search") state.scroll = scrollY;
  if (prev === "watch" && view !== "watch") stopWatch();
  state.view = view;
  document.body.classList.toggle("is-watch", view === "watch");
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  $$(".tabs a[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === page && view !== "setup"));
  placeSearch();
  if (view !== prev) scrollTo(0, 0);
  if (view === "search") { renderScopes(); renderSearchPage(); if (prev !== "search" && state.results) scrollTo(0, state.scroll); }
  if (view === "explore") loadExplore();
  if (view === "saved") loadSaved(true);
  if (view === "library") refreshVideos(true);
  if (view === "settings") renderSettings();
  if (view === "watch") await enterWatch(id, params);
}
addEventListener("hashchange", route);
const go = (page) => { if (location.hash === "#" + page) route(); else location.hash = "#" + page; };
const goBack = () => { if (history.length > 1) history.back(); else go("search"); };

/** The search box is a hero on the home page and slim in the header everywhere else. */
function placeSearch() {
  const home = state.view === "search" && !state.results;
  const slot = home ? $("#heroSlot") : $("#hdrSlot"), form = $("#searchForm");
  document.body.classList.toggle("is-home", home);
  if (form.parentElement !== slot) { const had = document.activeElement === $("#q"); slot.append(form); if (had) $("#q").focus(); }
}

/* ═════════════════════════════ status polling ═════════════════════════════ */
let pollTimer = null, lastCompleted = -1, lastFrames = -1;
const seenErrors = new Set();
async function poll() {
  clearTimeout(pollTimer);
  try {
    const st = await api("/api/status");
    const first = !state.status, wasReady = state.status && state.status.ready;
    state.status = st;
    renderChrome(st);
    if (first || wasReady !== st.ready) await route();
    if (st.ready && wasReady === false) { toast("All set. Add a folder of videos to begin.", "ok"); go("library"); }
    if (st.indexing.completed !== lastCompleted || st.stats.frames !== lastFrames) {
      const grew = lastFrames >= 0 && st.stats.frames !== lastFrames;
      lastCompleted = st.indexing.completed; lastFrames = st.stats.frames;
      await refreshVideos();
      if (grew && !st.indexing.current && !st.indexing.pending) { state.concepts = null; if (state.view === "explore") loadExplore(); }
      if (state.view === "search" && !state.results) renderSearchPage();
    }
    if (state.view === "library") updateLiveCards(st);
    if (state.view === "settings") renderModelProgress(st);
    if (state.view === "setup") renderSetup(st);
    const busy = st.indexing.current || st.indexing.pending || st.download.active;
    pollTimer = setTimeout(poll, busy ? 1000 : 4000);
  } catch {
    pollTimer = setTimeout(poll, 3000);
  }
}

function renderChrome(st) {
  const n = st.stats.videos;
  $("#libCount").hidden = !n; $("#libCount").textContent = n;
  const ix = st.indexing, job = $("#job"), rec = $("#jobBtn");
  const busy = !!(ix.current || ix.pending);
  job.hidden = !busy; rec.hidden = !busy;
  if (busy) {
    const pct = ix.current ? Math.round(ix.current.pct) : 0;
    rec.classList.toggle("paused", ix.paused);
    $("#recText").textContent = ix.paused ? `Paused ${pct}%` : `Indexing ${pct}%`;
    $("#jobFill").style.width = pct + "%";
    $("#jobName").textContent = ix.paused ? "Indexing paused" : ix.current ? ix.current.name : "Getting ready…";
    const bits = [`${pct}%`];
    if (ix.current && ix.current.eta != null && !ix.paused) bits.push(`~${fmtDur(ix.current.eta)} left`);
    if (ix.pending) bits.push(`${ix.pending} waiting`);
    $("#jobInfo").textContent = bits.join("  ·  ");
    fill($("#jobPause"), icon(ix.paused ? "play" : "pause"));
    $("#jobPause").title = ix.paused ? "Resume" : "Pause";
    $("#jobPause").setAttribute("aria-label", ix.paused ? "Resume indexing" : "Pause indexing");
  }
  ix.errors.forEach((e) => { if (!seenErrors.has(e)) { seenErrors.add(e); toast("Could not index " + e, "err"); } });
}
const pauseResume = () => api("/api/index/control", { json: { action: state.status.indexing.paused ? "resume" : "pause" } }).then(poll, fail);
$("#jobPause").addEventListener("click", pauseResume);
$("#jobBtn").addEventListener("click", () => go("library"));
$("#jobCancel").addEventListener("click", () => {
  if (confirm("Stop indexing and clear the waiting list?\n\nVideos that already finished stay in your footage."))
    api("/api/index/control", { json: { action: "cancel" } }).then(() => { poll(); refreshVideos(true); }, fail);
});

/* ═════════════════════════════ first run ═════════════════════════════ */
function renderSetup(st) {
  const d = st.download;
  $("#dlBar").hidden = !(d.active || d.error);
  $("#dlBtn").disabled = d.active;
  if (d.active) {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("#dlFill").style.width = pct + "%";
    $("#dlText").textContent = d.total ? `Downloading… ${fmtSize(d.done)} of ${fmtSize(d.total)}` : "Starting…";
  } else $("#dlText").textContent = d.error ? `Download failed: ${d.error}. Check your connection and try again.` : "";
}
$("#dlBtn").addEventListener("click", () => api("/api/models/download", { json: { quality: $("input[name=q]:checked").value } }).then(poll, fail));

/* ═════════════════════════════ frames ═════════════════════════════ */
let previewTimer = null;
function stopPreview(el) {
  clearTimeout(previewTimer);
  const v = el && el.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); v.remove(); }
  if (el) el.classList.remove("previewing");
}
function startPreview(el, videoId, ts) {
  if (!prefs.hover || matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!el.matches(":hover") || el.querySelector("video")) return;
    const v = h("video", { muted: true, playsinline: true, preload: "auto" });
    v.muted = true;
    v.src = `/api/video/${videoId}#t=${Math.max(0, ts / 1000 - 0.3).toFixed(1)}`;
    v.onerror = () => stopPreview(el);
    v.onplaying = () => el.classList.add("previewing");
    el.prepend(v);
    v.play().catch(() => stopPreview(el));
  }, 450);
}
const isSaved = (videoId, ts) => state.saved.some((s) => s.video_id === videoId && Math.abs(s.ts_ms - ts) < 1000);

/** A frame of footage. With a score it shows a big colour-coded numeral. */
function frm(o) {
  const hasScore = o.pct != null;
  const f = h(o.onClick ? "button" : "div", { class: "frm" + (o.cls ? " " + o.cls : "") + (o.missing ? " missing" : "") + (o.thumb ? "" : " ph"), type: o.onClick ? "button" : null, disabled: o.missing || null,
      "aria-label": o.aria || null, style: hasScore ? { "--pc": pcColor(o.pct) } : null },
    o.thumb ? img(thumbUrl(o.thumb.id, o.thumb.ts, o.thumb.w || 560)) : icon(o.icon || "film"),
    o.tc ? h("span", { class: "tc" }, o.tc) : null,
    o.starred ? h("span", { class: "star" }, icon("star")) : null,
    hasScore ? h("span", { class: "nm" }, h("span", { class: "n", "data-to": Math.round(o.pct) }, String(Math.round(o.pct)), h("sup", {}, "%")), o.verdict ? h("span", { class: "v" }, o.verdict) : null) : null,
    hasScore ? h("span", { class: "expo", style: { width: Math.round(o.pct) + "%" } }) : null,
    o.thumb && o.onClick && !o.missing ? h("span", { class: "playb" }, icon("play")) : null);
  if (o.onClick && !o.missing) {
    f.addEventListener("click", o.onClick);
    if (o.thumb) { f.addEventListener("mouseenter", () => startPreview(f, o.thumb.id, o.thumb.ts)); f.addEventListener("mouseleave", () => stopPreview(f)); }
  }
  return f;
}

/** A row of bars: how strongly a video matches along its length, coloured by strength. */
function heatBars(container, heat) {
  const hs = heat || [];
  if (!hs.length) { fill(container); return; }
  const lo = Math.min(...hs), hi = Math.max(...hs), sp = Math.max(1, hi - lo);
  fill(container, hs.map((p, i) => {
    const rel = Math.pow((p - lo) / sp, 1.35);
    return h("i", { style: { height: `${Math.round(8 + 92 * rel)}%`, background: p < 22 ? "var(--line2)" : pcColor(p), opacity: p < 22 ? 1 : (0.5 + 0.5 * rel).toFixed(2), animationDelay: `${Math.min(i * 9, 600)}ms` } });
  }));
}
const emptyState = (title, text, action) => h("div", { class: "empty" }, h("h2", { class: "serif" }, title), h("p", { class: "muted" }, text), action || null);
const scanning = (label = "Scanning the footage") => h("div", { class: "scan" }, h("div", { class: "box" }), h("p", {}, label + "…"));

/* ═════════════════════════════ search box ═════════════════════════════ */
const historyList = () => store.get("history", []);
function remember(q) { if (q) store.set("history", [q, ...historyList().filter((x) => x !== q)].slice(0, 10)); }
const SG = { items: [], i: -1 };

/** True when a word in the text starts with what was typed (so "t" does not match every title with a t inside). */
const startsWord = (text, lc) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.startsWith(lc));
function buildSuggestions() {
  const val = $("#q").value.trim(), lc = val.toLowerCase(), items = [];
  historyList().filter((x) => x.toLowerCase() !== lc && (!lc || startsWord(x, lc))).slice(0, lc ? 4 : 6).forEach((t) => items.push({ icon: "clock", label: t, run: () => runSearch(t) }));
  if (lc.length >= 2) {
    (state.concepts || []).filter((c) => startsWord(c.label, lc)).slice(0, 3).forEach((c) => items.push({ thumb: thumbUrl(c.cover.video_id, c.cover.ts_ms, 120), label: c.label, hint: "topic", run: () => runSearch(c.query) }));
    state.videos.filter((v) => v.status === "ready" && startsWord(v.name, lc)).slice(0, 3).forEach((v) => items.push({ thumb: thumbUrl(v.id, v.poster_ms, 120), label: v.name, hint: "video", run: () => openWatch(wholeCtx(v)) }));
  }
  return items;
}
function showSuggestions() {
  const box = $("#sugg");
  SG.items = buildSuggestions(); SG.i = -1;
  if (!SG.items.length || document.activeElement !== $("#q")) { box.hidden = true; $("#q").setAttribute("aria-expanded", "false"); return; }
  fill(box, SG.items.map((it, k) => h("button", { type: "button", role: "option", "data-k": k, onmousedown: (e) => { e.preventDefault(); pickSuggestion(k); } },
    it.thumb ? img(it.thumb) : icon(it.icon), span(it.label), it.hint ? h("small", {}, it.hint) : null)));
  box.hidden = false; $("#q").setAttribute("aria-expanded", "true");
}
function markSuggestion(i) { SG.i = i; $$("#sugg button").forEach((b, k) => b.classList.toggle("on", k === i)); }
function pickSuggestion(k) { const it = SG.items[k]; $("#sugg").hidden = true; if (it) it.run(); }

$("#q").addEventListener("input", () => { $("#clearQ").hidden = !$("#q").value; showSuggestions(); instant(); });
$("#q").addEventListener("focus", () => { stopTypewriter(); showSuggestions(); });
$("#q").addEventListener("blur", () => { setTimeout(() => ($("#sugg").hidden = true), 120); startTypewriter(); });
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("#sugg").hidden = true; $("#q").blur(); }
  else if (e.key === "ArrowDown" && !$("#sugg").hidden) { e.preventDefault(); markSuggestion((SG.i + 1) % SG.items.length); }
  else if (e.key === "ArrowUp" && !$("#sugg").hidden) { e.preventDefault(); markSuggestion((SG.i - 1 + SG.items.length) % SG.items.length); }
  else if (e.key === "Enter" && SG.i >= 0 && !$("#sugg").hidden) { e.preventDefault(); pickSuggestion(SG.i); }
});
$("#q").addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); imageSearch(f); } });
$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); $("#sugg").hidden = true; runSearch($("#q").value); });
$("#clearQ").addEventListener("click", () => { $("#q").value = ""; $("#clearQ").hidden = true; $("#q").focus(); });
$("#imgBtn").addEventListener("click", () => $("#imgInput").click());
$("#imgInput").addEventListener("change", (e) => { imageSearch(e.target.files[0]); e.target.value = ""; });
const instant = debounce(() => {
  const q = $("#q").value.trim();
  if (prefs.instant && state.view === "search" && state.results && q.length >= 3 && state.status && state.status.ready) doSearch(q, false);
}, 340);
$("#brand").addEventListener("click", (e) => { e.preventDefault(); clearSearch(); go("search"); });
$$(".tabs a[data-tab=search]").forEach((a) => a.addEventListener("click", () => clearSearch()));

/* a typewriter that suggests things to look for */
let twTimer = null, twIndex = 0;
const TW_DEFAULT = ["a red car at night", "two people laughing", "a dog running on a beach", "someone writing on a whiteboard", "fireworks over water", "a close-up of a face", "a crowd cheering"];
function typewriterLines() { const cs = (state.concepts || []).map((c) => c.query); return cs.length ? cs : TW_DEFAULT; }
function stopTypewriter() { clearTimeout(twTimer); twTimer = null; $("#q").placeholder = "Describe a scene…"; }
function startTypewriter() {
  if (twTimer || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const q = $("#q");
  if (!document.body.classList.contains("is-home") || q.value || document.activeElement === q) return;
  const lines = typewriterLines(), line = lines[twIndex++ % lines.length];
  let n = 0;
  const type = () => {
    if (!document.body.classList.contains("is-home") || q.value || document.activeElement === q) { twTimer = null; q.placeholder = "Describe a scene…"; return; }
    q.placeholder = line.slice(0, ++n) + (n < line.length ? "▍" : "");
    if (n < line.length) twTimer = setTimeout(type, 50 + Math.random() * 40);
    else twTimer = setTimeout(() => { twTimer = null; startTypewriter(); }, 2300);
  };
  twTimer = setTimeout(type, 500);
}

/* ═════════════════════════════ seek: home ═════════════════════════════ */
function clearSearch() {
  state.results = null; state.searchSeq++; state.scroll = 0;
  $("#q").value = ""; $("#clearQ").hidden = true;
  if (state.view === "search") { placeSearch(); renderSearchPage(); }
}

function renderSearchPage() {
  const searching = !!state.results;
  placeSearch();
  $("#home").hidden = searching; $("#found").hidden = !searching;
  if (searching) { stopTypewriter(); renderResults(); return; }
  const st = state.status;
  const ready = state.videos.filter((v) => v.status === "ready");
  const cs = state.concepts || [];
  fill($("#topicChips"), h("span", { class: "lbl" }, "Try"),
    cs.length ? cs.slice(0, 8).map((c, i) => h("button", { class: "pill", type: "button", style: { animationDelay: `${300 + i * 55}ms` }, onclick: () => runSearch(c.query) }, img(thumbUrl(c.cover.video_id, c.cover.ts_ms, 90)), c.label))
      : TW_DEFAULT.slice(0, 5).map((t, i) => h("button", { class: "pill plain", type: "button", style: { animationDelay: `${300 + i * 55}ms` }, onclick: () => runSearch(t) }, t)));
  renderRibbon(ready);
  const s = st && st.stats;
  $("#ticker").hidden = !(s && s.videos);
  if (s && s.videos) fill($("#ticker"), [[s.videos, s.videos === 1 ? "film" : "films"], [fmtDur(s.seconds), "of footage"], [s.frames.toLocaleString(), "moments indexed"], ["0", "bytes uploaded"]].map(([a, b]) => span(h("b", {}, a), b)));
  $("#homeEmpty").hidden = !(!ready.length && !(st && (st.indexing.current || st.indexing.pending)) && st && st.ready);
  if (st && st.ready && st.stats.videos && !state.concepts && !state.conceptsLoading) loadConcepts();
  startTypewriter();
}

/** Two slow rivers of frames from the user's own footage. */
let ribbonKey = "";
function renderRibbon(ready) {
  const box = $("#ribbon");
  box.hidden = !ready.length;
  if (!ready.length) { ribbonKey = ""; return; }
  const key = ready.map((v) => v.id).join(",");
  if (key === ribbonKey) return;
  ribbonKey = key;
  const frames = [];
  const per = Math.max(4, Math.min(8, Math.ceil(28 / ready.length)));
  ready.slice(0, 8).forEach((v, vi) => { for (let k = 0; k < per; k++) frames.push({ id: v.id, ts: ((k + 0.5 + (vi % 2) * 0.25) / per) * v.duration * 1000 }); });
  for (let i = frames.length - 1; i > 0; i--) { const j = (i * 7919 + 13) % (i + 1); [frames[i], frames[j]] = [frames[j], frames[i]]; }   // a fixed shuffle, so reloads look the same
  const a = frames.filter((_, i) => i % 2 === 0), b = frames.filter((_, i) => i % 2 === 1);
  const row = (list) => [...list, ...list].map((f) => h("div", { class: "rf" }, img(thumbUrl(f.id, f.ts, 420))));
  fill($("#ribA"), row(a)); fill($("#ribB"), row(b.length ? b : a));
}

function renderScopes() {
  const sel = $("#scope"), keep = sel.value;
  const folders = state.status ? state.status.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready").sort((a, b) => a.name.localeCompare(b.name));
  fill(sel, h("option", { value: "" }, "All footage"),
    folders.length ? h("optgroup", { label: "Folders" }, folders.map((f) => h("option", { value: "f:" + f }, baseName(f)))) : null,
    ready.length ? h("optgroup", { label: "Videos" }, ready.map((v) => h("option", { value: "v:" + v.id }, v.name))) : null);
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}
function scopeParams(params) {
  const v = $("#scope").value;
  if (v.startsWith("v:")) params.set("video_ids", v.slice(2));
  if (v.startsWith("f:")) params.set("folder", v.slice(2));
}

/* ═════════════════════════════ seek: results ═════════════════════════════ */
function runSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  $("#q").value = q; $("#clearQ").hidden = false;
  go("search");
  doSearch(q, true);
}

function showLoading() {
  $("#home").hidden = true; $("#found").hidden = false; placeSearch();
  if (!state.results || state.results.pending) fill($("#results"), scanning());
  else $("#results").style.opacity = ".4";
}

async function doSearch(q, record) {
  q = (q || "").trim();
  if (!q) return;
  const seq = ++state.searchSeq;
  if (!state.results) state.results = { results: [], pending: true, kind: "text", label: q };
  showLoading();
  const params = new URLSearchParams({ q, k: 40, per_video: prefs.per, min_percent: state.minMatch });
  scopeParams(params);
  try {
    const data = await api("/api/search?" + params);
    if (seq !== state.searchSeq) return;
    if (record) remember(q);
    state.results = { ...data, kind: "text", label: q };
    renderTerms(data.terms, data.excluded);
    if (state.view === "search") renderSearchPage();
  } catch (e) {
    if (seq !== state.searchSeq) return;
    $("#results").style.opacity = "";
    if (state.results && state.results.pending) { state.results = null; renderSearchPage(); }
    fail(e);
  }
}

function renderTerms(pos, neg) {
  const box = $("#terms");
  const show = (pos && pos.length > 1) || (neg && neg.length);
  box.hidden = !show;
  if (show) fill(box, span("looking for"), pos.map((t) => h("span", { class: "term" }, t)), neg.length ? [span("without"), neg.map((t) => h("span", { class: "term neg" }, t))] : null);
}

async function imageSearch(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Choose an image file.", "err");
  go("search");
  const seq = ++state.searchSeq;
  state.results = { results: [], pending: true, kind: "image", label: "your image" };
  $("#terms").hidden = true; showLoading();
  const form = new FormData(); form.append("file", file);
  try {
    const data = await api("/api/search/image", { form });
    if (seq !== state.searchSeq) return;
    state.results = { ...data, kind: "image", label: "your image" };
    renderSearchPage();
  } catch (e) { state.results = null; renderSearchPage(); fail(e); }
}

async function similarTo(videoId, ts, name) {
  go("search");
  const seq = ++state.searchSeq;
  state.results = { results: [], pending: true, kind: "similar", label: "" };
  $("#terms").hidden = true; $("#q").value = ""; $("#clearQ").hidden = true; showLoading();
  try {
    const data = await api(`/api/similar?video_id=${videoId}&ts_ms=${ts}&k=40`);
    if (seq !== state.searchSeq) return;
    state.results = { ...data, kind: "similar", label: `${name} at ${fmtTime(ts)}` };
    renderSearchPage();
  } catch (e) { state.results = null; renderSearchPage(); fail(e); }
}

function sortedResults() {
  const rs = [...state.results.results];
  const by = $("#sortBy").value;
  if (by === "name") rs.sort((a, b) => a.name.localeCompare(b.name));
  if (by === "added") rs.sort((a, b) => (b.added || 0) - (a.added || 0));
  if (by === "duration") rs.sort((a, b) => b.duration - a.duration);
  return rs;
}
function resultCtx(r, index) {
  return { video_id: r.video_id, name: r.name, duration: r.duration, moments: r.moments.map((m) => ({ ...m })), heat: r.heat || [], index: Math.max(0, index),
    query: state.results && state.results.kind === "text" ? $("#q").value.trim() : "" };
}

function renderResults() {
  const R = state.results, el = $("#results");
  el.style.opacity = "";
  $$("#matchChips button").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.minMatch));
  $$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
  $("#resKicker").textContent = { text: "Seeking", image: "Frames that look like", similar: "Moments like" }[R.kind];
  fill($("#resTitle"), R.kind === "text" ? [h("span", { class: "q" }, "“"), R.label, h("span", { class: "q" }, "”")] : R.label);
  if (R.pending) { $("#summary").textContent = ""; return; }
  const minPct = R.kind === "text" ? 0 : state.minMatch;      // text searches are filtered by the server already
  const rs = sortedResults().map((r) => ({ ...r, moments: r.moments.filter((m) => m.score >= minPct) })).filter((r) => r.moments.length);
  $("#exportBtn").hidden = !rs.length;
  const total = rs.reduce((n, r) => n + r.moments.length, 0);
  fill($("#summary"), rs.length ? [h("b", {}, plural(total, "moment")), `   ${plural(rs.length, "video")}`, R.took_ms != null ? `   ${R.took_ms} ms` : ""] : null);
  if (!rs.length) {
    const hasVideos = state.status && state.status.stats.videos;
    fill(el, emptyState("Nothing in frame.",
      !hasVideos ? "There are no indexed videos yet." : state.minMatch ? "Nothing is that strong a match. Show any match, or describe it differently." : "Try describing it differently, or search all footage.",
      state.minMatch ? h("button", { class: "btn solid", type: "button", onclick: () => setMinMatch(0) }, "Show any match") : null));
    return;
  }
  if (prefs.view === "moments") {
    const all = rs.flatMap((r) => r.moments.map((m) => ({ r, m })));
    if ($("#sortBy").value === "score") all.sort((a, b) => b.m.score - a.m.score);
    fill(el, h("div", { class: "gcards" }, all.map(({ r, m }, i) => {
      const open = () => openWatch(resultCtx(r, r.moments.findIndex((x) => x.ts_ms === m.ts_ms)));
      return h("div", { class: "gcard", style: { animationDelay: `${Math.min(i, 12) * 40}ms`, "--pc": pcColor(m.score) } },
        frm({ thumb: { id: r.video_id, ts: m.ts_ms }, tc: fmtTime(m.ts_ms), pct: m.score, verdict: verdict(m.score), starred: isSaved(r.video_id, m.ts_ms), onClick: open, aria: `Play ${r.name} at ${fmtTime(m.ts_ms)}` }),
        h("div", { class: "gname", onclick: open }, r.name), h("div", { class: "gmeta" }, span(fmtDur(r.duration)), span(fmtTime(m.ts_ms))));
    })));
  } else fill(el, rs.map((r, i) => resultRow(r, i, rs.length)));
  $$("#results .big-frm .n").forEach(countUp);
}

/** One video as an editorial spread: the best frame large, its takes tabulated beside it. */
function resultRow(r, i, count) {
  const best = r.moments[0];
  const open = (k) => openWatch(resultCtx(r, k));
  const bar = h("div", { class: "heat", title: "Where it matches in the video. Click to jump there." });
  heatBars(bar, r.heat);
  bar.addEventListener("click", (e) => {
    const frac = (e.clientX - bar.getBoundingClientRect().left) / bar.clientWidth;
    openWatch({ ...resultCtx(r, 0), startAt: frac * r.duration * 1000, startSeek: true });
  });
  return h("article", { class: "rrow", style: { animationDelay: `${Math.min(i, 6) * 90}ms`, "--pc": pcColor(best.score) } },
    h("div", { class: "rleft" },
      frm({ thumb: { id: r.video_id, ts: best.ts_ms, w: 900 }, tc: fmtTime(best.ts_ms), pct: best.score, verdict: verdict(best.score), starred: isSaved(r.video_id, best.ts_ms), cls: "big-frm", onClick: () => open(0), aria: `Play ${r.name} at ${fmtTime(best.ts_ms)}` }),
      r.moments.length > 1 ? h("div", { class: "minis" }, r.moments.slice(1).map((m, k) => frm({ thumb: { id: r.video_id, ts: m.ts_ms, w: 360 }, tc: fmtTime(m.ts_ms), pct: m.score, starred: isSaved(r.video_id, m.ts_ms), onClick: () => open(k + 1), aria: `Play ${r.name} at ${fmtTime(m.ts_ms)}` }))) : null),
    h("div", { class: "rmeta" },
      h("div", { class: "idx" }, `${pad(i + 1)} / ${pad(count)}`),
      h("div", { class: "title", onclick: () => open(0) }, r.name),
      h("div", { class: "facts" }, span(fmtDur(r.duration)), span(plural(r.moments.length, "take")), span(`added ${ago(r.added || 0)}`)),
      h("div", { class: "verdict" }, `${verdict(best.score)} match`),
      h("div", { class: "rtable" }, r.moments.map((m, k) => h("button", { class: "rt", type: "button", style: { "--pc": pcColor(m.score) }, onclick: () => open(k) },
        span(fmtTime(m.ts_ms)), h("span", { class: "bar" }, h("i", { style: { width: Math.round(m.score) + "%" } })), h("span", { class: "p" }, Math.round(m.score) + "%")))),
      h("div", { class: "track" }, h("div", { class: "track-l" }, span("match along the film"), span(fmtTime(r.duration * 1000))), bar),
      h("button", { class: "open-link", type: "button", onclick: () => open(0) }, "Open in the screening room", icon("up-right"))));
}

function setMinMatch(v) {
  state.minMatch = +v;
  $$("#matchChips button").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.minMatch));
  if (state.results && state.results.kind === "text") doSearch($("#q").value); else if (state.results) renderResults();
}
$("#matchChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMinMatch(b.dataset.v); });
$("#scope").addEventListener("change", () => { if (state.results && state.results.kind === "text") doSearch($("#q").value); });
$("#sortBy").addEventListener("change", () => state.results && renderResults());
$("#viewMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("view", b.dataset.v); if (state.results) renderResults(); } });

function download(name, text, type = "text/csv") {
  const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csv = (rows) => "﻿" + rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
$("#exportBtn").addEventListener("click", () => {
  const rows = [["video", "time", "seconds", "match_percent"]];
  sortedResults().forEach((r) => r.moments.forEach((m) => rows.push([r.name, fmtTime(m.ts_ms), Math.round(m.ts_ms / 1000), m.score])));
  download("sceneseek-results.csv", csv(rows));
});

/* ═════════════════════════════ screening room ═════════════════════════════ */
const P = { ctx: null, pending: null, i: 0, dur: 0, tab: "matches", more: null, info: null, token: 0, uid: 0 };
const pv = () => $("#pVideo");
const watching = () => state.view === "watch";
const wholeCtx = (v, startAt = 0) => ({ video_id: v.id, name: v.name, duration: v.duration, moments: [], heat: [], index: 0, startAt, startSeek: true, query: "" });

function openWatch(ctx) {
  P.pending = ctx;
  const target = `#watch/${ctx.video_id}`;
  if (location.hash.split("?")[0] === target) route(); else location.hash = target;
}
async function enterWatch(id, params) {
  let ctx = P.pending && P.pending.video_id === id ? P.pending : null;
  P.pending = null;
  if (!ctx) {
    try { ctx = wholeCtx(await api(`/api/videos/${id}`), params.get("t") ? +params.get("t") : 0); }
    catch { toast("That video is not in your footage any more.", "err"); go("search"); return; }
  }
  startWatch(ctx);
}

function startWatch(ctx) {
  const token = ++P.token;
  P.ctx = ctx; P.i = Math.min(ctx.index || 0, Math.max(0, ctx.moments.length - 1)); P.dur = (ctx.duration || 0) * 1000;
  P.tab = "matches"; P.more = null; P.info = null;
  const v = pv();
  $("#pErr").hidden = true;
  $("#pName").textContent = ctx.name; document.title = `${ctx.name} · Sceneseek`;
  $("#pQ").value = ctx.query || "";
  $$("#pSpeed button").forEach((b) => b.classList.toggle("on", b.dataset.v === "1"));
  v.playbackRate = 1;
  renderWatchMeta(); renderTabs(); renderWatchSide(); renderTimeline(); setAmbient();
  api(`/api/videos/${ctx.video_id}`).then((info) => { if (P.token === token) { P.info = info; renderWatchMeta(); } }).catch(() => {});
  v.src = `/api/video/${ctx.video_id}`;
  v.onloadedmetadata = () => {
    if (P.token !== token) return;
    if (!P.dur && v.duration) { P.dur = v.duration * 1000; renderTimeline(); }
    const start = ctx.startSeek ? ctx.startAt || 0 : ctx.moments[P.i] ? ctx.moments[P.i].ts_ms - 500 : 0;
    v.currentTime = Math.max(0, start / 1000);
    v.play().catch(() => {});
  };
  v.onerror = () => { $("#pErrTime").textContent = fmtTime(ctx.moments[P.i] ? ctx.moments[P.i].ts_ms : 0); $("#pErr").hidden = false; };
  v.ontimeupdate = onTime;
  v.load();
}
function stopWatch() {
  P.token++;
  const v = pv();
  v.pause(); v.removeAttribute("src"); v.load();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  document.title = "Sceneseek";
}
$("#wBack").addEventListener("click", goBack);
/** The glow behind the screen takes the colour of the take you are on. */
function setAmbient() {
  const m = P.ctx && P.ctx.moments[P.i];
  $(".screen").style.setProperty("--amb", m && m.score != null ? `color-mix(in srgb, ${pcColor(m.score)} 60%, transparent)` : "transparent");
}

function renderWatchMeta() {
  const c = P.ctx, i = P.info;
  const bits = [fmtDur(c.duration)];
  if (i && i.width) bits.push(`${i.width}×${i.height}`);
  if (i && i.size) bits.push(fmtSize(i.size));
  if (c.moments.some((m) => m.score != null)) bits.push(plural(c.moments.length, "take"));
  $("#pMeta").textContent = bits.join("   ·   ");
  const kept = state.saved.filter((s) => s.video_id === c.video_id).length;
  fill($("#pInfo"), h("div", {}, h("b", {}, i ? plural(i.frames, "moment") : "…"), " indexed in this film", kept ? `   ·   ${kept} on your reel` : ""), i ? h("div", {}, i.path) : null);
  updateSaveBtn();
}

/** One take: thumbnail, a big colour-coded numeral and a timecode. */
function take({ videoId, ts, title, pct, sub, on, onClick, i = 0 }) {
  return h("button", { class: "take" + (on ? " on" : ""), type: "button", style: { "--pc": pct != null ? pcColor(pct) : null, animationDelay: `${Math.min(i, 8) * 45}ms` }, onclick: onClick },
    frm({ thumb: { id: videoId, ts, w: 360 }, tc: fmtTime(ts) }),
    h("span", {}, pct != null ? h("div", { class: "n" }, String(Math.round(pct)), h("sup", {}, "%")) : null,
      title ? h("div", { class: "note" }, title) : null, h("div", { class: "t" }, fmtTime(ts)), h("div", { class: "s" }, sub)));
}
function renderTabs() { $$("#wTabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === P.tab)); }
function renderWatchSide() {
  const c = P.ctx, list = $("#wList");
  renderTabs();
  if (P.tab === "matches") {
    if (!c.moments.length) return fill(list, h("p", { class: "un-empty" }, c.query ? "No takes match that in this film. Try other words." : "Describe something above to find its takes in this film."));
    fill(list, c.moments.map((m, k) => take({ videoId: c.video_id, ts: m.ts_ms, pct: m.score, sub: m.score != null ? verdict(m.score) + " match" : "Take", on: k === P.i, onClick: () => seekMoment(k), i: k })));
  } else if (P.tab === "saved") {
    const mine = state.saved.filter((s) => s.video_id === c.video_id).sort((a, b) => a.ts_ms - b.ts_ms);
    if (!mine.length) return fill(list, h("p", { class: "un-empty" }, "Nothing kept from this film yet. Press S to keep the current moment."));
    fill(list, mine.map((s, k) => take({ videoId: c.video_id, ts: s.ts_ms, title: s.note || null, pct: null, sub: "On your reel", onClick: () => { pv().currentTime = s.ts_ms / 1000; pv().play().catch(() => {}); }, i: k })));
  } else {
    if (!P.more) { fill(list, scanning("Finding similar footage")); loadMore(); return; }
    if (!P.more.length) return fill(list, h("p", { class: "un-empty" }, "Nothing similar found in your other footage."));
    fill(list, P.more.map((r, k) => { const m = r.moments[0]; return take({ videoId: r.video_id, ts: m.ts_ms, title: r.name, pct: m.score, sub: verdict(m.score) + " match", onClick: () => openWatch(resultCtx(r, 0)), i: k }); }));
  }
}
async function loadMore() {
  const token = P.token, c = P.ctx;
  try {
    const r = await api(`/api/similar?video_id=${c.video_id}&ts_ms=${currentTs()}&k=12`);
    if (P.token !== token) return;
    P.more = r.results.slice(0, 12);
    if (P.tab === "more") renderWatchSide();
  } catch { if (P.token === token) { P.more = []; if (P.tab === "more") renderWatchSide(); } }
}
$("#wTabs").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  P.tab = b.dataset.tab; if (P.tab === "more") P.more = null;
  renderWatchSide();
});

/** A smooth path through the points (Catmull-Rom converted to Béziers). */
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(2)},${c1[1].toFixed(2)} ${c2[0].toFixed(2)},${c2[1].toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}
/** The match curve: how strongly each moment of the film matches, drawn in spectrum colour. */
function buildChart(heat) {
  const ns = "http://www.w3.org/2000/svg", id = ++P.uid, n = heat.length;
  const lo = Math.min(...heat), hi = Math.max(...heat), sp = Math.max(1, hi - lo);
  const pts = heat.map((p, i) => [(i / (n - 1)) * 100, 36 - Math.pow((p - lo) / sp, 1.15) * 30 - 2]);
  const line = smoothPath(pts), area = `${line}L100,40L0,40Z`;
  const stops = heat.map((p, i) => `<stop offset="${((i / (n - 1)) * 100).toFixed(1)}%" stop-color="${pcColor(p)}"/>`).join("");
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 40"); svg.setAttribute("preserveAspectRatio", "none");
  svg.innerHTML = `<defs><linearGradient id="cg${id}" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>
    <linearGradient id="cf${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <mask id="cm${id}"><rect width="100" height="40" fill="url(#cf${id})"/></mask></defs>
    <g stroke="currentColor" stroke-opacity=".09" stroke-width=".25" vector-effect="non-scaling-stroke"><path d="M0 12H100M0 24H100" vector-effect="non-scaling-stroke"/></g>
    <path d="${area}" fill="url(#cg${id})" mask="url(#cm${id})" opacity=".55"/>
    <path d="${line}" fill="none" stroke="url(#cg${id})" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
  return svg;
}
/** The timeline: the curve above a strip of real frames, with a flag at every take. */
function renderTimeline() {
  const c = P.ctx, strip = $("#pStrip"), chart = $("#pChart");
  const width = $("#pTimeline").clientWidth || 900, dur = P.dur || (c.duration || 0) * 1000;
  const n = Math.max(4, Math.min(18, Math.round(width / 118)));
  fill(strip, dur ? Array.from({ length: n }, (_, k) => img(thumbUrl(c.video_id, ((k + 0.5) / n) * dur, 220))) : []);
  fill(chart, c.heat && c.heat.length > 3 ? buildChart(c.heat) : h("div", { class: "hint mono", style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--faint)", fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".14em" } }, "Seek inside this video to see where it matches"));
  const d = dur || 1;
  fill($("#pMarks"), c.moments.map((m, k) => (m.score == null ? null : (() => {
    const b = h("b", { style: { left: `${Math.min(97, Math.max(3, (m.ts_ms / d) * 100))}%`, "--pc": pcColor(m.score) }, title: `${fmtTime(m.ts_ms)} · ${Math.round(m.score)}%`, class: k === P.i ? "on" : "" }, `${Math.round(m.score)}%`);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); seekMoment(k); });
    return b;
  })())));
}
addEventListener("resize", debounce(() => { if (watching() && P.ctx) renderTimeline(); }, 250));
function seekMoment(k) {
  const m = P.ctx.moments[k];
  if (!m) return;
  P.i = k;
  pv().currentTime = Math.max(0, m.ts_ms / 1000 - 0.5);
  pv().play().catch(() => {});
  if (P.tab === "matches") $$("#wList .take").forEach((el, j) => el.classList.toggle("on", j === k));
  $$("#pMarks b").forEach((el, j) => el.classList.toggle("on", j === k));
  setAmbient(); updateSaveBtn();
}
function onTime() {
  const v = pv(), now = v.currentTime * 1000, dur = P.dur || v.duration * 1000 || 1;
  $("#pHead").style.left = `${Math.min(100, (now / dur) * 100)}%`;
  $("#pTimeNow").textContent = `${fmtTime(now)} / ${fmtTime(dur)}`;
}
function currentTs() { return Math.round(pv().currentTime * 1000) || (P.ctx && P.ctx.moments[P.i] ? P.ctx.moments[P.i].ts_ms : 0); }

const tl = $("#pTimeline");
let scrubbing = false;
const tlTime = (e) => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (P.dur || pv().duration * 1000 || 0); };
tl.addEventListener("pointerdown", (e) => { scrubbing = true; tl.setPointerCapture(e.pointerId); pv().currentTime = tlTime(e) / 1000; });
tl.addEventListener("pointermove", (e) => {
  const tip = $("#pTip"), r = tl.getBoundingClientRect();
  tip.hidden = false; tip.textContent = fmtTime(tlTime(e)); tip.style.left = `${e.clientX - r.left}px`;
  if (scrubbing) pv().currentTime = tlTime(e) / 1000;
});
tl.addEventListener("pointerup", () => { scrubbing = false; pv().play().catch(() => {}); });
tl.addEventListener("pointerleave", () => ($("#pTip").hidden = true));

const savedAt = (videoId, ts) => state.saved.find((s) => s.video_id === videoId && Math.abs(s.ts_ms - ts) < 1000);
function saveTarget() {
  const m = P.ctx.moments[P.i], now = currentTs();
  return m && Math.abs(now - m.ts_ms) < 4000 ? m.ts_ms : now;      // the selected moment, unless you have moved on
}
function updateSaveBtn() {
  if (!P.ctx || !watching()) return;
  const on = !!savedAt(P.ctx.video_id, saveTarget());
  $("#pSave").classList.toggle("on", on);
  $("#pSave span").textContent = on ? "Kept" : "Keep";
}
async function toggleSave() {
  const ts = saveTarget(), existing = savedAt(P.ctx.video_id, ts);
  try {
    if (existing) { await api(`/api/saved/${existing.id}`, { method: "DELETE" }); toast("Taken off your reel"); }
    else {
      await api("/api/saved", { json: { video_id: P.ctx.video_id, ts_ms: ts, note: P.ctx.query || "" } });
      toast(`Kept ${fmtTime(ts)} on your reel`, "ok", { label: "View reel", fn: () => go("saved") });
    }
    await loadSaved();
    renderWatchMeta(); if (P.tab === "saved") renderWatchSide();
  } catch (e) { fail(e); }
}
$("#pSave").addEventListener("click", toggleSave);
$("#pFrame").addEventListener("click", async () => {
  try {
    const r = await api(`/api/videos/${P.ctx.video_id}/save-frame`, { json: { ts_ms: currentTs() } });
    toast("Frame saved to Pictures\\Sceneseek", "ok", { label: "Show", fn: () => api("/api/reveal-path", { json: { path: r.path } }).catch(fail) });
  } catch (e) { fail(e); }
});
$("#pSimilar").addEventListener("click", () => { const c = P.ctx, t = currentTs(); similarTo(c.video_id, t, c.name); });
$("#pCopy").addEventListener("click", () => {
  const text = `${P.ctx.name} @ ${fmtTime(currentTs())}`;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Copied: " + text, "ok"), () => toast(text));
});
$("#pReveal").addEventListener("click", () => api(`/api/videos/${P.ctx.video_id}/reveal`, { method: "POST" }).catch(fail));
const openExternal = () => api(`/api/videos/${P.ctx.video_id}/open`, { method: "POST" }).catch(fail);
$("#pOpen").addEventListener("click", openExternal);
$("#pOpenErr").addEventListener("click", openExternal);
$("#pSpeed").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  pv().playbackRate = +b.dataset.v;
  $$("#pSpeed button").forEach((x) => x.classList.toggle("on", x === b));
});
$("#pSearch").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#pQ").value.trim();
  if (!q) return;
  try {
    const r = await api(`/api/search?${new URLSearchParams({ q, k: 1, per_video: 12, video_ids: P.ctx.video_id })}`);
    const hit = r.results[0];
    P.ctx.query = q; P.ctx.moments = hit ? hit.moments : []; P.ctx.heat = hit ? hit.heat : [];
    P.i = 0; P.tab = "matches";
    renderWatchMeta(); renderWatchSide(); renderTimeline();
    if (hit) seekMoment(0);
  } catch (err) { fail(err); }
});

/* ═════════════════════════════ topics ═════════════════════════════ */
async function loadConcepts() {
  state.conceptsLoading = true;
  try {
    const r = await api("/api/explore");
    state.concepts = r.concepts;
    if (state.view === "search" && !state.results) renderSearchPage();
    return r;
  } catch { return null; } finally { state.conceptsLoading = false; }
}
/* the frame that follows your cursor over the topic index */
const CP = { el: $("#cursorPrev"), img: $("#cursorPrev img"), x: 0, y: 0, tx: 0, ty: 0, raf: 0 };
function cpLoop() {
  CP.x += (CP.tx - CP.x) * 0.16; CP.y += (CP.ty - CP.y) * 0.16;
  const vw = innerWidth, vh = innerHeight, w = 340, hgt = 191;
  const px = Math.min(vw - w - 20, CP.tx + 36), py = Math.max(20, Math.min(vh - hgt - 20, CP.ty - hgt / 2));
  CP.el.style.transform = `translate3d(${CP.x + (px - CP.tx)}px, ${CP.y + (py - CP.ty)}px, 0) rotate(${Math.max(-6, Math.min(6, (CP.tx - CP.x) * 0.05))}deg)`;
  CP.raf = CP.el.classList.contains("on") ? requestAnimationFrame(cpLoop) : 0;
}
function topicRow(c, i) {
  const row = h("button", { class: "ix", type: "button", style: { animationDelay: `${Math.min(i, 16) * 45}ms` }, onclick: () => { CP.el.classList.remove("on"); runSearch(c.query); } },
    span(h("span", { class: "no" }, pad(i + 1))), h("span", { class: "nm" }, c.label), h("span", { class: "ct" }, `${plural(c.frames, "moment")} · ${plural(c.videos, "film")}`), h("span", { class: "go" }, icon("up-right")));
  row.addEventListener("mouseenter", (e) => {
    if (matchMedia("(pointer: coarse)").matches) return;
    CP.img.src = thumbUrl(c.cover.video_id, c.cover.ts_ms, 680);
    if (!CP.el.classList.contains("on")) { CP.x = CP.tx = e.clientX; CP.y = CP.ty = e.clientY; }
    CP.el.classList.add("on"); if (!CP.raf) CP.raf = requestAnimationFrame(cpLoop);
  });
  row.addEventListener("mousemove", (e) => { CP.tx = e.clientX; CP.ty = e.clientY; });
  row.addEventListener("mouseleave", () => CP.el.classList.remove("on"));
  return row;
}
async function loadExplore() {
  const st = state.status;
  if (!st || !st.ready) return;
  if (!st.stats.videos) { fill($("#concepts")); fill($("#stats")); $("#exploreEmpty").hidden = false; return; }
  $("#exploreEmpty").hidden = true;
  renderStats(st.stats);
  if (!state.concepts) fill($("#concepts"), scanning("Reading your footage")); else fill($("#concepts"), state.concepts.map(topicRow));
  const r = await loadConcepts();
  if (!r || state.view !== "explore") return;
  renderStats(r.stats);
  fill($("#concepts"), r.concepts.length ? r.concepts.map(topicRow) : h("p", { class: "muted", style: { padding: "30px 0" } }, "Not enough footage to find topics yet. Add more videos."));
}
function renderStats(s) {
  const t = (v, l) => h("div", { class: "stat" }, h("b", {}, v), span(l));
  fill($("#stats"), t(s.videos.toLocaleString(), s.videos === 1 ? "film" : "films"), t(fmtDur(s.seconds), "of footage"), t(s.frames.toLocaleString(), "moments"), t(state.saved.length.toLocaleString(), "on your reel"));
}

/* ═════════════════════════════ reel (saved) ═════════════════════════════ */
async function loadSaved(render) {
  try {
    const { saved } = await api("/api/saved");
    state.saved = saved;
    $("#savedCount").hidden = !saved.length; $("#savedCount").textContent = saved.length;
    if (render || state.view === "saved") renderSaved();
  } catch { /* retry on next visit */ }
}
function openSaved(s) {
  const same = state.saved.filter((x) => x.video_id === s.video_id).sort((a, b) => a.ts_ms - b.ts_ms);
  openWatch({ video_id: s.video_id, name: s.name, duration: s.duration, heat: [], moments: same.map((x) => ({ ts_ms: x.ts_ms })), index: same.indexOf(s), query: "" });
}
const CLIP_BEFORE = 1000, CLIP_AFTER = 5000;      // each kept moment becomes a six second cut
function timecode(ms, fps) {
  const f = Math.max(1, Math.round(fps || 25));
  const total = Math.round((ms / 1000) * f);
  const fr = total % f, s = Math.floor(total / f);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(fr)}`;
}
function buildEdl(items) {
  const lines = ["TITLE: Sceneseek reel", "FCM: NON-DROP FRAME", ""];
  let rec = 3600 * 1000;       // the record side starts at 01:00:00:00
  items.forEach((s, i) => {
    const fps = s.fps || 25, inMs = Math.max(0, s.ts_ms - CLIP_BEFORE), outMs = Math.min(s.duration ? s.duration * 1000 : Infinity, s.ts_ms + CLIP_AFTER), len = Math.max(outMs - inMs, 1000);
    lines.push(`${pad(i + 1, 3)}  AX       AA/V  C        ${timecode(inMs, fps)} ${timecode(inMs + len, fps)} ${timecode(rec, fps)} ${timecode(rec + len, fps)}`);
    lines.push(`* FROM CLIP NAME: ${s.name}`);
    if (s.note) lines.push(`* COMMENT: ${s.note.replace(/[\r\n]+/g, " ")}`);
    lines.push("");
    rec += len;
  });
  return lines.join("\r\n");
}
const CUT_COLORS = ["#ffd60a", "#ff9f0a", "#2ee6c1", "#a6f04d", "#5ac8fa", "#bf5af2", "#ff3b30"];
function renderSaved() {
  const items = state.saved;
  $("#savedEmpty").hidden = items.length > 0;
  $("#reelActions").hidden = !items.length; $("#sequence").hidden = !items.length;
  const videos = new Set(items.map((s) => s.video_id)).size, total = items.length * (CLIP_BEFORE + CLIP_AFTER);
  $("#reelMeta").textContent = items.length ? `${plural(items.length, "cut")} from ${plural(videos, "film")}   ·   ${timecode(3600 * 1000, 25)} → ${timecode(3600 * 1000 + total, 25)}` : "";
  fill($("#sequence"), h("div", { class: "ruler" }, span("SEQUENCE 01"), span(`${fmtDur(total / 1000)} total`)),
    h("div", { class: "blocks" }, items.map((s, i) => h("button", { class: "blk", type: "button", style: { "--c": CUT_COLORS[i % CUT_COLORS.length] }, title: s.name, onclick: () => { const el = $$(".cut")[i]; if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); } },
      img(thumbUrl(s.video_id, s.ts_ms, 260)), h("i", { class: "c" }), h("b", {}, pad(i + 1) + "  " + fmtTime(s.ts_ms))))));
  fill($("#savedGrid"), items.map((s, i) => {
    const note = h("input", { type: "text", value: s.note || "", placeholder: "Add a note for the edit…", "aria-label": "Note", maxlength: 500 });
    note.addEventListener("change", () => api(`/api/saved/${s.id}`, { method: "PATCH", json: { note: note.value } }).then(() => { s.note = note.value; toast("Note saved", "ok"); }, fail));
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") note.blur(); });
    const fps = s.fps || 25;
    return h("div", { class: "cut", style: { animationDelay: `${Math.min(i, 10) * 60}ms` } },
      h("span", { class: "no" }, pad(i + 1)),
      frm({ thumb: { id: s.video_id, ts: s.ts_ms, w: 600 }, tc: fmtTime(s.ts_ms), missing: !s.available, onClick: s.available ? () => openSaved(s) : null, aria: `Play ${s.name} at ${fmtTime(s.ts_ms)}` }),
      h("div", { class: "cut-body" },
        h("div", { class: "cut-name", title: s.path, onclick: () => s.available && openSaved(s) }, s.name),
        h("div", { class: "cut-tc" }, span(h("em", {}, "IN"), timecode(Math.max(0, s.ts_ms - CLIP_BEFORE), fps)), span(h("em", {}, "OUT"), timecode(s.ts_ms + CLIP_AFTER, fps))),
        !s.available ? h("small", { class: "verr" }, "This video is no longer in your footage") : null, note),
      h("button", { class: "ibtn", type: "button", title: "Remove from reel", "aria-label": "Remove from reel", onclick: () => removeSaved(s) }, icon("trash")));
  }));
}
$("#reelCsv").addEventListener("click", () => {
  const rows = [["video", "time", "seconds", "note", "path"]];
  state.saved.forEach((s) => rows.push([s.name, fmtTime(s.ts_ms), Math.round(s.ts_ms / 1000), s.note, s.path]));
  download("sceneseek-reel.csv", csv(rows));
});
$("#reelEdl").addEventListener("click", () => { download("sceneseek-reel.edl", buildEdl(state.saved), "text/plain"); toast("EDL saved. Import it in Premiere, DaVinci Resolve or Final Cut.", "ok"); });
async function removeSaved(s) {
  try {
    await api(`/api/saved/${s.id}`, { method: "DELETE" });
    await loadSaved(true);
    if (s.video_id) toast("Cut removed", "", { label: "Undo", fn: () => api("/api/saved", { json: { video_id: s.video_id, ts_ms: s.ts_ms, note: s.note } }).then(() => loadSaved(true), fail) });
    else toast("Cut removed");
  } catch (e) { fail(e); }
}

/* ═════════════════════════════ footage ═════════════════════════════ */
async function refreshVideos(force) {
  try {
    const { videos } = await api("/api/videos");
    const key = JSON.stringify(videos.map((v) => [v.id, v.status, v.frames, v.error, v.exists]));
    state.videos = videos;
    if (force || key !== state.videosKey) {
      state.videosKey = key;
      if (state.view === "library") renderLibrary();
      if (state.view === "search" && !state.results) renderSearchPage();
      renderScopes();
    }
  } catch { /* server busy; the next poll retries */ }
}

function renderLibrary() {
  const st = state.status;
  const folders = st ? st.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready");
  $("#libSummary").textContent = ready.length ? `${plural(ready.length, "film")}   ·   ${fmtDur(ready.reduce((a, v) => a + v.duration, 0))}   ·   ${fmtSize(ready.reduce((a, v) => a + v.size, 0))}` : "nothing indexed yet";
  if (state.libFolder && !folders.includes(state.libFolder)) state.libFolder = "";
  fill($("#folderChips"), folders.map((f) => h("span", { class: "pill plain" + (state.libFolder === f ? " on" : ""), title: f, style: { cursor: "pointer" }, onclick: () => { state.libFolder = state.libFolder === f ? "" : f; renderLibrary(); } },
    icon("folder"), baseName(f), h("button", { class: "x", type: "button", "aria-label": "Stop watching " + f, title: "Stop watching this folder", onclick: (e) => { e.stopPropagation(); unwatch(f); } }, "×"))));
  const q = $("#libFilter").value.trim().toLowerCase(), sort = $("#libSort").value, stat = state.libStatus;
  const prefix = state.libFolder ? state.libFolder.replace(/[\\/]+$/, "").toLowerCase() : "";
  const list = state.videos.filter((v) => v.name.toLowerCase().includes(q) &&
    (!prefix || v.path.toLowerCase().startsWith(prefix + "\\") || v.path.toLowerCase().startsWith(prefix + "/")) &&
    (stat === "all" || (stat === "ready" && v.status === "ready") || (stat === "busy" && (v.status === "queued" || v.status === "indexing")) || (stat === "error" && (v.status === "error" || !v.exists))));
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "duration") list.sort((a, b) => b.duration - a.duration);
  if (sort === "size") list.sort((a, b) => b.size - a.size);
  $("#libTools").hidden = !state.videos.length;
  $("#libEmpty").hidden = state.videos.length > 0;
  $("#libNone").hidden = !state.videos.length || list.length > 0;
  $$("#libStatus button").forEach((b) => b.classList.toggle("on", b.dataset.v === stat));
  $$("#libView button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.libView));
  $("#videoGrid").className = "clips " + (prefs.libView === "grid" ? "grid" : "list");
  fill($("#videoGrid"), h("div", { class: "row head-row" }, span(""), span("Film"), span("Length"), span("Resolution"), span("Size"), span("Status"), span("")), list.map(clipRow));
}
$("#libFilter").addEventListener("input", renderLibrary);
$("#libSort").addEventListener("change", renderLibrary);
$("#libStatus").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.libStatus = b.dataset.v; renderLibrary(); } });
$("#libView").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("libView", b.dataset.v); renderLibrary(); } });

function clipRow(v, i) {
  const playable = v.exists && v.frames > 0;
  const label = { ready: "Ready", queued: "Waiting", indexing: "Indexing", error: "Problem" }[v.status] || v.status;
  const cur = state.status && state.status.indexing.current;
  const pct = cur && cur.video_id === v.id ? cur.pct : 0;
  const open = () => openWatch(wholeCtx(v));
  const acts = h("span", { class: "acts" },
    v.exists ? h("button", { class: "ibtn sm", type: "button", title: "Show file", "aria-label": "Show " + v.name + " in its folder", onclick: () => api(`/api/videos/${v.id}/reveal`, { method: "POST" }).catch(fail) }, icon("folder")) : null,
    h("button", { class: "ibtn sm", type: "button", title: "Index again", "aria-label": "Index " + v.name + " again", onclick: () => api(`/api/videos/${v.id}/reindex`, { method: "POST" }).then(() => { toast("Queued again"); poll(); refreshVideos(true); }, fail) }, icon("refresh")),
    h("button", { class: "ibtn sm", type: "button", title: "Remove from footage", "aria-label": "Remove " + v.name, onclick: () => removeVideo(v) }, icon("trash")));
  return h("article", { class: "row", style: { animationDelay: `${Math.min(i, 10) * 40}ms` } },
    frm({ thumb: playable ? { id: v.id, ts: v.poster_ms, w: 400 } : null, icon: v.status === "error" || !v.exists ? "alert" : "film", tc: v.duration ? fmtTime(v.duration * 1000) : "", missing: !playable, onClick: playable ? open : null, aria: `Play ${v.name}` }),
    h("div", {}, h("div", { class: "nm2", onclick: () => playable && open() }, v.name),
      v.error ? h("div", { class: "verr" }, v.error) : null, !v.exists ? h("div", { class: "verr" }, "The file has moved or been deleted") : null,
      v.status === "indexing" || v.status === "queued" ? h("div", { class: "vprog" }, h("i", { "data-prog": v.id, style: { width: pct + "%" } })) : null,
      h("div", { class: "gm mono muted" }, span(fmtDur(v.duration)), v.width ? span(`${v.width}×${v.height}`) : null, span(fmtSize(v.size)))),
    h("span", { class: "c dur" }, v.duration ? fmtTime(v.duration * 1000) : "–"), h("span", { class: "c res" }, v.width ? `${v.width}×${v.height}` : "–"), h("span", { class: "c sz" }, fmtSize(v.size)),
    h("span", { class: "st" }, h("span", { class: `led ${v.status}`, "data-live": v.id }, label)), acts);
}
function updateLiveCards(st) {
  const cur = st.indexing.current;
  if (!cur) return;
  const s = $(`[data-live="${cur.video_id}"]`);
  if (s) { s.textContent = `Indexing ${Math.round(cur.pct)}%`; s.className = "led indexing"; }
  const p = $(`[data-prog="${cur.video_id}"]`);
  if (p) p.style.width = cur.pct + "%";
}
function removeVideo(v) {
  if (!confirm(`Remove “${v.name}” from Sceneseek?\n\nThe video file itself is not deleted.`)) return;
  api(`/api/videos/${v.id}`, { method: "DELETE" }).then(() => { toast("Removed from footage"); refreshVideos(true); poll(); loadSaved(); }, fail);
}
async function unwatch(folder) {
  if (!confirm(`Stop watching this folder for new videos?\n\n${folder}`)) return;
  const removeVideos = confirm("Also remove this folder's videos from Sceneseek?\n\nOK = remove them (your files are never deleted)\nCancel = keep them");
  try { await api(`/api/folders?path=${encodeURIComponent(folder)}&remove_videos=${removeVideos}`, { method: "DELETE" }); if (state.libFolder === folder) state.libFolder = ""; await poll(); refreshVideos(true); } catch (e) { fail(e); }
}

async function queuePaths(paths, watch) {
  try {
    const { queued } = await api("/api/index/paths", { json: { paths, watch } });
    toast(queued ? `Indexing ${plural(queued, "video")}. Seek as soon as the first one finishes.` : "Those videos are already up to date.", queued ? "ok" : "");
    await poll(); refreshVideos(true);
  } catch (e) { fail(e); }
}
async function pickAndQueue(kind) {
  if (state.status && !state.status.ready) return go("search");
  try {
    const { paths } = await api("/api/pick", { json: { kind } });
    if (paths.length) await queuePaths(paths, kind === "folder");
  } catch (e) { fail(e); }
}
const rescan = () => api("/api/rescan", { method: "POST" }).then((r) => { toast(r.queued ? `Found ${plural(r.queued, "new video")}.` : "No new videos found.", r.queued ? "ok" : ""); poll(); }, fail);
$("#addFolder").addEventListener("click", () => pickAndQueue("folder"));
$("#addFiles").addEventListener("click", () => pickAndQueue("files"));
$("#rescan").addEventListener("click", rescan);
document.addEventListener("click", (e) => { if (e.target.closest("[data-act=addFolder]")) pickAndQueue("folder"); });

/* drag and drop anywhere */
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropcover").hidden = false; });
addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dropcover").hidden = true; });
addEventListener("drop", async (e) => {
  dragDepth = 0; $("#dropcover").hidden = true;
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length === 1 && files[0].type.startsWith("image/")) return imageSearch(files[0]);
  if (state.status && !state.status.ready) return toast("Download the search model first.", "err");
  go("library");
  if (window.pywebview) { toast("Adding your videos…"); setTimeout(() => { poll(); refreshVideos(true); }, 900); return; }   // the desktop window indexes dropped files in place
  const local = files.map((f) => f.pywebviewFullPath || f.path).filter(Boolean);
  if (local.length === files.length) return queuePaths(local, false);
  toast(`Copying ${plural(files.length, "file")} into Sceneseek's folder…`);
  const form = new FormData(); files.forEach((f) => form.append("files", f));
  try { const r = await api("/api/index/upload", { form }); toast(`Indexing ${plural(r.queued, "video")}.`, "ok"); poll(); refreshVideos(true); } catch (err) { fail(err); }
});

/* ═════════════════════════════ tune ═════════════════════════════ */
const dedupeLabel = (v) => (v == 0 ? "Off" : v <= 0.3 ? "Low" : v <= 0.6 ? "Medium" : "High");
const setFill = (input) => input.style.setProperty("--fill", `${((input.value - input.min) / (input.max - input.min)) * 100}%`);
function renderSettings() {
  const st = state.status; if (!st) return;
  const c = st.settings;
  $("#pInstant").checked = prefs.instant; $("#pHover").checked = prefs.hover;
  $$("#pPer button").forEach((b) => b.classList.toggle("on", +b.dataset.v === prefs.per));
  $("#sInterval").value = c.interval; $("#oInterval").textContent = `every ${c.interval} s`; setFill($("#sInterval"));
  $("#sDedupe").value = c.dedupe; $("#oDedupe").textContent = dedupeLabel(c.dedupe); setFill($("#sDedupe"));
  $$("#sSpeed button").forEach((b) => b.classList.toggle("on", b.dataset.v === c.speed));
  $$("#sQuality button").forEach((b) => b.classList.toggle("on", b.dataset.v === c.quality));
  $("#modelHelp").textContent = c.quality === "best" ? "You are using the full-precision model: most accurate, slower to index." : "You are using the small, fast model. Best is a little sharper; switching re-indexes your videos.";
  $("#dataDir").textContent = st.data_dir;
  $("#aboutVersion").textContent = "v" + st.version;
  renderModelProgress(st);
}
let pendingQuality = null;
function renderModelProgress(st) {
  const d = st.download, on = d.active;
  $("#mdlBar").hidden = !on;
  if (on) { const pct = d.total ? Math.round((d.done / d.total) * 100) : 0; $("#mdlFill").style.width = pct + "%"; $("#mdlText").textContent = `Downloading the ${d.quality} model… ${pct}%`; }
  else $("#mdlText").textContent = d.error ? "Download failed: " + d.error : "";
  if (!on && pendingQuality && st.models[pendingQuality]) { const q = pendingQuality; pendingQuality = null; applyQuality(q); }
}
let saveTimer;
const saveSetting = (change) => { clearTimeout(saveTimer); saveTimer = setTimeout(() => api("/api/settings", { json: change }).then(poll, fail), 350); };
$("#pInstant").addEventListener("change", (e) => setPref("instant", e.target.checked));
$("#pHover").addEventListener("change", (e) => setPref("hover", e.target.checked));
$("#pPer").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("per", +b.dataset.v); renderSettings(); } });
$("#sInterval").addEventListener("input", (e) => { setFill(e.target); $("#oInterval").textContent = `every ${e.target.value} s`; saveSetting({ interval: +e.target.value }); });
$("#sDedupe").addEventListener("input", (e) => { setFill(e.target); $("#oDedupe").textContent = dedupeLabel(+e.target.value); saveSetting({ dedupe: +e.target.value }); });
$("#sSpeed").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) api("/api/settings", { json: { speed: b.dataset.v } }).then(() => poll().then(renderSettings), fail); });
async function applyQuality(q) {
  if (state.status.stats.frames > 0 && !confirm("Switching the model means all your videos are indexed again. Continue?")) return;
  try { await api("/api/settings", { json: { quality: q, confirm_reindex: true } }); state.concepts = null; toast("Switched. Re-indexing your videos…", "ok"); await poll(); renderSettings(); } catch (e) { fail(e); }
}
$("#sQuality").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const q = b.dataset.v;
  if (q === state.status.settings.quality) return;
  if (state.status.models[q]) return applyQuality(q);
  if (!confirm(`Download the ${q === "best" ? "Best (about 600 MB)" : "Fast (about 150 MB)"} model now?`)) return;
  pendingQuality = q;
  api("/api/models/download", { json: { quality: q } }).then(poll, fail);
});
$("#clearAll").addEventListener("click", () => {
  if (!confirm("Clear the whole index?\n\nYour videos are not deleted, but you will need to add them again.")) return;
  api("/api/clear", { method: "POST" }).then(() => { state.results = null; state.concepts = null; poll(); refreshVideos(true); toast("Index cleared", "ok"); if (state.view === "search") renderSearchPage(); }, fail);
});

/* ═════════════════════════════ command palette ═════════════════════════════ */
const PAL = { items: [], i: 0 };
function openPalette() { $("#palette").hidden = false; $("#palQ").value = ""; renderPalette(); setTimeout(() => $("#palQ").focus(), 10); }
const closePalette = () => { $("#palette").hidden = true; };
function palItems(q) {
  const lc = q.toLowerCase(), out = [];
  const match = (s) => !lc || s.toLowerCase().includes(lc);
  const searchItem = q ? { sec: "Seek", icon: "seek", label: `Seek “${q}”`, run: () => runSearch(q) } : null;
  const nav = [["Seek", "seek", "search"], ["Topics", "topics", "explore"], ["Reel", "reel", "saved"], ["Footage", "film", "library"], ["Tune", "gear", "settings"]];
  nav.filter(([l]) => match(l)).forEach(([l, ic, p]) => out.push({ sec: "Go to", icon: ic, label: l, run: () => go(p) }));
  const ix = state.status && state.status.indexing;
  const cmds = [["Add a folder", "folder", () => pickAndQueue("folder")], ["Add videos", "plus", () => pickAndQueue("files")], ["Look for new videos", "refresh", rescan],
    ["Switch light or dark theme", "sun", toggleTheme], ["Search with an image", "camera", () => { go("search"); $("#imgInput").click(); }], ["Keyboard shortcuts", "keyboard", () => ($("#keys").hidden = false)]];
  if (ix && (ix.current || ix.pending)) cmds.unshift([ix.paused ? "Resume indexing" : "Pause indexing", ix.paused ? "play" : "pause", pauseResume]);
  cmds.filter(([l]) => match(l)).forEach(([l, ic, fn]) => out.push({ sec: "Commands", icon: ic, label: l, run: fn }));
  if (!q) historyList().slice(0, 5).forEach((t) => out.push({ sec: "Recent", icon: "clock", label: t, run: () => runSearch(t) }));
  (state.concepts || []).filter((c) => q && match(c.label)).slice(0, 4).forEach((c) => out.push({ sec: "Topics", thumb: thumbUrl(c.cover.video_id, c.cover.ts_ms, 120), label: c.label, hint: plural(c.frames, "moment"), run: () => runSearch(c.query) }));
  state.videos.filter((v) => q && v.status === "ready" && match(v.name)).slice(0, 6).forEach((v) => out.push({ sec: "Videos", thumb: thumbUrl(v.id, v.poster_ms, 120), label: v.name, hint: fmtTime(v.duration * 1000), run: () => openWatch(wholeCtx(v)) }));
  if (searchItem) {   // a page or command whose name starts with what you typed wins Enter; otherwise seeking does
    const lead = out.findIndex((it) => (it.sec === "Go to" || it.sec === "Commands") && it.label.toLowerCase().startsWith(lc));
    if (lead < 0) out.unshift(searchItem);
    else { const after = out.findIndex((it) => it.sec !== "Go to" && it.sec !== "Commands"); if (after < 0) out.push(searchItem); else out.splice(after, 0, searchItem); }
  }
  return out;
}
function renderPalette() {
  PAL.items = palItems($("#palQ").value.trim()); PAL.i = 0;
  let sec = ""; const nodes = [];
  PAL.items.forEach((it, k) => {
    if (it.sec !== sec) { sec = it.sec; nodes.push(h("div", { class: "pal-sec" }, sec)); }
    nodes.push(h("button", { class: "pal-item" + (k === 0 ? " on" : ""), type: "button", role: "option", "data-k": k, onclick: () => runPal(k), onmousemove: () => palMark(k) },
      it.thumb ? img(it.thumb) : icon(it.icon), span(it.label), it.hint ? h("small", {}, it.hint) : null));
  });
  fill($("#palList"), nodes.length ? nodes : h("p", { class: "muted small", style: { padding: "12px" } }, "Nothing found"));
}
function palMark(k) {
  if (PAL.i === k) return;
  PAL.i = k;
  $$("#palList .pal-item").forEach((el) => el.classList.toggle("on", +el.dataset.k === k));
  const el = $(`#palList .pal-item[data-k="${k}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}
function runPal(k) { const it = PAL.items[k]; closePalette(); if (it) it.run(); }
$("#palQ").addEventListener("input", renderPalette);
$("#palQ").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); palMark(Math.min(PAL.items.length - 1, PAL.i + 1)); }
  if (e.key === "ArrowUp") { e.preventDefault(); palMark(Math.max(0, PAL.i - 1)); }
  if (e.key === "Enter") { e.preventDefault(); runPal(PAL.i); }
});
$("#palette").addEventListener("mousedown", (e) => { if (e.target.id === "palette") closePalette(); });
$("#cmdkBtn").addEventListener("click", openPalette);
$("#keysBtn").addEventListener("click", () => ($("#keys").hidden = false));
$$("[data-close]").forEach((b) => b.addEventListener("click", () => ($("#" + b.dataset.close).hidden = true)));
$("#keys").addEventListener("mousedown", (e) => { if (e.target.id === "keys") $("#keys").hidden = true; });

/* ═════════════════════════════ keyboard ═════════════════════════════ */
let gPending = 0;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette(); return; }
  if (e.key === "Escape") {
    if (!$("#palette").hidden) return closePalette();
    if (!$("#keys").hidden) { $("#keys").hidden = true; return; }
    if (watching() && !document.fullscreenElement && !typing(e.target)) return goBack();
  }
  if (!$("#palette").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (typing(e.target)) return;
  if (watching()) {
    const v = pv(), k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); return; }
    if (k === "arrowright") { e.preventDefault(); v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5); return; }
    if (k === "arrowleft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); return; }
    if (k === "]") { if (P.i < P.ctx.moments.length - 1) seekMoment(P.i + 1); return; }
    if (k === "[") { if (P.i > 0) seekMoment(P.i - 1); return; }
    if (k === "s") { toggleSave(); return; }
    if (k === "m") { v.muted = !v.muted; return; }
    if (k === "f") { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else $(".screen").requestFullscreen?.().catch(() => {}); return; }
  }
  if (e.key === "/") { e.preventDefault(); if (state.view !== "search") go("search"); setTimeout(() => { $("#q").focus(); $("#q").select(); }, 30); }
  else if (e.key === "?") $("#keys").hidden = false;
  else if (e.key === "g") gPending = Date.now();
  else if (Date.now() - gPending < 1200) {
    const to = { t: "explore", r: "saved", f: "library", x: "settings", h: "search" }[e.key];
    gPending = 0;
    if (to) go(to);
  }
});

/* ═════════════════════════════ start ═════════════════════════════ */
$$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
refreshVideos().then(() => loadSaved()).then(poll);
