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
}, { rootMargin: "400px" });
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
  function close() { t.classList.add("out"); setTimeout(() => t.remove(), 260); }
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
const verdict = (p) => (p >= 75 ? "Strong match" : p >= 55 ? "Good match" : "Possible match");
/** Match percentage to a colour: red (weak) through amber and lime to green (strong). */
const pcColor = (p) => `hsl(${Math.round(Math.max(0, Math.min(1, (p - 30) / 60)) * 120)} 85% 52%)`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const typing = (el) => el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);
const sep = () => h("span", { class: "sep" }, "•");
const joinMeta = (parts) => parts.filter(Boolean).flatMap((p, i) => (i ? [sep(), p] : [p]));
const pcText = (p) => h("span", { class: "pctext", style: { "--pc": pcColor(p) } }, `${Math.round(p)}%`);
const baseName = (f) => f.split(/[\\/]/).filter(Boolean).pop() || f;

/* ═════════════════════════════ state ═════════════════════════════ */
const store = {
  get(k, d) { try { const v = localStorage.getItem("sceneseek." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sceneseek." + k, JSON.stringify(v)); } catch { /* storage off */ } },
};
const prefs = {
  instant: store.get("instant", true), hover: store.get("hover", true), per: store.get("per", 4),
  view: store.get("view", "videos"), libView: store.get("libView", "grid"), mini: store.get("mini", false),
};
function setPref(k, v) { prefs[k] = v; store.set(k, v); }

const state = {
  status: null, videos: [], videosKey: "", saved: [], concepts: null, conceptsLoading: false,
  results: null, view: "", minMatch: 0, libStatus: "all", libFolder: "", searchSeq: 0, scroll: 0,
};

/* ═════════════════════════════ theme + guide ═════════════════════════════ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  fill($("#themeBtn"), icon(t === "light" ? "moon" : "sun"));
}
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
$("#themeBtn").addEventListener("click", toggleTheme);

function updateGuideMode() {
  document.body.classList.toggle("mini", prefs.mini);
  document.body.classList.toggle("ovl", innerWidth <= 1100 || state.view === "watch");
  if (!document.body.classList.contains("ovl")) closeDrawer();
}
const closeDrawer = () => { document.body.classList.remove("drawer"); $("#scrim").hidden = true; };
$("#menuBtn").addEventListener("click", () => {
  if (document.body.classList.contains("ovl")) {
    const on = document.body.classList.toggle("drawer");
    $("#scrim").hidden = !on;
  } else { setPref("mini", !prefs.mini); updateGuideMode(); }
});
$("#scrim").addEventListener("click", closeDrawer);
addEventListener("resize", debounce(updateGuideMode, 120));

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
  if (prev === "search" && view !== "search") state.scroll = $("#app").scrollTop;
  if (prev === "watch" && view !== "watch") stopWatch();
  state.view = view;
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  $$(".guide a[data-tab]").forEach((a) => a.classList.toggle("on", a.dataset.tab === page && view !== "setup"));
  updateGuideMode(); closeDrawer();
  if (view !== prev) $("#app").scrollTop = 0;
  if (view === "search") { renderScopes(); renderSearchPage(); if (prev !== "search") $("#app").scrollTop = state.results ? state.scroll : 0; }
  if (view === "explore") loadExplore();
  if (view === "saved") loadSaved(true);
  if (view === "library") refreshVideos(true);
  if (view === "settings") renderSettings();
  if (view === "watch") await enterWatch(id, params);
}
addEventListener("hashchange", route);
const go = (page) => { if (location.hash === "#" + page) route(); else location.hash = "#" + page; };
const goBack = () => { if (history.length > 1) history.back(); else go("search"); };

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
  $("#ver").textContent = "Sceneseek v" + st.version;
  const n = st.stats.videos;
  $("#libCount").hidden = !n; $("#libCount").textContent = n;
  const ix = st.indexing, job = $("#job");
  const busy = !!(ix.current || ix.pending);
  job.hidden = !busy; $("#jobBtn").hidden = !busy;
  if (busy) {
    const pct = ix.current ? Math.round(ix.current.pct) : 0;
    $("#jobRing").style.setProperty("--p", pct);
    $("#jobRing").classList.toggle("paused", ix.paused);
    $("#jobPct").textContent = pct;
    $("#jobFill").style.width = pct + "%";
    $("#jobName").textContent = ix.paused ? "Indexing paused" : ix.current ? `Indexing ${ix.current.name}` : "Getting ready…";
    const bits = [`${pct}%`];
    if (ix.current && ix.current.eta != null && !ix.paused) bits.push(`about ${fmtDur(ix.current.eta)} left`);
    if (ix.pending) bits.push(`${ix.pending} waiting`);
    $("#jobInfo").textContent = bits.join(" · ");
    fill($("#jobPause"), icon(ix.paused ? "play" : "pause"));
    $("#jobPause").title = ix.paused ? "Resume" : "Pause";
    $("#jobPause").setAttribute("aria-label", ix.paused ? "Resume indexing" : "Pause indexing");
  }
  const folders = st.settings.folders;
  $("#folderSec").hidden = !folders.length;
  fill($("#folderNav"), folders.map((f) => h("button", { type: "button", class: "fold", title: f, onclick: () => { state.libFolder = f; go("library"); } }, icon("folder"), h("span", {}, baseName(f)))));
  ix.errors.forEach((e) => { if (!seenErrors.has(e)) { seenErrors.add(e); toast("Could not index " + e, "err"); } });
}
const pauseResume = () => api("/api/index/control", { json: { action: state.status.indexing.paused ? "resume" : "pause" } }).then(poll, fail);
$("#jobPause").addEventListener("click", pauseResume);
$("#jobBtn").addEventListener("click", () => go("library"));
$("#jobCancel").addEventListener("click", () => {
  if (confirm("Stop indexing and clear the waiting list?\n\nVideos that already finished stay in your library."))
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

/* ═════════════════════════════ cards ═════════════════════════════ */
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

/** A YouTube-style card: rounded 16:9 thumbnail, title, meta. */
function ycard(o) {
  const yt = h("button", { class: "yt" + (o.thumb ? "" : " placeholder"), type: "button", "aria-label": o.aria || o.title, disabled: o.missing || null },
    o.thumb ? img(thumbUrl(o.thumb.id, o.thumb.ts, o.thumb.w || 480)) : icon(o.icon || "film"),
    o.pct != null ? h("span", { class: "pcp" }, Math.round(o.pct) + "%") : null,
    o.time ? h("span", { class: "tm" }, o.time) : null,
    o.pct != null ? h("span", { class: "pcbar", style: { width: Math.round(o.pct) + "%" } }) : null,
    o.starred ? h("span", { class: "star", title: "Saved" }, icon("star")) : null,
    o.thumb && !o.missing ? h("span", { class: "playb" }, icon("play")) : null);
  const title = h("div", { class: "ytitle", title: o.title }, o.title);
  const card = h("article", { class: "ycard" + (o.missing ? " missing" : ""), "data-id": o.dataId, style: o.pct != null ? { "--pc": pcColor(o.pct) } : null },
    yt, h("div", { class: "ytxt" }, title, o.meta ? h("div", { class: "ymeta" }, joinMeta(o.meta)) : null, o.extra || null), o.row || null);
  if (o.onClick && !o.missing) {
    yt.addEventListener("click", o.onClick);
    title.addEventListener("click", o.onClick);
    title.style.cursor = "pointer";
  }
  if (o.thumb && !o.missing) {
    yt.addEventListener("mouseenter", () => startPreview(yt, o.thumb.id, o.thumb.ts));
    yt.addEventListener("mouseleave", () => stopPreview(yt));
  }
  return card;
}

/** Bars that show how strongly a video matches along its timeline, coloured by strength. */
function heatBars(container, heat) {
  const hs = heat || [];
  if (!hs.length) { fill(container); return; }
  const lo = Math.min(...hs), hi = Math.max(...hs), span = Math.max(1, hi - lo);
  fill(container, hs.map((p) => {
    const rel = Math.pow((p - lo) / span, 1.5);
    return h("i", { style: { height: `${Math.round(8 + 92 * rel)}%`, background: p < 22 ? "var(--heat0)" : pcColor(p), opacity: (0.35 + 0.65 * rel).toFixed(2) } });
  }));
}
const emptyState = (ic, title, text, action) => h("div", { class: "empty" }, h("div", { class: "empty-art" }, icon(ic)), h("h2", {}, title), h("p", { class: "muted" }, text), action || null);

/* ═════════════════════════════ header search ═════════════════════════════ */
const historyList = () => store.get("history", []);
function remember(q) { if (q) store.set("history", [q, ...historyList().filter((x) => x !== q)].slice(0, 10)); }
const SG = { items: [], i: -1 };

function buildSuggestions() {
  const val = $("#q").value.trim(), lc = val.toLowerCase(), items = [];
  const hist = historyList().filter((x) => x.toLowerCase() !== lc && (!lc || x.toLowerCase().includes(lc))).slice(0, lc ? 4 : 7);
  hist.forEach((t) => items.push({ icon: "clock", label: t, run: () => runSearch(t) }));
  if (lc) {
    (state.concepts || []).filter((c) => c.label.toLowerCase().includes(lc)).slice(0, 3).forEach((c) =>
      items.push({ thumb: thumbUrl(c.cover.video_id, c.cover.ts_ms, 120), label: c.label, hint: "topic", run: () => runSearch(c.query) }));
    state.videos.filter((v) => v.status === "ready" && v.name.toLowerCase().includes(lc)).slice(0, 3).forEach((v) =>
      items.push({ thumb: thumbUrl(v.id, v.poster_ms, 120), label: v.name, hint: "video", run: () => openWatch(wholeCtx(v)) }));
  }
  return items;
}
function showSuggestions() {
  const box = $("#sugg");
  SG.items = buildSuggestions(); SG.i = -1;
  if (!SG.items.length || document.activeElement !== $("#q")) { box.hidden = true; $("#q").setAttribute("aria-expanded", "false"); return; }
  fill(box, SG.items.map((it, k) => h("button", { type: "button", role: "option", "data-k": k, onmousedown: (e) => { e.preventDefault(); pickSuggestion(k); } },
    it.thumb ? img(it.thumb) : icon(it.icon), h("span", {}, it.label), it.hint ? h("small", {}, it.hint) : null)));
  box.hidden = false; $("#q").setAttribute("aria-expanded", "true");
}
function markSuggestion(i) { SG.i = i; $$("#sugg button").forEach((b, k) => b.classList.toggle("on", k === i)); }
function pickSuggestion(k) { const it = SG.items[k]; $("#sugg").hidden = true; if (it) it.run(); }

$("#q").addEventListener("input", () => { $("#clearQ").hidden = !$("#q").value; showSuggestions(); instant(); });
$("#q").addEventListener("focus", showSuggestions);
$("#q").addEventListener("blur", () => setTimeout(() => ($("#sugg").hidden = true), 120));
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
$$(".guide a[data-tab=search]").forEach((a) => a.addEventListener("click", () => clearSearch()));

/* ═════════════════════════════ home + results ═════════════════════════════ */
function clearSearch() {
  state.results = null; state.searchSeq++; state.scroll = 0;
  $("#q").value = ""; $("#clearQ").hidden = true;
  if (state.view === "search") renderSearchPage();
}

function chipArrows(bar) {
  const sc = $(".chips-scroll", bar), l = $(".cb-arrow.l", bar), r = $(".cb-arrow.r", bar);
  const update = () => { l.hidden = sc.scrollLeft < 8; r.hidden = sc.scrollLeft + sc.clientWidth >= sc.scrollWidth - 8; };
  l.onclick = () => sc.scrollBy({ left: -320 }); r.onclick = () => sc.scrollBy({ left: 320 });
  sc.onscroll = update; setTimeout(update, 60);
}

function videoCardFor(v) {
  const playable = v.exists && v.frames > 0;
  return ycard({
    thumb: playable ? { id: v.id, ts: v.poster_ms } : null, icon: v.status === "error" || !v.exists ? "alert" : "film",
    time: v.duration ? fmtTime(v.duration * 1000) : "", title: v.name, missing: !playable,
    meta: [`${plural(v.frames, "moment")} indexed`, v.added ? `added ${ago(v.added)}` : ""], dataId: v.id, onClick: () => openWatch(wholeCtx(v)),
  });
}

function renderSearchPage() {
  const searching = !!state.results;
  $("#home").hidden = searching; $("#found").hidden = !searching;
  if (searching) { renderResults(); return; }
  const st = state.status;
  const ready = state.videos.filter((v) => v.status === "ready").sort((a, b) => b.added - a.added);
  const cs = state.concepts || [];
  $("#topicBar").hidden = !cs.length;
  fill($("#topicChips"), h("button", { class: "fchip on", type: "button" }, "All"),
    cs.map((c) => h("button", { class: "fchip", type: "button", onclick: () => runSearch(c.query) }, img(thumbUrl(c.cover.video_id, c.cover.ts_ms, 80)), c.label)));
  chipArrows($("#topicBar"));
  $("#homeHead").hidden = !ready.length;
  fill($("#homeGrid"), ready.slice(0, 40).map((v, i) => { const c = videoCardFor(v); c.style.animationDelay = `${Math.min(i, 12) * 25}ms`; return c; }));
  const nothing = !ready.length && !(st && (st.indexing.current || st.indexing.pending)) && st && st.ready;
  $("#homeEmpty").hidden = !nothing;
  if (st && st.ready && st.stats.videos && !state.concepts && !state.conceptsLoading) loadConcepts();
}

function renderScopes() {
  const sel = $("#scope"), keep = sel.value;
  const folders = state.status ? state.status.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready").sort((a, b) => a.name.localeCompare(b.name));
  fill(sel, h("option", { value: "" }, "All videos"),
    folders.length ? h("optgroup", { label: "Folders" }, folders.map((f) => h("option", { value: "f:" + f }, baseName(f)))) : null,
    ready.length ? h("optgroup", { label: "Videos" }, ready.map((v) => h("option", { value: "v:" + v.id }, v.name))) : null);
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}
function scopeParams(params) {
  const v = $("#scope").value;
  if (v.startsWith("v:")) params.set("video_ids", v.slice(2));
  if (v.startsWith("f:")) params.set("folder", v.slice(2));
}

function runSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  $("#q").value = q; $("#clearQ").hidden = false;
  go("search");
  doSearch(q, true);
}

function showLoading() {
  $("#home").hidden = true; $("#found").hidden = false;
  if (!state.results || state.results.pending) fill($("#results"), [0, 1, 2].map(() => h("div", { class: "skeleton row" })));
  else $("#results").style.opacity = ".5";
}

async function doSearch(q, record) {
  q = (q || "").trim();
  if (!q) return;
  const seq = ++state.searchSeq;
  if (!state.results) state.results = { results: [], pending: true, kind: "text", label: `“${q}”` };
  showLoading();
  const params = new URLSearchParams({ q, k: 40, per_video: prefs.per, min_percent: state.minMatch });
  scopeParams(params);
  try {
    const data = await api("/api/search?" + params);
    if (seq !== state.searchSeq) return;
    if (record) remember(q);
    state.results = { ...data, kind: "text", label: `“${q}”` };
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
  if (show) fill(box, h("span", {}, "Looking for"), pos.map((t) => h("span", { class: "term" }, t)), neg.length ? [h("span", {}, "without"), neg.map((t) => h("span", { class: "term neg" }, t))] : null);
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
    state.results = { ...data, kind: "similar", label: `moments like ${name} at ${fmtTime(ts)}` };
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
  $$("#matchChips .fchip").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.minMatch));
  $$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
  if (R.pending) { $("#summary").textContent = ""; return; }
  const minPct = R.kind === "text" ? 0 : state.minMatch;      // text searches are filtered by the server already
  const rs = sortedResults().map((r) => ({ ...r, moments: r.moments.filter((m) => m.score >= minPct) })).filter((r) => r.moments.length);
  $("#exportBtn").hidden = !rs.length;
  const total = rs.reduce((n, r) => n + r.moments.length, 0);
  fill($("#summary"), rs.length ? h("span", {}, h("b", {}, plural(total, "moment")), ` in ${plural(rs.length, "video")} for ${R.label}`, R.took_ms != null ? ` · ${R.took_ms} ms` : "") : null);
  if (!rs.length) {
    const hasVideos = state.status && state.status.stats.videos;
    fill(el, emptyState("search", "Nothing matched",
      !hasVideos ? "There are no indexed videos yet." : state.minMatch ? "Nothing is that strong a match. Show any match, or describe it differently." : "Try describing it differently, or search all videos.",
      state.minMatch ? h("button", { class: "btn", type: "button", onclick: () => setMinMatch(0) }, "Show any match") : null));
    return;
  }
  if (prefs.view === "moments") {
    const all = rs.flatMap((r) => r.moments.map((m) => ({ r, m })));
    if ($("#sortBy").value === "score") all.sort((a, b) => b.m.score - a.m.score);
    fill(el, h("div", { class: "ygrid" }, all.map(({ r, m }, i) => {
      const c = ycard({ thumb: { id: r.video_id, ts: m.ts_ms }, time: fmtTime(m.ts_ms), pct: m.score, title: r.name, starred: isSaved(r.video_id, m.ts_ms),
        meta: [pcText(m.score), verdict(m.score), fmtDur(r.duration)], onClick: () => openWatch(resultCtx(r, r.moments.findIndex((x) => x.ts_ms === m.ts_ms))) });
      c.style.animationDelay = `${Math.min(i, 12) * 25}ms`; return c;
    })));
  } else fill(el, rs.map((r, i) => resultRow(r, i)));
}

function resultRow(r, i) {
  const best = r.moments[0];
  const open = (k) => openWatch(resultCtx(r, k));
  const thumbCard = ycard({ thumb: { id: r.video_id, ts: best.ts_ms }, time: fmtTime(best.ts_ms), pct: best.score, title: r.name, starred: isSaved(r.video_id, best.ts_ms), onClick: () => open(0) });
  const yt = $(".yt", thumbCard);
  const bar = h("div", { class: "minibar", title: "Where it matches in the video. Click to jump there." });
  heatBars(bar, r.heat);
  bar.addEventListener("click", (e) => {
    const frac = (e.clientX - bar.getBoundingClientRect().left) / bar.clientWidth;
    openWatch({ ...resultCtx(r, 0), startAt: frac * r.duration * 1000, startSeek: true });
  });
  return h("article", { class: "sr", style: { animationDelay: `${Math.min(i, 8) * 40}ms`, "--pc": pcColor(best.score) } },
    h("div", { class: "yt-wrap" }, yt),
    h("div", { class: "sr-main" },
      h("h3", { class: "sr-title", title: r.name, onclick: () => open(0) }, r.name),
      h("div", { class: "sr-meta" }, h("span", { class: "verdict" }, h("i"), `${Math.round(best.score)}% · ${verdict(best.score)}`), joinMeta([fmtDur(r.duration), plural(r.moments.length, "moment")])),
      bar,
      h("div", { class: "kmoments" }, r.moments.map((m, k) =>
        h("button", { class: "km", type: "button", style: { "--pc": pcColor(m.score) }, title: `${Math.round(m.score)}% match`, onclick: () => open(k) },
          img(thumbUrl(r.video_id, m.ts_ms, 160)), h("span", { class: "t" }, fmtTime(m.ts_ms)), h("span", { class: "pct" }, Math.round(m.score) + "%"))))));
}

function setMinMatch(v) {
  state.minMatch = +v;
  $$("#matchChips .fchip").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.minMatch));
  if (state.results && state.results.kind === "text") doSearch($("#q").value); else if (state.results) renderResults();
}
$("#matchChips").addEventListener("click", (e) => { const b = e.target.closest(".fchip"); if (b) setMinMatch(b.dataset.v); });
$("#scope").addEventListener("change", () => { if (state.results && state.results.kind === "text") doSearch($("#q").value); });
$("#sortBy").addEventListener("change", () => state.results && renderResults());
$("#viewMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("view", b.dataset.v); if (state.results) renderResults(); } });

function downloadCsv(name, rows) {
  const csv = rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$("#exportBtn").addEventListener("click", () => {
  const rows = [["video", "time", "seconds", "match_percent"]];
  sortedResults().forEach((r) => r.moments.forEach((m) => rows.push([r.name, fmtTime(m.ts_ms), Math.round(m.ts_ms / 1000), m.score])));
  downloadCsv("sceneseek-results.csv", rows);
});

/* ═════════════════════════════ watch ═════════════════════════════ */
const P = { ctx: null, pending: null, i: 0, scenes: [], dur: 0, tab: "matches", more: null, info: null, token: 0 };
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
    try {
      const v = await api(`/api/videos/${id}`);
      ctx = wholeCtx(v, params.get("t") ? +params.get("t") : 0);
    } catch { toast("That video is not in your library any more.", "err"); go("search"); return; }
  }
  startWatch(ctx);
}

function startWatch(ctx) {
  const token = ++P.token;
  P.ctx = ctx; P.i = Math.min(ctx.index || 0, Math.max(0, ctx.moments.length - 1)); P.dur = (ctx.duration || 0) * 1000;
  P.tab = "matches"; P.more = null; P.info = null; lastScene = -1;
  const v = pv();
  $("#pErr").hidden = true;
  $("#pName").textContent = ctx.name; document.title = `${ctx.name} · Sceneseek`;
  $("#pQ").value = ctx.query || "";
  $$("#pSpeed button").forEach((b) => b.classList.toggle("on", b.dataset.v === "1"));
  v.playbackRate = 1;
  renderWatchMeta(); renderWatchSide(); renderTimeline();
  P.scenes = []; fill($("#pScenes"));
  api(`/api/videos/${ctx.video_id}/scenes`).then(({ scenes }) => { if (P.token === token) { P.scenes = scenes; renderScenes(); } }).catch(() => {});
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

function renderWatchMeta() {
  const c = P.ctx, i = P.info;
  const bits = [fmtDur(c.duration)];
  if (i && i.width) bits.push(`${i.width}×${i.height}`);
  if (i && i.size) bits.push(fmtSize(i.size));
  if (c.moments.some((m) => m.score != null)) bits.push(plural(c.moments.length, "matching moment"));
  fill($("#pMeta"), joinMeta(bits));
  const saves = state.saved.filter((s) => s.video_id === c.video_id).length;
  fill($("#pInfo"),
    h("div", {}, h("b", {}, i ? plural(i.frames, "moment") : "…"), " indexed in this video", saves ? ` · ${plural(saves, "saved moment")}` : ""),
    i ? h("div", { class: "path" }, i.path) : null);
  updateSaveBtn();
}

function unItem({ videoId, ts, title, pct, sub, on, onClick }) {
  const yt = h("div", { class: "yt" }, img(thumbUrl(videoId, ts, 320)), h("span", { class: "tm" }, fmtTime(ts)), pct != null ? h("span", { class: "pcbar", style: { width: Math.round(pct) + "%" } }) : null);
  return h("button", { class: "un" + (on ? " on" : ""), type: "button", style: pct != null ? { "--pc": pcColor(pct) } : null, onclick: onClick },
    yt, h("span", { class: "ytxt" }, h("span", { class: "ytitle" }, title), pct != null ? h("span", { class: "big" }, `${Math.round(pct)}%`) : null, h("span", { class: "ymeta" }, sub)));
}

function renderWatchSide() {
  const c = P.ctx;
  $$("#wTabs .fchip").forEach((b) => b.classList.toggle("on", b.dataset.tab === P.tab));
  const list = $("#wList");
  if (P.tab === "matches") {
    if (!c.moments.length) return fill(list, h("p", { class: "un-empty" }, c.query ? "No matches in this video. Try other words." : "Describe something above to find its moments in this video."));
    fill(list, c.moments.map((m, k) => unItem({ videoId: c.video_id, ts: m.ts_ms, title: `At ${fmtTime(m.ts_ms)}`, pct: m.score, sub: m.score != null ? verdict(m.score) : "Moment", on: k === P.i, onClick: () => seekMoment(k) })));
  } else if (P.tab === "saved") {
    const mine = state.saved.filter((s) => s.video_id === c.video_id).sort((a, b) => a.ts_ms - b.ts_ms);
    if (!mine.length) return fill(list, h("p", { class: "un-empty" }, "Nothing saved from this video yet. Press S to save the current moment."));
    fill(list, mine.map((s) => unItem({ videoId: c.video_id, ts: s.ts_ms, title: s.note || `Saved at ${fmtTime(s.ts_ms)}`, pct: null, sub: fmtTime(s.ts_ms), on: false, onClick: () => { pv().currentTime = s.ts_ms / 1000; pv().play().catch(() => {}); } })));
  } else {
    if (!P.more) { fill(list, [0, 1, 2, 3].map(() => h("div", { class: "skeleton", style: { height: "94px", marginBottom: "8px" } }))); loadMore(); return; }
    if (!P.more.length) return fill(list, h("p", { class: "un-empty" }, "Nothing similar found elsewhere in your library."));
    fill(list, P.more.map((r) => { const m = r.moments[0]; return unItem({ videoId: r.video_id, ts: m.ts_ms, title: r.name, pct: m.score, sub: `${fmtTime(m.ts_ms)} · ${verdict(m.score)}`, on: false, onClick: () => openWatch(resultCtx(r, 0)) }); }));
  }
}
async function loadMore() {
  const token = P.token, c = P.ctx;
  try {
    const r = await api(`/api/similar?video_id=${c.video_id}&ts_ms=${currentTs()}&k=12`);
    if (P.token !== token) return;
    P.more = r.results.slice(0, 12);
    if (P.tab === "more") renderWatchSide();
  } catch { if (P.token === token) { P.more = []; renderWatchSide(); } }
}
$("#wTabs").addEventListener("click", (e) => {
  const b = e.target.closest(".fchip"); if (!b) return;
  P.tab = b.dataset.tab; if (P.tab === "more") P.more = null;
  renderWatchSide();
});

function renderTimeline() {
  const c = P.ctx;
  heatBars($("#pHeat"), c.heat);
  const dur = P.dur || 1;
  fill($("#pMarks"), c.moments.map((m, k) => (m.score == null ? null : (() => {
    const b = h("b", { style: { left: `${Math.min(100, (m.ts_ms / dur) * 100)}%`, "--pc": pcColor(m.score) }, title: `${fmtTime(m.ts_ms)} · ${Math.round(m.score)}%`, class: k === P.i ? "on" : "" });
    b.addEventListener("click", (e) => { e.stopPropagation(); seekMoment(k); });
    return b;
  })())));
}
function renderScenes() {
  const c = P.ctx;
  fill($("#pScenes"), P.scenes.map((t) => {
    const b = h("button", { type: "button", title: fmtTime(t), "aria-label": `Jump to ${fmtTime(t)}` }, img(thumbUrl(c.video_id, t, 256)), h("small", {}, fmtTime(t)));
    b.addEventListener("click", () => { pv().currentTime = t / 1000; pv().play().catch(() => {}); });
    return b;
  }));
}
function seekMoment(k) {
  const m = P.ctx.moments[k];
  if (!m) return;
  P.i = k;
  pv().currentTime = Math.max(0, m.ts_ms / 1000 - 0.5);
  pv().play().catch(() => {});
  if (P.tab === "matches") $$("#wList .un").forEach((el, j) => el.classList.toggle("on", j === k));
  $$("#pMarks b").forEach((el, j) => el.classList.toggle("on", j === k));
  updateSaveBtn();
}
let lastScene = -1;
function onTime() {
  const v = pv(), now = v.currentTime * 1000, dur = P.dur || v.duration * 1000 || 1;
  $("#pHead").style.left = `${Math.min(100, (now / dur) * 100)}%`;
  $("#pTimeNow").textContent = `${fmtTime(now)} / ${fmtTime(dur)}`;
  if (P.scenes.length) {
    let idx = 0;
    for (let i = 0; i < P.scenes.length; i++) if (P.scenes[i] <= now + 200) idx = i;
    if (idx !== lastScene) {
      lastScene = idx;
      const btns = $$("#pScenes button");
      btns.forEach((b, j) => b.classList.toggle("on", j === idx));
      const b = btns[idx], strip = $("#pScenes");
      if (b) strip.scrollLeft = b.offsetLeft - strip.clientWidth / 2 + b.clientWidth / 2;
    }
  }
}
function currentTs() { return Math.round(pv().currentTime * 1000) || (P.ctx && P.ctx.moments[P.i] ? P.ctx.moments[P.i].ts_ms : 0); }

const tl = $("#pTimeline");
const tlTime = (e) => { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (P.dur || pv().duration * 1000 || 0); };
tl.addEventListener("click", (e) => { pv().currentTime = tlTime(e) / 1000; pv().play().catch(() => {}); });
tl.addEventListener("mousemove", (e) => { const tip = $("#pTip"), r = tl.getBoundingClientRect(); tip.hidden = false; tip.textContent = fmtTime(tlTime(e)); tip.style.left = `${e.clientX - r.left}px`; });
tl.addEventListener("mouseleave", () => ($("#pTip").hidden = true));

const savedAt = (videoId, ts) => state.saved.find((s) => s.video_id === videoId && Math.abs(s.ts_ms - ts) < 1000);
function saveTarget() {
  const m = P.ctx.moments[P.i], now = currentTs();
  return m && Math.abs(now - m.ts_ms) < 4000 ? m.ts_ms : now;      // the selected moment, unless you have moved on
}
function updateSaveBtn() {
  if (!P.ctx || !watching()) return;
  const on = !!savedAt(P.ctx.video_id, saveTarget());
  $("#pSave").classList.toggle("on", on);
  $("#pSave span").textContent = on ? "Saved" : "Save";
}
async function toggleSave() {
  const ts = saveTarget(), existing = savedAt(P.ctx.video_id, ts);
  try {
    if (existing) { await api(`/api/saved/${existing.id}`, { method: "DELETE" }); toast("Removed from Saved"); }
    else {
      await api("/api/saved", { json: { video_id: P.ctx.video_id, ts_ms: ts, note: P.ctx.query || "" } });
      toast(`Saved ${fmtTime(ts)}`, "ok", { label: "View", fn: () => go("saved") });
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

/* ═════════════════════════════ explore ═════════════════════════════ */
async function loadConcepts() {
  state.conceptsLoading = true;
  try {
    const r = await api("/api/explore");
    state.concepts = r.concepts;
    if (state.view === "search" && !state.results) renderSearchPage();
    return r;
  } catch { return null; } finally { state.conceptsLoading = false; }
}
function conceptCard(c, i) {
  const card = ycard({ thumb: { id: c.cover.video_id, ts: c.cover.ts_ms }, title: c.label, meta: [plural(c.frames, "moment"), plural(c.videos, "video")], onClick: () => runSearch(c.query) });
  card.style.animationDelay = `${Math.min(i, 12) * 30}ms`;
  return card;
}
async function loadExplore() {
  const st = state.status;
  if (!st || !st.ready) return;
  if (!st.stats.videos) { fill($("#concepts")); fill($("#stats")); $("#exploreEmpty").hidden = false; return; }
  $("#exploreEmpty").hidden = true;
  renderStats(st.stats);
  if (!state.concepts) fill($("#concepts"), Array.from({ length: 8 }, () => h("div", { class: "skeleton card" })));
  else fill($("#concepts"), state.concepts.map(conceptCard));
  const r = await loadConcepts();
  if (!r || state.view !== "explore") return;
  renderStats(r.stats);
  fill($("#concepts"), r.concepts.length ? r.concepts.map(conceptCard) : h("p", { class: "muted" }, "Not enough footage to find topics yet. Add more videos."));
}
function renderStats(s) {
  const tile = (v, l) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l));
  fill($("#stats"), tile(s.videos.toLocaleString(), s.videos === 1 ? "video" : "videos"), tile(fmtDur(s.seconds), "of footage"), tile(s.frames.toLocaleString(), "moments indexed"), tile(state.saved.length.toLocaleString(), "saved"));
}

/* ═════════════════════════════ saved ═════════════════════════════ */
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
function renderSaved() {
  const items = state.saved;
  $("#savedEmpty").hidden = items.length > 0;
  $(".plist").hidden = !items.length;
  if (!items.length) return;
  const first = items.find((s) => s.available) || items[0];
  const videos = new Set(items.map((s) => s.video_id)).size;
  const cover = ycard({ thumb: { id: first.video_id, ts: first.ts_ms, w: 640 }, title: first.name, missing: !first.available, onClick: () => openSaved(first), time: fmtTime(first.ts_ms) });
  $(".ytxt", cover).style.display = "none";
  fill($("#plistSide"), cover, h("h1", {}, "Saved moments"),
    h("div", { class: "ymeta" }, joinMeta([plural(items.length, "moment"), `from ${plural(videos, "video")}`])),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", onclick: () => first.available && openSaved(first) }, icon("play"), "Play first"),
      h("button", { class: "btn", type: "button", onclick: () => {
        const rows = [["video", "time", "seconds", "note", "path"]];
        state.saved.forEach((s) => rows.push([s.name, fmtTime(s.ts_ms), Math.round(s.ts_ms / 1000), s.note, s.path]));
        downloadCsv("sceneseek-saved.csv", rows);
      } }, icon("download"), "Export CSV")));
  fill($("#savedGrid"), items.map((s, i) => {
    const note = h("input", { type: "text", value: s.note || "", placeholder: "Add a note…", "aria-label": "Note", maxlength: 500 });
    note.addEventListener("change", () => api(`/api/saved/${s.id}`, { method: "PATCH", json: { note: note.value } }).then(() => { s.note = note.value; toast("Note saved", "ok"); }, fail));
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") note.blur(); });
    const yt = h("button", { class: "yt", type: "button", "aria-label": `Play ${s.name} at ${fmtTime(s.ts_ms)}`, disabled: !s.available || null },
      img(thumbUrl(s.video_id, s.ts_ms, 320)), h("span", { class: "tm" }, fmtTime(s.ts_ms)));
    if (s.available) yt.addEventListener("click", () => openSaved(s));
    return h("div", { class: "pl", style: { animationDelay: `${Math.min(i, 12) * 25}ms` } },
      h("span", { class: "idx" }, i + 1), yt,
      h("div", { class: "body" },
        h("div", { class: "nm", title: s.path, onclick: () => s.available && openSaved(s) }, s.name),
        !s.available ? h("small", { class: "verr" }, "This video is no longer in your library") : null, note),
      h("button", { class: "icon-btn", type: "button", title: "Remove", "aria-label": "Remove saved moment", onclick: () => removeSaved(s) }, icon("trash")));
  }));
}
async function removeSaved(s) {
  try {
    await api(`/api/saved/${s.id}`, { method: "DELETE" });
    await loadSaved(true);
    if (s.video_id) toast("Removed", "", { label: "Undo", fn: () => api("/api/saved", { json: { video_id: s.video_id, ts_ms: s.ts_ms, note: s.note } }).then(() => loadSaved(true), fail) });
    else toast("Removed");
  } catch (e) { fail(e); }
}

/* ═════════════════════════════ library ═════════════════════════════ */
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
  $("#libSummary").textContent = ready.length ? `${plural(ready.length, "video")} · ${fmtDur(ready.reduce((a, v) => a + v.duration, 0))} of footage · ${fmtSize(ready.reduce((a, v) => a + v.size, 0))}` : "Nothing indexed yet.";
  if (state.libFolder && !folders.includes(state.libFolder)) state.libFolder = "";
  fill($("#folderChips"), folders.map((f) => h("span", { class: "fchip" + (state.libFolder === f ? " on" : ""), title: f, onclick: () => { state.libFolder = state.libFolder === f ? "" : f; renderLibrary(); }, style: { cursor: "pointer" } },
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
  $$("#libStatus .fchip").forEach((b) => b.classList.toggle("on", b.dataset.v === stat));
  $$("#libView button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.libView));
  $("#videoGrid").className = "ygrid" + (prefs.libView === "list" ? " list" : "");
  fill($("#videoGrid"), list.map(libraryCard));
}
$("#libFilter").addEventListener("input", renderLibrary);
$("#libSort").addEventListener("change", renderLibrary);
$("#libStatus").addEventListener("click", (e) => { const b = e.target.closest(".fchip"); if (b) { state.libStatus = b.dataset.v; renderLibrary(); } });
$("#libView").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("libView", b.dataset.v); renderLibrary(); } });

function libraryCard(v) {
  const playable = v.exists && v.frames > 0;
  const label = { ready: "Ready", queued: "Waiting", indexing: "Indexing…", error: "Could not index" }[v.status] || v.status;
  const cur = state.status && state.status.indexing.current;
  const pct = cur && cur.video_id === v.id ? cur.pct : 0;
  const meta = [v.width ? `${v.width}×${v.height}` : "", fmtSize(v.size), v.status === "ready" ? plural(v.frames, "moment") : ""].filter(Boolean);
  const acts = h("span", { class: "acts" },
    v.exists ? h("button", { class: "icon-btn sm", type: "button", title: "Show file", "aria-label": "Show " + v.name + " in its folder", onclick: () => api(`/api/videos/${v.id}/reveal`, { method: "POST" }).catch(fail) }, icon("folder")) : null,
    h("button", { class: "icon-btn sm", type: "button", title: "Index again", "aria-label": "Index " + v.name + " again", onclick: () => api(`/api/videos/${v.id}/reindex`, { method: "POST" }).then(() => { toast("Queued again"); poll(); refreshVideos(true); }, fail) }, icon("refresh")),
    h("button", { class: "icon-btn sm", type: "button", title: "Remove from library", "aria-label": "Remove " + v.name, onclick: () => removeVideo(v) }, icon("trash")));
  return ycard({
    thumb: playable ? { id: v.id, ts: v.poster_ms } : null, icon: v.status === "error" || !v.exists ? "alert" : "film", time: v.duration ? fmtTime(v.duration * 1000) : "",
    title: v.name, meta, dataId: v.id, missing: !playable, onClick: () => openWatch(wholeCtx(v)),
    extra: [v.error ? h("div", { class: "verr" }, v.error) : null, !v.exists ? h("div", { class: "verr" }, "The file has moved or been deleted") : null,
      v.status === "indexing" || v.status === "queued" ? h("div", { class: "vprog" }, h("i", { "data-prog": v.id, style: { width: pct + "%" } })) : null],
    row: h("div", { class: "yrow" }, h("span", { class: `stat-s ${v.status}`, "data-live": v.id }, label), acts),
  });
}
function updateLiveCards(st) {
  const cur = st.indexing.current;
  if (!cur) return;
  const s = $(`[data-live="${cur.video_id}"]`);
  if (s) { s.textContent = `Indexing ${Math.round(cur.pct)}%`; s.className = "stat-s indexing"; }
  const p = $(`[data-prog="${cur.video_id}"]`);
  if (p) p.style.width = cur.pct + "%";
}
function removeVideo(v) {
  if (!confirm(`Remove “${v.name}” from Sceneseek?\n\nThe video file itself is not deleted.`)) return;
  api(`/api/videos/${v.id}`, { method: "DELETE" }).then(() => { toast("Removed from library"); refreshVideos(true); poll(); loadSaved(); }, fail);
}
async function unwatch(folder) {
  if (!confirm(`Stop watching this folder for new videos?\n\n${folder}`)) return;
  const removeVideos = confirm("Also remove this folder's videos from Sceneseek?\n\nOK = remove them (your files are never deleted)\nCancel = keep them");
  try { await api(`/api/folders?path=${encodeURIComponent(folder)}&remove_videos=${removeVideos}`, { method: "DELETE" }); if (state.libFolder === folder) state.libFolder = ""; await poll(); refreshVideos(true); } catch (e) { fail(e); }
}

async function queuePaths(paths, watch) {
  try {
    const { queued } = await api("/api/index/paths", { json: { paths, watch } });
    toast(queued ? `Indexing ${plural(queued, "video")}. Search as soon as the first one finishes.` : "Those videos are already up to date.", queued ? "ok" : "");
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

/* ═════════════════════════════ settings ═════════════════════════════ */
const dedupeLabel = (v) => (v == 0 ? "Off" : v <= 0.3 ? "Low" : v <= 0.6 ? "Medium" : "High");
function renderSettings() {
  const st = state.status; if (!st) return;
  const c = st.settings;
  $("#pInstant").checked = prefs.instant; $("#pHover").checked = prefs.hover;
  $$("#pPer button").forEach((b) => b.classList.toggle("on", +b.dataset.v === prefs.per));
  $("#sInterval").value = c.interval; $("#oInterval").textContent = `every ${c.interval} s`;
  $("#sDedupe").value = c.dedupe; $("#oDedupe").textContent = dedupeLabel(c.dedupe);
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
$("#sInterval").addEventListener("input", (e) => { $("#oInterval").textContent = `every ${e.target.value} s`; saveSetting({ interval: +e.target.value }); });
$("#sDedupe").addEventListener("input", (e) => { $("#oDedupe").textContent = dedupeLabel(+e.target.value); saveSetting({ dedupe: +e.target.value }); });
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
  const searchItem = q ? { sec: "Search", icon: "search", label: `Search for “${q}”`, run: () => runSearch(q) } : null;
  const nav = [["Home", "home", "search"], ["Explore", "compass", "explore"], ["Saved moments", "star", "saved"], ["Library", "film", "library"], ["Settings", "gear", "settings"]];
  nav.filter(([l]) => match(l)).forEach(([l, ic, p]) => out.push({ sec: "Go to", icon: ic, label: l, run: () => go(p) }));
  const ix = state.status && state.status.indexing;
  const cmds = [["Add a folder", "folder", () => pickAndQueue("folder")], ["Add videos", "plus", () => pickAndQueue("files")], ["Look for new videos", "refresh", rescan],
    ["Switch light or dark theme", "sun", toggleTheme], ["Search with an image", "camera", () => { go("search"); $("#imgInput").click(); }], ["Keyboard shortcuts", "keyboard", () => ($("#keys").hidden = false)]];
  if (ix && (ix.current || ix.pending)) cmds.unshift([ix.paused ? "Resume indexing" : "Pause indexing", ix.paused ? "play" : "pause", pauseResume]);
  cmds.filter(([l]) => match(l)).forEach(([l, ic, fn]) => out.push({ sec: "Commands", icon: ic, label: l, run: fn }));
  if (!q) historyList().slice(0, 5).forEach((t) => out.push({ sec: "Recent searches", icon: "clock", label: t, run: () => runSearch(t) }));
  (state.concepts || []).filter((c) => q && match(c.label)).slice(0, 4).forEach((c) => out.push({ sec: "Topics", thumb: thumbUrl(c.cover.video_id, c.cover.ts_ms, 120), label: c.label, hint: plural(c.frames, "moment"), run: () => runSearch(c.query) }));
  state.videos.filter((v) => q && v.status === "ready" && match(v.name)).slice(0, 6).forEach((v) => out.push({ sec: "Videos", thumb: thumbUrl(v.id, v.poster_ms, 120), label: v.name, hint: fmtTime(v.duration * 1000), run: () => openWatch(wholeCtx(v)) }));
  if (searchItem) {   // a page or command whose name starts with what you typed wins Enter; otherwise searching does
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
      it.thumb ? img(it.thumb) : icon(it.icon), h("span", {}, it.label), it.hint ? h("small", {}, it.hint) : null));
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
$("#guideKeys").addEventListener("click", () => { closeDrawer(); $("#keys").hidden = false; });
$$("[data-close]").forEach((b) => b.addEventListener("click", () => ($("#" + b.dataset.close).hidden = true)));
$("#keys").addEventListener("mousedown", (e) => { if (e.target.id === "keys") $("#keys").hidden = true; });

/* ═════════════════════════════ keyboard ═════════════════════════════ */
let gPending = 0;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#palette").hidden ? openPalette() : closePalette(); return; }
  if (e.key === "Escape") {
    if (!$("#palette").hidden) return closePalette();
    if (!$("#keys").hidden) { $("#keys").hidden = true; return; }
    if (document.body.classList.contains("drawer")) return closeDrawer();
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
    if (k === "f") { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else $(".stage").requestFullscreen?.().catch(() => {}); return; }
  }
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "?") $("#keys").hidden = false;
  else if (e.key === "g") gPending = Date.now();
  else if (Date.now() - gPending < 1200) {
    const to = { s: "saved", e: "explore", l: "library", x: "settings", h: "search" }[e.key];
    gPending = 0;
    if (to) go(to);
  }
});

/* ═════════════════════════════ start ═════════════════════════════ */
updateGuideMode();
$$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
refreshVideos().then(() => loadSaved()).then(poll);
