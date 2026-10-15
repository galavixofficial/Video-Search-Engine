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
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
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
function img(src, alt = "") {
  const i = h("img", { alt, loading: "lazy", decoding: "async" });
  i.onload = () => i.classList.add("ok");
  i.onerror = () => { i.style.visibility = "hidden"; };
  i.src = src;
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
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
const thumbUrl = (id, t, w = 480) => `/api/thumb/${id}?t=${Math.max(0, Math.round(t))}&w=${w}`;
const band = (p) => (p >= 75 ? "b3" : p >= 55 ? "b2" : "b1");
const bandLabel = (p) => (p >= 75 ? "Strong match" : p >= 55 ? "Good match" : "Possible match");
function heatColor(p) {
  if (p < 12) return "var(--heat0)";
  const t = Math.min(1, p / 100);
  const g = Math.round(70 + 110 * t);          // orange-red at low scores, warm gold at the top
  return `rgba(255, ${g}, ${Math.round(60 - 10 * t)}, ${(0.25 + 0.75 * t).toFixed(2)})`;
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const typing = (el) => el && (/INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable);

/* ═════════════════════════════ state ═════════════════════════════ */
const store = {
  get(k, d) { try { const v = localStorage.getItem("sceneseek." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sceneseek." + k, JSON.stringify(v)); } catch { /* storage off */ } },
};
const prefs = {
  instant: store.get("instant", true), hover: store.get("hover", true), per: store.get("per", 4),
  view: store.get("view", "videos"), libView: store.get("libView", "grid"),
};
function setPref(k, v) { prefs[k] = v; store.set(k, v); }

const state = {
  status: null, videos: [], videosKey: "", saved: [], concepts: null,
  results: null, view: "", minMatch: 0, libStatus: "all", searchSeq: 0,
};

/* ═════════════════════════════ theme ═════════════════════════════ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  fill($("#themeBtn"), icon(t === "light" ? "moon" : "sun"));
}
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
const toggleTheme = () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
$("#themeBtn").addEventListener("click", toggleTheme);

/* ═════════════════════════════ routing ═════════════════════════════ */
const PAGES = ["search", "explore", "saved", "library", "settings"];
function route() {
  let name = (location.hash || "#search").slice(1);
  if (!PAGES.includes(name)) name = "search";
  const st = state.status;
  const view = st && !st.ready && name !== "settings" ? "setup" : name;
  const changed = view !== state.view;
  state.view = view;
  if (playerOpen()) closePlayer();
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  $$(".nav a").forEach((a) => a.classList.toggle("on", a.dataset.tab === name && view !== "setup"));
  if (changed) $("#app").scrollTop = 0;
  if (view === "search") { renderScopes(); renderSuggestions(); if (!state.results && !matchMedia("(pointer: coarse)").matches) $("#q").focus({ preventScroll: true }); }
  if (view === "explore") loadExplore();
  if (view === "saved") loadSaved(true);
  if (view === "library") refreshVideos(true);
  if (view === "settings") renderSettings();
}
addEventListener("hashchange", route);
const go = (page) => { if (location.hash === "#" + page) route(); else location.hash = "#" + page; };

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
    if (first || wasReady !== st.ready) route();
    if (st.ready && wasReady === false) { toast("All set. Add a folder of videos to begin.", "ok"); go("library"); }
    if (st.indexing.completed !== lastCompleted || st.stats.frames !== lastFrames) {
      const grew = lastFrames >= 0 && st.stats.frames !== lastFrames;
      lastCompleted = st.indexing.completed; lastFrames = st.stats.frames;
      await refreshVideos();
      if (grew && !st.indexing.current && !st.indexing.pending) { state.concepts = null; if (state.view === "explore") loadExplore(); }
      if (state.view === "search" && !state.results) renderSuggestions();
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
  $("#ver").textContent = "v" + st.version;
  const n = st.stats.videos;
  $("#libCount").hidden = !n; $("#libCount").textContent = n;
  const ix = st.indexing, job = $("#job");
  job.hidden = !(ix.current || ix.pending);
  job.classList.toggle("paused", ix.paused);
  if (!job.hidden) {
    const pct = ix.current ? Math.round(ix.current.pct) : 0;
    $("#jobRing").style.setProperty("--p", pct);
    $("#jobPct").textContent = pct + "%";
    $("#jobName").textContent = ix.paused ? "Paused" : ix.current ? ix.current.name : "Getting ready…";
    const bits = [];
    if (ix.current && ix.current.eta != null && !ix.paused) bits.push(`about ${fmtDur(ix.current.eta)} left`);
    if (ix.pending) bits.push(`${ix.pending} waiting`);
    $("#jobInfo").textContent = bits.join(" · ") || "Indexing";
    fill($("#jobPause"), icon(ix.paused ? "play" : "pause"), h("span", {}, ix.paused ? "Resume" : "Pause"));
  }
  ix.errors.forEach((e) => { if (!seenErrors.has(e)) { seenErrors.add(e); toast("Could not index " + e, "err"); } });
}
const pauseResume = () => api("/api/index/control", { json: { action: state.status.indexing.paused ? "resume" : "pause" } }).then(poll, fail);
$("#jobPause").addEventListener("click", pauseResume);
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

/* ═════════════════════════════ shared cards ═════════════════════════════ */
let previewTimer = null;
function stopPreview(card) {
  clearTimeout(previewTimer);
  const v = card && card.querySelector("video");
  if (v) { v.pause(); v.removeAttribute("src"); v.load(); v.remove(); }
  if (card) card.classList.remove("previewing");
}
function startPreview(card, videoId, ts) {
  if (!prefs.hover || matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!card.matches(":hover") || card.querySelector("video")) return;
    const v = h("video", { muted: true, playsinline: true, preload: "auto" });
    v.muted = true;
    v.src = `/api/video/${videoId}#t=${Math.max(0, ts / 1000 - 0.3).toFixed(1)}`;
    v.onerror = () => stopPreview(card);
    v.onplaying = () => card.classList.add("previewing");
    card.prepend(v);
    v.play().catch(() => stopPreview(card));
  }, 420);
}
function isSaved(videoId, ts) { return state.saved.some((s) => s.video_id === videoId && Math.abs(s.ts_ms - ts) < 1000); }

/** A clickable 16:9 moment thumbnail. */
function momentCard({ videoId, ts, score, name, onClick, missing, label }) {
  const card = h("button", { class: "mcard" + (missing ? " missing" : ""), type: "button", disabled: missing || null,
      "aria-label": `${name ? name + " at " : ""}${fmtTime(ts)}${score != null ? `, ${Math.round(score)}% match` : ""}` },
    img(thumbUrl(videoId, ts)),
    name ? h("span", { class: "n" }, name) : null,
    h("span", { class: "t" }, icon("play"), label || fmtTime(ts)),
    score != null ? h("span", { class: `pct ${band(score)}`, style: { "--p": Math.round(score) } }, h("span", {}, Math.round(score))) : null,
    isSaved(videoId, ts) ? h("span", { class: "star", title: "Saved" }, icon("star")) : null,
    h("span", { class: "play" }, icon("play")));
  if (!missing) {
    card.addEventListener("click", onClick);
    card.addEventListener("mouseenter", () => startPreview(card, videoId, ts));
    card.addEventListener("mouseleave", () => stopPreview(card));
  }
  return card;
}

/** Bars for a match-strength strip, scaled to the video's own best and worst moments so peaks stand out. */
function heatBars(container, heat) {
  const hs = heat || [];
  const lo = Math.min(...hs), hi = Math.max(...hs), span = Math.max(1, hi - lo);
  fill(container, hs.map((p) => {
    const rel = Math.pow((p - lo) / span, 1.6);
    return h("i", { style: { height: `${Math.round(10 + 90 * rel)}%`, background: heatColor(rel < 0.12 ? 0 : 25 + 75 * rel) } });
  }));
}
function emptyState(ic, title, text, action) {
  return h("div", { class: "empty" }, h("div", { class: "empty-art" }, icon(ic)), h("h2", {}, title), h("p", { class: "muted" }, text), action || null);
}

/* ═════════════════════════════ search ═════════════════════════════ */
const EXAMPLES = ["a person walking on a beach", "two people talking at a table", "a car driving at night", "fireworks in the sky", "a close-up of a cat", "a crowd cheering"];

function renderSuggestions() {
  const box = $("#examples");
  const cs = (state.concepts || []).slice(0, 10);
  if (cs.length) {
    $("#suggestH").textContent = "In your library";
    fill(box, ...cs.map((c) => h("button", { class: "chip", type: "button", onclick: () => runSearch(c.query) },
      img(thumbUrl(c.cover.video_id, c.cover.ts_ms, 120)), c.label)));
  } else {
    $("#suggestH").textContent = "Try something";
    fill(box, ...EXAMPLES.map((t) => h("button", { class: "chip", type: "button", onclick: () => runSearch(t) }, t)));
    if (state.status && state.status.ready && state.status.stats.videos && !state.conceptsLoading) loadConcepts();
  }
  const recent = historyList().slice(0, 6);
  $("#recent").hidden = !recent.length;
  fill($("#recentChips"), recent.map((t) => h("button", { class: "chip ghosty", type: "button", onclick: () => runSearch(t) }, icon("refresh"), t)));
  const st = state.status;
  if (!state.results && st && st.ready && !st.stats.videos && !st.indexing.current && !st.indexing.pending) {
    fill($("#results"), emptyState("film", "Add some videos to search", "Point Sceneseek at a folder and it indexes everything in the background.",
      h("button", { class: "btn primary", type: "button", onclick: () => pickAndQueue("folder") }, icon("folder"), "Add a folder")));
  } else if (!state.results) fill($("#results"), );
}

function renderScopes() {
  const sel = $("#scope"), keep = sel.value;
  const folders = state.status ? state.status.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready").sort((a, b) => a.name.localeCompare(b.name));
  fill(sel, h("option", { value: "" }, "All videos"),
    folders.length ? h("optgroup", { label: "Folders" }, folders.map((f) => h("option", { value: "f:" + f }, f.split(/[\\/]/).filter(Boolean).pop() || f))) : null,
    ready.length ? h("optgroup", { label: "Videos" }, ready.map((v) => h("option", { value: "v:" + v.id }, v.name))) : null);
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}

const historyList = () => store.get("history", []);
function remember(q) { if (q) store.set("history", [q, ...historyList().filter((x) => x !== q)].slice(0, 10)); }
function showHistory() {
  const box = $("#history"), val = $("#q").value.trim().toLowerCase();
  const items = historyList().filter((x) => x.toLowerCase() !== val && x.toLowerCase().includes(val)).slice(0, 6);
  if (!items.length || document.activeElement !== $("#q")) { box.hidden = true; return; }
  fill(box, ...items.map((t) => h("button", { type: "button", onmousedown: (e) => { e.preventDefault(); runSearch(t); } },
    icon("refresh"), t, h("small", {}, "recent"))));
  box.hidden = false;
}

function setSearchMode(on) {
  document.body.classList.toggle("searched", on);
  $("#toolbar").hidden = !on;
  if (!on) { $("#summary").textContent = ""; $("#terms").hidden = true; }
}

function runSearch(q) {
  $("#q").value = q;
  $("#clearQ").hidden = !q;
  go("search");
  doSearch(q, true);
}

function scopeParams(params) {
  const v = $("#scope").value;
  if (v.startsWith("v:")) params.set("video_ids", v.slice(2));
  if (v.startsWith("f:")) params.set("folder", v.slice(2));
}

function showLoading() {
  if (!state.results) fill($("#results"), ...[0, 1, 2].map(() => h("div", { class: "skeleton" })));
  else $("#results").style.opacity = ".55";
}

async function doSearch(q, record) {
  q = (q || "").trim();
  if (!q) return;
  $("#history").hidden = true;
  const seq = ++state.searchSeq;
  setSearchMode(true);
  showLoading();
  const params = new URLSearchParams({ q, k: 40, per_video: prefs.per, min_percent: state.minMatch });
  scopeParams(params);
  try {
    const data = await api("/api/search?" + params);
    if (seq !== state.searchSeq) return;              // a newer search already started
    if (record) remember(q);
    state.results = { ...data, kind: "text", label: `“${q}”` };
    renderTerms(data.terms, data.excluded);
    renderResults();
  } catch (e) {
    if (seq !== state.searchSeq) return;
    $("#results").style.opacity = "";
    if (!state.results) fill($("#results"), );
    fail(e);
  }
}

function renderTerms(pos, neg) {
  const box = $("#terms");
  const show = (pos && pos.length > 1) || (neg && neg.length);
  box.hidden = !show;
  if (show) fill(box, h("span", {}, "Looking for"), ...pos.map((t) => h("span", { class: "term" }, t)),
    ...(neg.length ? [h("span", {}, "without"), ...neg.map((t) => h("span", { class: "term neg" }, t))] : []));
}

async function imageSearch(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Choose an image file.", "err");
  go("search");
  const seq = ++state.searchSeq;
  state.results = null;
  setSearchMode(true); $("#terms").hidden = true;
  showLoading();
  const form = new FormData(); form.append("file", file);
  try {
    const data = await api("/api/search/image", { form });
    if (seq !== state.searchSeq) return;
    state.results = { ...data, kind: "image", label: "your image" };
    renderResults();
  } catch (e) { fill($("#results"), ); fail(e); }
}

async function similarTo(videoId, ts, name) {
  go("search");
  const seq = ++state.searchSeq;
  state.results = null;
  setSearchMode(true); $("#terms").hidden = true;
  $("#q").value = ""; $("#clearQ").hidden = true;
  showLoading();
  try {
    const data = await api(`/api/similar?video_id=${videoId}&ts_ms=${ts}&k=40`);
    if (seq !== state.searchSeq) return;
    state.results = { ...data, kind: "similar", label: `moments like ${name} at ${fmtTime(ts)}` };
    renderResults();
  } catch (e) { fill($("#results"), ); fail(e); }
}

function sortedResults() {
  const rs = [...state.results.results];
  const by = $("#sortBy").value;
  if (by === "name") rs.sort((a, b) => a.name.localeCompare(b.name));
  if (by === "added") rs.sort((a, b) => (b.added || 0) - (a.added || 0));
  if (by === "duration") rs.sort((a, b) => b.duration - a.duration);
  return rs;
}

function renderResults() {
  const R = state.results, el = $("#results");
  if (!R) return;
  el.style.opacity = "";
  const minPct = R.kind === "text" ? 0 : state.minMatch;      // text searches are filtered by the server already
  const rs = sortedResults().map((r) => ({ ...r, moments: r.moments.filter((m) => m.score >= minPct) })).filter((r) => r.moments.length);
  $$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
  $("#exportBtn").hidden = !rs.length;
  const total = rs.reduce((n, r) => n + r.moments.length, 0);
  fill($("#summary"), rs.length
    ? h("span", {}, h("b", {}, plural(total, "moment")), ` in ${plural(rs.length, "video")} for ${R.label}`, R.took_ms != null ? ` · ${R.took_ms} ms` : "")
    : "");
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
    fill(el, h("div", { class: "mgrid" }, all.map(({ r, m }) =>
      momentCard({ videoId: r.video_id, ts: m.ts_ms, score: m.score, name: r.name, onClick: () => openPlayer(playerCtx(r, r.moments.indexOf(m))) }))));
  } else {
    fill(el, ...rs.map((r, i) => resultGroup(r, i)));
  }
}

function playerCtx(r, index) {
  return { video_id: r.video_id, name: r.name, duration: r.duration, moments: r.moments.map((m) => ({ ...m })), heat: r.heat || [], index: Math.max(0, index),
    query: state.results && state.results.kind === "text" ? $("#q").value.trim() : "" };
}

function resultGroup(r, i) {
  const bar = h("div", { class: "minibar", title: "Where it matches in the video. Click to jump there." });
  heatBars(bar, r.heat);
  bar.addEventListener("click", (e) => {
    const frac = (e.clientX - bar.getBoundingClientRect().left) / bar.clientWidth;
    openPlayer({ ...playerCtx(r, 0), startAt: frac * r.duration * 1000 });
  });
  return h("article", { class: "rgroup", style: { animationDelay: `${Math.min(i, 8) * 40}ms` } },
    h("div", { class: "rhead" },
      h("span", { class: "rname", title: r.name }, r.name),
      h("span", { class: "rmeta" }, `${fmtDur(r.duration)} · ${plural(r.moments.length, "moment")}`),
      h("span", { class: "spacer" }),
      h("span", { class: `badge ${band(r.score)}` }, bandLabel(r.score))),
    bar,
    h("div", { class: "rmoments" }, r.moments.map((m, k) =>
      momentCard({ videoId: r.video_id, ts: m.ts_ms, score: m.score, onClick: () => openPlayer(playerCtx(r, k)) }))));
}

function setMinMatch(v) {
  state.minMatch = +v;
  $$("#minMatch button").forEach((b) => b.classList.toggle("on", +b.dataset.v === state.minMatch));
  if (state.results && state.results.kind === "text") doSearch($("#q").value);
  else renderResults();
}

const instant = debounce(() => {
  const q = $("#q").value.trim();
  if (prefs.instant && q.length >= 3 && state.status && state.status.ready && state.status.stats.videos) doSearch(q, false);
}, 320);
$("#q").addEventListener("input", () => {
  $("#clearQ").hidden = !$("#q").value;
  showHistory();
  instant();
});
$("#q").addEventListener("focus", showHistory);
$("#q").addEventListener("blur", () => setTimeout(() => ($("#history").hidden = true), 120));
$("#q").addEventListener("keydown", (e) => { if (e.key === "Escape") $("#q").blur(); });
$("#q").addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); imageSearch(f); } });
$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); doSearch($("#q").value, true); });
$("#clearQ").addEventListener("click", () => {
  $("#q").value = ""; $("#clearQ").hidden = true; state.results = null; state.searchSeq++;
  setSearchMode(false); renderSuggestions(); $("#q").focus();
});
$("#imgBtn").addEventListener("click", () => $("#imgInput").click());
$("#imgInput").addEventListener("change", (e) => { imageSearch(e.target.files[0]); e.target.value = ""; });
$("#scope").addEventListener("change", () => { if (state.results && state.results.kind === "text") doSearch($("#q").value); });
$("#minMatch").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setMinMatch(b.dataset.v); });
$("#sortBy").addEventListener("change", renderResults);
$("#viewMode").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("view", b.dataset.v); renderResults(); } });

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

/* ═════════════════════════════ player ═════════════════════════════ */
const P = { ctx: null, i: 0, scenes: [], dur: 0 };
const playerOpen = () => !$("#player").hidden;
const pv = () => $("#pVideo");

function openPlayer(ctx) {
  P.ctx = ctx; P.i = Math.min(ctx.index || 0, Math.max(0, ctx.moments.length - 1)); P.dur = (ctx.duration || 0) * 1000;
  lastScene = -1;
  const v = pv();
  $("#pErr").hidden = true;
  $("#player").hidden = false;
  $("#pName").textContent = ctx.name;
  $("#pQ").value = ctx.query || "";
  $$("#pSpeed button").forEach((b) => b.classList.toggle("on", b.dataset.v === "1"));
  v.playbackRate = 1;
  renderPlayerMoments();
  renderTimeline();
  P.scenes = []; fill($("#pScenes"), );
  api(`/api/videos/${ctx.video_id}/scenes`).then(({ scenes }) => { if (P.ctx === ctx) { P.scenes = scenes; renderScenes(); } }).catch(() => {});
  v.src = `/api/video/${ctx.video_id}`;
  v.onloadedmetadata = () => {
    if (!P.dur && v.duration) { P.dur = v.duration * 1000; renderTimeline(); }
    const start = ctx.startAt != null ? ctx.startAt : ctx.moments[P.i] ? ctx.moments[P.i].ts_ms - 500 : 0;
    v.currentTime = Math.max(0, start / 1000);
    v.play().catch(() => {});
  };
  v.onerror = () => { $("#pErrTime").textContent = fmtTime(ctx.moments[P.i] ? ctx.moments[P.i].ts_ms : 0); $("#pErr").hidden = false; };
  v.ontimeupdate = onTime;
  v.load();
  setTimeout(() => $("#pClose").focus({ preventScroll: true }), 50);
}

function closePlayer() {
  const v = pv();
  v.pause(); v.removeAttribute("src"); v.load();
  $("#player").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (state.view === "search" && state.results) renderResults();     // refresh saved stars
  if (state.view === "saved") renderSaved();
}

function renderPlayerMoments() {
  const c = P.ctx;
  const metaBits = [fmtDur(c.duration)];
  if (c.moments.length) metaBits.push(plural(c.moments.length, "moment"));
  $("#pMeta").textContent = metaBits.join(" · ");
  $("#pMomH").textContent = c.query ? `Matches for “${c.query}”` : c.moments.length > 1 ? "Moments" : c.moments.length ? "Moment" : "Search inside to find moments";
  fill($("#pMoments"), ...(c.moments.length ? c.moments.map((m, k) =>
    h("button", { class: "mrow" + (k === P.i ? " on" : ""), type: "button", onclick: () => seekMoment(k) },
      img(thumbUrl(c.video_id, m.ts_ms, 240)),
      h("span", {}, h("b", {}, fmtTime(m.ts_ms)), h("small", {}, m.score != null ? `${Math.round(m.score)}% · ${bandLabel(m.score)}` : "Saved moment"))))
    : c.query ? [h("p", { class: "muted small" }, "No matches in this video. Try other words.")] : []));
  updateSaveBtn();
}

function renderTimeline() {
  const c = P.ctx;
  heatBars($("#pHeat"), c.heat && c.heat.length ? c.heat : []);
  const dur = P.dur || 1;
  fill($("#pMarks"), ...c.moments.map((m, k) => {
    const b = h("b", { style: { left: `${Math.min(100, (m.ts_ms / dur) * 100)}%` }, title: fmtTime(m.ts_ms), class: k === P.i ? "on" : "" });
    b.addEventListener("click", (e) => { e.stopPropagation(); seekMoment(k); });
    return b;
  }));
}

function renderScenes() {
  const c = P.ctx;
  fill($("#pScenes"), ...P.scenes.map((t) => {
    const b = h("button", { type: "button", title: fmtTime(t), "aria-label": `Jump to ${fmtTime(t)}` }, img(thumbUrl(c.video_id, t, 208)), h("small", {}, fmtTime(t)));
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
  $$("#pMoments .mrow").forEach((el, j) => el.classList.toggle("on", j === k));
  $$("#pMarks b").forEach((el, j) => el.classList.toggle("on", j === k));
  const row = $$("#pMoments .mrow")[k];
  if (row) row.scrollIntoView({ block: "nearest" });
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
function currentTs() { return Math.round(pv().currentTime * 1000) || (P.ctx.moments[P.i] ? P.ctx.moments[P.i].ts_ms : 0); }

const tl = $("#pTimeline");
function tlTime(e) { const r = tl.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (P.dur || pv().duration * 1000 || 0); }
tl.addEventListener("click", (e) => { pv().currentTime = tlTime(e) / 1000; pv().play().catch(() => {}); });
tl.addEventListener("mousemove", (e) => {
  const tip = $("#pTip"), r = tl.getBoundingClientRect();
  tip.hidden = false; tip.textContent = fmtTime(tlTime(e)); tip.style.left = `${e.clientX - r.left}px`;
});
tl.addEventListener("mouseleave", () => ($("#pTip").hidden = true));

function savedAt(videoId, ts) { return state.saved.find((s) => s.video_id === videoId && Math.abs(s.ts_ms - ts) < 1000); }
function saveTarget() {
  const m = P.ctx.moments[P.i], now = currentTs();
  return m && Math.abs(now - m.ts_ms) < 4000 ? m.ts_ms : now;      // the selected moment, unless you have moved on
}
function updateSaveBtn() {
  if (!P.ctx) return;
  const on = !!savedAt(P.ctx.video_id, saveTarget());
  $("#pSave").classList.toggle("on", on);
  $("#pSave span").textContent = on ? "Saved" : "Save";
}
async function toggleSave() {
  const ts = saveTarget();
  const existing = savedAt(P.ctx.video_id, ts);
  try {
    if (existing) { await api(`/api/saved/${existing.id}`, { method: "DELETE" }); toast("Removed from Saved"); }
    else {
      await api("/api/saved", { json: { video_id: P.ctx.video_id, ts_ms: ts, note: P.ctx.query || "" } });
      toast(`Saved ${fmtTime(ts)}`, "ok", { label: "View", fn: () => go("saved") });
    }
    await loadSaved();
    updateSaveBtn();
  } catch (e) { fail(e); }
}
$("#pSave").addEventListener("click", toggleSave);
$("#pFrame").addEventListener("click", async () => {
  try {
    const r = await api(`/api/videos/${P.ctx.video_id}/save-frame`, { json: { ts_ms: currentTs() } });
    toast("Frame saved to Pictures\\Sceneseek", "ok", { label: "Show", fn: () => api("/api/reveal-path", { json: { path: r.path } }).catch(fail) });
  } catch (e) { fail(e); }
});
$("#pSimilar").addEventListener("click", () => { const c = P.ctx, t = currentTs(); closePlayer(); similarTo(c.video_id, t, c.name); });
$("#pCopy").addEventListener("click", () => {
  const text = `${P.ctx.name} @ ${fmtTime(currentTs())}`;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Copied: " + text, "ok"), () => toast(text));
});
$("#pReveal").addEventListener("click", () => api(`/api/videos/${P.ctx.video_id}/reveal`, { method: "POST" }).catch(fail));
const openExternal = () => api(`/api/videos/${P.ctx.video_id}/open`, { method: "POST" }).catch(fail);
$("#pOpen").addEventListener("click", openExternal);
$("#pOpenErr").addEventListener("click", openExternal);
$("#pClose").addEventListener("click", closePlayer);
$("#player").addEventListener("mousedown", (e) => { if (e.target.id === "player") closePlayer(); });
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
    P.ctx.query = q;
    P.ctx.moments = hit ? hit.moments : [];
    P.ctx.heat = hit ? hit.heat : [];
    P.i = 0;
    renderPlayerMoments(); renderTimeline();
    if (hit) seekMoment(0);
  } catch (err) { fail(err); }
});

/* ═════════════════════════════ explore ═════════════════════════════ */
async function loadConcepts() {
  state.conceptsLoading = true;
  try {
    const r = await api("/api/explore");
    state.concepts = r.concepts;
    if (state.view === "search" && !state.results) renderSuggestions();
    return r;
  } catch { return null; } finally { state.conceptsLoading = false; }
}
async function loadExplore() {
  const st = state.status;
  if (!st || !st.ready) return;
  if (!st.stats.videos) { fill($("#concepts"), ); fill($("#stats"), ); $("#exploreEmpty").hidden = false; return; }
  $("#exploreEmpty").hidden = true;
  renderStats(st.stats);
  if (!state.concepts) fill($("#concepts"), ...Array.from({ length: 8 }, () => h("div", { class: "skeleton card", style: { aspectRatio: "4 / 3" } })));
  else renderConcepts(state.concepts);
  const r = await loadConcepts();
  if (!r || state.view !== "explore") return;
  renderStats(r.stats);
  renderConcepts(r.concepts);
}
function renderConcepts(cs) {
  fill($("#concepts"), ...(cs.length ? cs.map((c, i) => h("button", { class: "concept", type: "button", style: { animationDelay: `${Math.min(i, 12) * 30}ms` }, onclick: () => runSearch(c.query) },
    img(thumbUrl(c.cover.video_id, c.cover.ts_ms, 480)),
    h("span", {}, h("b", {}, c.label), h("small", {}, `${plural(c.frames, "moment")} · ${plural(c.videos, "video")}`))))
    : [h("p", { class: "muted" }, "Not enough footage to find topics yet. Add more videos.")]));
}
function renderStats(s) {
  const tile = (v, l) => h("div", { class: "stat" }, h("b", {}, v), h("span", {}, l));
  fill($("#stats"), tile(s.videos.toLocaleString(), s.videos === 1 ? "video" : "videos"), tile(fmtDur(s.seconds), "of footage"),
    tile(s.frames.toLocaleString(), "moments indexed"), tile(state.saved.length.toLocaleString(), "saved moments"));
}

/* ═════════════════════════════ saved ═════════════════════════════ */
async function loadSaved(render) {
  try {
    const { saved } = await api("/api/saved");
    state.saved = saved;
    $("#savedCount").hidden = !saved.length; $("#savedCount").textContent = saved.length;
    if (render || (state.view === "saved" && !playerOpen())) renderSaved();
  } catch { /* retry on next visit */ }
}
function renderSaved() {
  const items = state.saved;
  $("#savedEmpty").hidden = items.length > 0;
  $("#savedExport").hidden = !items.length;
  fill($("#savedGrid"), ...items.map((s, i) => {
    const note = h("input", { type: "text", value: s.note || "", placeholder: "Add a note…", "aria-label": "Note", maxlength: 500 });
    note.addEventListener("change", () => api(`/api/saved/${s.id}`, { method: "PATCH", json: { note: note.value } }).then(() => { s.note = note.value; toast("Note saved", "ok"); }, fail));
    note.addEventListener("keydown", (e) => { if (e.key === "Enter") note.blur(); });
    const sameVideo = items.filter((x) => x.video_id === s.video_id).sort((a, b) => a.ts_ms - b.ts_ms);
    return h("article", { class: "scard", style: { animationDelay: `${Math.min(i, 12) * 30}ms` } },
      momentCard({ videoId: s.video_id, ts: s.ts_ms, missing: !s.available,
        onClick: () => openPlayer({ video_id: s.video_id, name: s.name, duration: s.duration, heat: [], moments: sameVideo.map((x) => ({ ts_ms: x.ts_ms })), index: sameVideo.indexOf(s), query: "" }) }),
      h("div", { class: "body" },
        h("div", { class: "row" }, h("b", { title: s.path }, s.name), h("span", { class: "muted small" }, fmtTime(s.ts_ms)),
          h("button", { class: "icon-btn", type: "button", title: "Remove", "aria-label": "Remove saved moment", onclick: () => removeSaved(s) }, icon("trash"))),
        !s.available ? h("small", { class: "verr" }, "This video is no longer in your library") : null,
        note));
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
$("#savedExport").addEventListener("click", () => {
  const rows = [["video", "time", "seconds", "note", "path"]];
  state.saved.forEach((s) => rows.push([s.name, fmtTime(s.ts_ms), Math.round(s.ts_ms / 1000), s.note, s.path]));
  downloadCsv("sceneseek-saved.csv", rows);
});

/* ═════════════════════════════ library ═════════════════════════════ */
async function refreshVideos(force) {
  try {
    const { videos } = await api("/api/videos");
    const key = JSON.stringify(videos.map((v) => [v.id, v.status, v.frames, v.error, v.exists]));
    state.videos = videos;
    if (force || key !== state.videosKey) {
      state.videosKey = key;
      if (state.view === "library") renderLibrary();
      renderScopes();
    }
  } catch { /* server busy; the next poll retries */ }
}

function renderLibrary() {
  const st = state.status;
  const folders = st ? st.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready");
  $("#libSummary").textContent = ready.length
    ? `${plural(ready.length, "video")} · ${fmtDur(ready.reduce((a, v) => a + v.duration, 0))} of footage · ${fmtSize(ready.reduce((a, v) => a + v.size, 0))}`
    : "Nothing indexed yet.";
  fill($("#folderChips"), ...folders.map((f) => h("span", { class: "chip", title: f }, icon("folder"), f.split(/[\\/]/).filter(Boolean).pop() || f,
    h("button", { class: "x", type: "button", "aria-label": "Stop watching " + f, onclick: () => unwatch(f) }, "×"))));
  const q = $("#libFilter").value.trim().toLowerCase(), sort = $("#libSort").value, stat = state.libStatus;
  const list = state.videos.filter((v) => v.name.toLowerCase().includes(q) &&
    (stat === "all" || (stat === "ready" && v.status === "ready") || (stat === "busy" && (v.status === "queued" || v.status === "indexing")) || (stat === "error" && (v.status === "error" || !v.exists))));
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "duration") list.sort((a, b) => b.duration - a.duration);
  if (sort === "size") list.sort((a, b) => b.size - a.size);
  $("#libTools").hidden = !state.videos.length;
  $("#libEmpty").hidden = state.videos.length > 0;
  $("#libNone").hidden = !state.videos.length || list.length > 0;
  $$("#libStatus button").forEach((b) => b.classList.toggle("on", b.dataset.v === stat));
  $$("#libView button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.libView));
  $("#videoGrid").className = "vgrid" + (prefs.libView === "list" ? " list" : "");
  fill($("#videoGrid"), ...list.map(videoCard));
}
$("#libFilter").addEventListener("input", renderLibrary);
$("#libSort").addEventListener("change", renderLibrary);
$("#libStatus").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { state.libStatus = b.dataset.v; renderLibrary(); } });
$("#libView").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setPref("libView", b.dataset.v); renderLibrary(); } });

const openWhole = (v) => openPlayer({ video_id: v.id, name: v.name, duration: v.duration, heat: [], moments: [], index: 0, startAt: 0, query: "" });

function videoCard(v) {
  const playable = v.exists && v.frames > 0;
  const meta = [v.duration ? fmtTime(v.duration * 1000) : "", v.width ? `${v.width}×${v.height}` : "", fmtSize(v.size)].filter(Boolean).join(" · ");
  const label = { ready: `Ready · ${plural(v.frames, "moment")}`, queued: "Waiting", indexing: "Indexing…", error: "Could not index" }[v.status] || v.status;
  const cur = state.status && state.status.indexing.current;
  const pct = cur && cur.video_id === v.id ? cur.pct : 0;
  return h("article", { class: "vcard", "data-id": v.id },
    playable
      ? momentCard({ videoId: v.id, ts: v.poster_ms, label: fmtTime(v.duration * 1000), onClick: () => openWhole(v) })
      : h("div", { class: "mcard missing", style: { display: "grid", placeItems: "center", color: "var(--faint)" } }, icon(v.status === "error" || !v.exists ? "alert" : "film")),
    v.status === "indexing" || v.status === "queued" ? h("div", { class: "vprog" }, h("i", { "data-prog": v.id, style: { width: pct + "%" } })) : null,
    h("div", { class: "vbody" },
      h("div", { class: "vname", title: v.path }, v.name),
      h("div", { class: "vmeta" }, meta),
      v.error ? h("div", { class: "verr" }, v.error) : null,
      !v.exists ? h("div", { class: "verr" }, "The file has moved or been deleted") : null,
      h("div", { class: "vfoot" }, h("span", { class: `status ${v.status}`, "data-live": v.id }, label),
        h("span", { class: "actions" },
          v.exists ? h("button", { class: "icon-btn", type: "button", title: "Show file", "aria-label": "Show " + v.name + " in its folder", onclick: () => api(`/api/videos/${v.id}/reveal`, { method: "POST" }).catch(fail) }, icon("folder")) : null,
          h("button", { class: "icon-btn", type: "button", title: "Index again", "aria-label": "Index " + v.name + " again", onclick: () => api(`/api/videos/${v.id}/reindex`, { method: "POST" }).then(() => { toast("Queued again"); poll(); refreshVideos(true); }, fail) }, icon("refresh")),
          h("button", { class: "icon-btn", type: "button", title: "Remove from library", "aria-label": "Remove " + v.name, onclick: () => removeVideo(v) }, icon("trash"))))));
}

function updateLiveCards(st) {
  const cur = st.indexing.current;
  if (!cur) return;
  const s = $(`[data-live="${cur.video_id}"]`);
  if (s) { s.textContent = `Indexing ${Math.round(cur.pct)}%`; s.className = "status indexing"; }
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
  try { await api(`/api/folders?path=${encodeURIComponent(folder)}&remove_videos=${removeVideos}`, { method: "DELETE" }); await poll(); refreshVideos(true); } catch (e) { fail(e); }
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
  api("/api/clear", { method: "POST" }).then(() => { state.results = null; state.concepts = null; setSearchMode(false); poll(); refreshVideos(true); toast("Index cleared", "ok"); }, fail);
});

/* ═════════════════════════════ command palette ═════════════════════════════ */
const PAL = { items: [], i: 0 };
function openPalette() {
  $("#palette").hidden = false;
  $("#palQ").value = "";
  renderPalette();
  setTimeout(() => $("#palQ").focus(), 10);
}
const closePalette = () => { $("#palette").hidden = true; };
function palItems(q) {
  const lc = q.toLowerCase(), out = [];
  const match = (s) => !lc || s.toLowerCase().includes(lc);
  const searchItem = q ? { sec: "Search", icon: "search", label: `Search for “${q}”`, run: () => runSearch(q) } : null;
  const nav = [["Search", "search", "search"], ["Explore", "compass", "explore"], ["Saved moments", "star", "saved"], ["Library", "film", "library"], ["Settings", "gear", "settings"]];
  nav.filter(([l]) => match(l)).forEach(([l, ic, p]) => out.push({ sec: "Go to", icon: ic, label: l, run: () => go(p) }));
  const ix = state.status && state.status.indexing;
  const cmds = [["Add a folder", "folder", () => pickAndQueue("folder")], ["Add videos", "plus", () => pickAndQueue("files")], ["Look for new videos", "refresh", rescan],
    ["Switch light or dark theme", "sun", toggleTheme], ["Search with an image", "camera", () => { go("search"); $("#imgInput").click(); }], ["Keyboard shortcuts", "keyboard", () => ($("#keys").hidden = false)]];
  if (ix && (ix.current || ix.pending)) cmds.unshift([ix.paused ? "Resume indexing" : "Pause indexing", ix.paused ? "play" : "pause", pauseResume]);
  cmds.filter(([l]) => match(l)).forEach(([l, ic, fn]) => out.push({ sec: "Commands", icon: ic, label: l, run: fn }));
  if (!q) historyList().slice(0, 5).forEach((t) => out.push({ sec: "Recent searches", icon: "refresh", label: t, run: () => runSearch(t) }));
  (state.concepts || []).filter((c) => q && match(c.label)).slice(0, 4).forEach((c) =>
    out.push({ sec: "Topics", thumb: thumbUrl(c.cover.video_id, c.cover.ts_ms, 120), label: c.label, hint: plural(c.frames, "moment"), run: () => runSearch(c.query) }));
  state.videos.filter((v) => q && v.status === "ready" && match(v.name)).slice(0, 6).forEach((v) =>
    out.push({ sec: "Videos", thumb: thumbUrl(v.id, v.poster_ms, 120), label: v.name, hint: fmtTime(v.duration * 1000), run: () => openWhole(v) }));
  // a page or command whose name starts with what you typed wins Enter; otherwise searching does
  if (searchItem) {
    const lead = out.findIndex((it) => (it.sec === "Go to" || it.sec === "Commands") && it.label.toLowerCase().startsWith(lc));
    if (lead < 0) out.unshift(searchItem);
    else {
      const after = out.findIndex((it) => it.sec !== "Go to" && it.sec !== "Commands");
      if (after < 0) out.push(searchItem); else out.splice(after, 0, searchItem);
    }
  }
  return out;
}
function renderPalette() {
  PAL.items = palItems($("#palQ").value.trim());
  PAL.i = 0;
  let sec = "";
  const nodes = [];
  PAL.items.forEach((it, k) => {
    if (it.sec !== sec) { sec = it.sec; nodes.push(h("div", { class: "pal-sec" }, sec)); }
    nodes.push(h("button", { class: "pal-item" + (k === 0 ? " on" : ""), type: "button", role: "option", "data-k": k, onclick: () => runPal(k), onmousemove: () => palMark(k) },
      it.thumb ? img(it.thumb) : icon(it.icon), h("span", {}, it.label), it.hint ? h("small", {}, it.hint) : null));
  });
  fill($("#palList"), ...(nodes.length ? nodes : [h("p", { class: "muted small", style: { padding: "12px" } }, "Nothing found")]));
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
    if (playerOpen() && !document.fullscreenElement) return closePlayer();
  }
  if (!$("#palette").hidden || e.ctrlKey || e.metaKey || e.altKey) return;
  if (playerOpen()) {
    if (typing(e.target)) return;
    const v = pv(), k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
    else if (k === "arrowright") { e.preventDefault(); v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 5); }
    else if (k === "arrowleft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 5); }
    else if (k === "]") { if (P.i < P.ctx.moments.length - 1) seekMoment(P.i + 1); }
    else if (k === "[") { if (P.i > 0) seekMoment(P.i - 1); }
    else if (k === "s") toggleSave();
    else if (k === "m") v.muted = !v.muted;
    else if (k === "f") { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else $(".stage").requestFullscreen?.().catch(() => {}); }
    return;
  }
  if (typing(e.target)) return;
  if (e.key === "/") { e.preventDefault(); go("search"); setTimeout(() => $("#q").focus(), 30); }
  else if (e.key === "?") $("#keys").hidden = false;
  else if (e.key === "g") gPending = Date.now();
  else if (Date.now() - gPending < 1200) {
    const to = { s: "saved", e: "explore", l: "library", x: "settings", h: "search" }[e.key];
    gPending = 0;
    if (to) go(to);
  }
});

/* ═════════════════════════════ start ═════════════════════════════ */
$$("#viewMode button").forEach((b) => b.classList.toggle("on", b.dataset.v === prefs.view));
refreshVideos().then(() => loadSaved()).then(poll);
