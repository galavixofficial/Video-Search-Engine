"use strict";
/* Sceneseek web UI. Plain JavaScript, no build step, no external requests. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const icon = (name) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "ic"); s.innerHTML = `<use href="#i-${name}"/>`; return s; };

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

function toast(msg, kind = "") {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, msg);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "err" ? 7000 : 4000);
}
const fail = (e) => toast(e.message || String(e), "err");

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}
function fmtDur(sec) {
  if (!sec) return "0m";
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  return m < 90 ? `${m} min` : `${(sec / 3600).toFixed(1)} h`;
}
function fmtSize(b) {
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const thumb = (id, t, w = 480) => `/api/thumb/${id}?t=${Math.round(t)}&w=${w}`;
const scoreClass = (p) => (p >= 75 ? "s3" : p >= 55 ? "s2" : "s1");
const scoreLabel = (p) => (p >= 75 ? "Strong match" : p >= 55 ? "Good match" : "Possible match");

/* ── state ─────────────────────────────────────────────────── */
const state = { status: null, videos: [], results: null, query: "", view: "", videosKey: "" };
const store = {
  get(k, d) { try { const v = localStorage.getItem("sceneseek." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("sceneseek." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/* ── theme ─────────────────────────────────────────────────── */
function applyTheme(t) { document.documentElement.dataset.theme = t; store.set("theme", t); }
applyTheme(store.get("theme", matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#themeBtn").addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

/* ── routing ───────────────────────────────────────────────── */
function route() {
  let name = (location.hash || "#search").slice(1);
  if (!["search", "library", "settings"].includes(name)) name = "search";
  const st = state.status;
  const setupNeeded = st && !st.ready;
  const view = setupNeeded && name !== "settings" ? "setup" : name;
  state.view = view;
  if (playerOpen()) closePlayer();
  $$(".view").forEach((v) => (v.hidden = v.id !== view));
  $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name && view !== "setup"));
  if (view === "library") { refreshVideos(true); }
  if (view === "search") { renderScopes(); renderSearchEmpty(); if (!matchMedia("(pointer: coarse)").matches) $("#q").focus({ preventScroll: true }); }
  if (view === "settings") renderSettings();
}
addEventListener("hashchange", route);

/* ── status polling ────────────────────────────────────────── */
let pollTimer = null, lastCompleted = -1;
async function poll() {
  try {
    const st = await api("/api/status");
    const first = !state.status;
    const wasReady = state.status && state.status.ready;
    state.status = st;
    renderChrome(st);
    if (first || wasReady !== st.ready) route();
    if (st.ready && !wasReady && !first) { toast("The search model is ready. Add a folder of videos to begin.", "ok"); location.hash = "#library"; }
    const cur = st.indexing.current;
    if (st.indexing.completed !== lastCompleted) { lastCompleted = st.indexing.completed; if (state.view === "library") refreshVideos(); renderScopes(); }
    if (state.view === "library") updateLiveCards(st);
    if (state.view === "settings") renderModelProgress(st);
    if (state.view === "setup") renderSetup(st);
    const busy = cur || st.indexing.pending || st.download.active;
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, busy ? 1000 : 4000);
  } catch (e) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, 4000);
  }
}

function renderChrome(st) {
  const n = st.stats.videos;
  const lc = $("#libCount");
  lc.hidden = !n; lc.textContent = n;
  const ix = st.indexing;
  const busy = $("#busyPill");
  busy.hidden = !(ix.current || ix.pending);
  if (!busy.hidden) $("#busyText").textContent = ix.paused ? "Paused" : `Indexing ${plural(ix.pending + (ix.current ? 1 : 0), "video")}`;
  const dock = $("#dock");
  dock.hidden = !(ix.current || ix.pending);
  if (ix.current) {
    $("#dockName").textContent = ix.current.name;
    $("#dockFill").style.width = ix.current.pct + "%";
    const eta = ix.current.eta != null ? ` · about ${fmtDur(ix.current.eta)} left` : "";
    $("#dockInfo").textContent = `${Math.round(ix.current.pct)}%${eta}${ix.pending ? ` · ${ix.pending} waiting` : ""}`;
  } else {
    $("#dockName").textContent = "Getting ready…";
    $("#dockInfo").textContent = "";
  }
  const pb = $("#dockPause");
  pb.replaceChildren(icon(ix.paused ? "play" : "pause"));
  pb.setAttribute("aria-label", ix.paused ? "Resume indexing" : "Pause indexing");
  ix.errors.forEach((e) => { if (!seenErrors.has(e)) { seenErrors.add(e); toast("Could not index " + e, "err"); } });
}
const seenErrors = new Set();
$("#busyPill").addEventListener("click", () => (location.hash = "#library"));
$("#dockPause").addEventListener("click", () => api("/api/index/control", { json: { action: state.status.indexing.paused ? "resume" : "pause" } }).then(poll, fail));
$("#dockCancel").addEventListener("click", () => { if (confirm("Stop indexing and clear the waiting list? Videos already finished stay in your library.")) api("/api/index/control", { json: { action: "cancel" } }).then(() => { poll(); refreshVideos(); }, fail); });

/* ── setup (first run) ─────────────────────────────────────── */
function renderSetup(st) {
  const d = st.download;
  const btn = $("#dlBtn");
  $("#dlBar").hidden = !(d.active || d.error || d.done);
  if (d.active) {
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    $("#dlFill").style.width = pct + "%";
    $("#dlText").textContent = d.total ? `Downloading… ${fmtSize(d.done)} of ${fmtSize(d.total)} (${pct}%)` : "Starting…";
    btn.disabled = true;
  } else {
    btn.disabled = false;
    $("#dlText").textContent = d.error ? `Download failed: ${d.error}` : "";
  }
}
$("#dlBtn").addEventListener("click", () => {
  const quality = $("input[name=q]:checked").value;
  api("/api/models/download", { json: { quality } }).then(poll, fail);
});

/* ── search ────────────────────────────────────────────────── */
const EXAMPLES = ["a person walking on a beach", "two people talking at a table", "a car driving at night", "fireworks in the sky", "a close-up of a cat", "a crowd cheering"];
$("#examples").replaceChildren(...EXAMPLES.map((t) => h("button", { class: "chip", type: "button", onclick: () => { $("#q").value = t; doSearch(t); } }, t)));

function renderScopes() {
  const sel = $("#scope");
  const keep = sel.value;
  const ready = state.videos.length ? state.videos : [];
  sel.replaceChildren(h("option", { value: "" }, "All videos"), ...ready.filter((v) => v.status === "ready").map((v) => h("option", { value: v.id }, v.name)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
}

function renderSearchEmpty() {
  if (state.results) return;
  const st = state.status;
  const el = $("#results");
  if (st && st.ready && !st.stats.videos && !st.indexing.current && !st.indexing.pending) {
    el.replaceChildren(h("div", { class: "empty" }, icon("film"), h("h2", {}, "Add some videos to search"),
      h("p", {}, "Point Sceneseek at a folder and it will index everything in the background."),
      h("a", { class: "btn primary", href: "#library" }, "Open the library")));
  } else el.replaceChildren();
}

const history = () => store.get("history", []);
function remember(q) { store.set("history", [q, ...history().filter((x) => x !== q)].slice(0, 8)); }
function showHistory() {
  const box = $("#history"), items = history().filter((x) => x.toLowerCase().includes($("#q").value.trim().toLowerCase()));
  if (!items.length || state.results && $("#q").value) { box.hidden = true; return; }
  box.replaceChildren(...items.map((t) => h("button", { type: "button", onmousedown: (e) => { e.preventDefault(); $("#q").value = t; doSearch(t); } }, icon("search"), t, h("small", {}, "recent"))));
  box.hidden = false;
}
$("#q").addEventListener("focus", showHistory);
$("#q").addEventListener("input", showHistory);
$("#q").addEventListener("blur", () => setTimeout(() => ($("#history").hidden = true), 100));
$("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); doSearch($("#q").value); });
$("#scope").addEventListener("change", () => state.query && doSearch(state.query));
$("#minMatch").addEventListener("change", () => state.query && doSearch(state.query));

function searching() {
  $("#results").replaceChildren(...[0, 1, 2].map(() => h("div", { class: "skeleton" })));
}

async function doSearch(q) {
  q = (q || "").trim();
  if (!q) return;
  $("#history").hidden = true;
  state.query = q;
  document.body.classList.add("searched");
  $("#examples").hidden = true;
  $("#filters").hidden = false;
  searching();
  const params = new URLSearchParams({ q, k: 30, min_percent: $("#minMatch").value });
  if ($("#scope").value) params.set("video_ids", $("#scope").value);
  try {
    const data = await api("/api/search?" + params);
    remember(q);
    showResults(data, `“${q}”`);
  } catch (e) { $("#results").replaceChildren(); fail(e); }
}

async function searchByImage(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Choose an image file.", "err");
  state.query = "";
  document.body.classList.add("searched");
  $("#examples").hidden = true;
  $("#filters").hidden = false;
  searching();
  const form = new FormData(); form.append("file", file);
  try { showResults(await api("/api/search/image", { form }), "your image"); } catch (e) { $("#results").replaceChildren(); fail(e); }
}
$("#imgBtn").addEventListener("click", () => $("#imgInput").click());
$("#imgInput").addEventListener("change", (e) => { searchByImage(e.target.files[0]); e.target.value = ""; });
$("#q").addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); searchByImage(f); } });

function showResults(data, label) {
  state.results = data.results;
  state.resultLabel = label;
  const el = $("#results");
  $("#exportBtn").hidden = !data.results.length;
  if (!data.results.length) {
    el.replaceChildren(h("div", { class: "empty" }, icon("search"), h("h2", {}, "Nothing matched"),
      h("p", {}, state.status && state.status.stats.videos ? "Try describing it differently, or set “Minimum match” to “Show everything”." : "There are no indexed videos yet. Add some in the Library.")));
    return;
  }
  const moments = data.results.reduce((n, r) => n + r.moments.length, 0);
  el.replaceChildren(
    h("p", { class: "summary" }, `${plural(moments, "moment")} in ${plural(data.results.length, "video")} for ${label}`),
    ...data.results.map((r) => resultCard(r)));
}

function resultCard(r) {
  return h("article", { class: "rcard" },
    h("div", { class: "rhead" }, h("span", { class: "rname", title: r.name }, r.name), h("span", { class: "rdur" }, fmtDur(r.duration)),
      h("span", { class: `score ${scoreClass(r.score)}` }, scoreLabel(r.score))),
    h("div", { class: "rmoments" }, r.moments.map((m, i) =>
      h("button", { class: "moment", type: "button", "aria-label": `Play ${r.name} at ${fmtTime(m.ts_ms)}`, onclick: () => openPlayer(r, i) },
        h("img", { src: thumb(r.video_id, m.ts_ms), alt: "", loading: "lazy" }),
        h("span", { class: "t" }, icon("play"), fmtTime(m.ts_ms)),
        h("span", { class: "p" }, Math.round(m.score) + "%")))));
}

$("#exportBtn").addEventListener("click", () => {
  const rows = [["video", "time", "seconds", "match_percent"]];
  (state.results || []).forEach((r) => r.moments.forEach((m) => rows.push([r.name, fmtTime(m.ts_ms), Math.round(m.ts_ms / 1000), m.score])));
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "sceneseek-results.csv" });
  a.click(); URL.revokeObjectURL(a.href);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !playerOpen()) { e.preventDefault(); location.hash = "#search"; $("#q").focus(); }
});

/* ── player ────────────────────────────────────────────────── */
const P = { r: null, i: 0 };
const playerOpen = () => !$("#player").hidden;
function openPlayer(r, i = 0) {
  P.r = r; P.i = i;
  const v = $("#pVideo");
  $("#pErr").hidden = true;
  $("#player").hidden = false;
  document.body.style.overflow = "hidden";
  $("#pName").textContent = r.name;
  $("#pMeta").textContent = `${fmtDur(r.duration)} · ${plural(r.moments.length, "matching moment")}`;
  $("#pMoments").replaceChildren(...r.moments.map((m, k) => h("button", { class: "mrow", type: "button", onclick: () => seekTo(k) },
    h("img", { src: thumb(r.video_id, m.ts_ms, 240), alt: "" }), h("span", {}, h("b", {}, fmtTime(m.ts_ms)), h("small", {}, Math.round(m.score) + "% match")))));
  v.src = `/api/video/${r.video_id}`;
  v.onloadedmetadata = () => seekTo(P.i, true);
  v.onerror = () => { $("#pErr").hidden = false; };
  v.load();
  $("#pClose").focus();
}
function seekTo(i, initial) {
  P.i = i;
  const v = $("#pVideo"), m = P.r.moments[i];
  $$("#pMoments .mrow").forEach((el, k) => el.classList.toggle("on", k === i));
  v.currentTime = Math.max(0, m.ts_ms / 1000 - 0.5);
  v.play().catch(() => {});
}
function closePlayer() {
  const v = $("#pVideo");
  v.pause(); v.removeAttribute("src"); v.load();
  $("#player").hidden = true;
  document.body.style.overflow = "";
}
$("#pClose").addEventListener("click", closePlayer);
$("#player").addEventListener("mousedown", (e) => { if (e.target.id === "player") closePlayer(); });
document.addEventListener("keydown", (e) => {
  if (!playerOpen()) return;
  if (e.key === "Escape") closePlayer();
  if (e.key === "ArrowRight" && e.target.tagName !== "VIDEO" && P.i < P.r.moments.length - 1) seekTo(P.i + 1);
  if (e.key === "ArrowLeft" && e.target.tagName !== "VIDEO" && P.i > 0) seekTo(P.i - 1);
});
$("#pReveal").addEventListener("click", () => api(`/api/videos/${P.r.video_id}/reveal`, { method: "POST" }).catch(fail));
const openExternal = () => api(`/api/videos/${P.r.video_id}/open`, { method: "POST" }).catch(fail);
$("#pOpen").addEventListener("click", openExternal);
$("#pOpenErr").addEventListener("click", openExternal);
$("#pCopy").addEventListener("click", () => {
  const text = `${P.r.name} @ ${fmtTime(P.r.moments[P.i].ts_ms)}`;
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast("Copied: " + text, "ok"), () => toast(text));
});
$("#pSimilar").addEventListener("click", async () => {
  const m = P.r.moments[P.i];
  closePlayer();
  location.hash = "#search";
  document.body.classList.add("searched"); $("#examples").hidden = true; $("#filters").hidden = false;
  searching();
  try { showResults(await api(`/api/similar?video_id=${P.r.video_id}&ts_ms=${m.ts_ms}`), `moments like ${P.r.name} at ${fmtTime(m.ts_ms)}`); } catch (e) { fail(e); }
});

/* ── library ───────────────────────────────────────────────── */
async function refreshVideos(force) {
  try {
    const { videos } = await api("/api/videos");
    const key = JSON.stringify(videos.map((v) => [v.id, v.status, v.frames, v.error]));
    state.videos = videos;
    if (force || key !== state.videosKey) { state.videosKey = key; renderLibrary(); renderScopes(); }
  } catch (e) { /* server busy; next poll will retry */ }
}

function renderLibrary() {
  const st = state.status;
  const folders = st ? st.settings.folders : [];
  const ready = state.videos.filter((v) => v.status === "ready");
  $("#libSummary").textContent = ready.length ? `${plural(ready.length, "video")}, ${fmtDur(ready.reduce((a, v) => a + v.duration, 0))} of footage, ${(st?.stats.frames || 0).toLocaleString()} moments indexed` : "Nothing indexed yet";
  $("#folderChips").replaceChildren(...folders.map((f) => h("span", { class: "chip", title: f }, icon("folder"), f.split(/[\\/]/).filter(Boolean).pop() || f,
    h("button", { class: "x", type: "button", "aria-label": "Stop watching " + f, style: "background:none;border:0;color:inherit;cursor:pointer;padding:0 0 0 4px", onclick: () => unwatch(f) }, "×"))));
  const q = $("#libFilter").value.trim().toLowerCase(), sort = $("#libSort").value;
  let list = state.videos.filter((v) => v.name.toLowerCase().includes(q));
  if (sort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === "duration") list.sort((a, b) => b.duration - a.duration);
  $("#libTools").hidden = state.videos.length < 2;
  $("#libEmpty").hidden = state.videos.length > 0;
  $("#drop").hidden = false;
  $("#videoGrid").replaceChildren(...list.map(videoCard));
}
$("#libFilter").addEventListener("input", renderLibrary);
$("#libSort").addEventListener("change", renderLibrary);

function videoCard(v) {
  const hasThumb = v.exists && v.frames > 0;
  const meta = [v.width ? `${v.width}×${v.height}` : "", fmtSize(v.size)].filter(Boolean).join(" · ");
  const label = { ready: `${plural(v.frames, "moment")} indexed`, queued: "Waiting", indexing: "Indexing…", error: "Could not index" }[v.status] || v.status;
  return h("article", { class: "vcard" + (v.exists ? "" : " missing"), "data-id": v.id },
    h("button", { class: "vthumb", type: "button", style: "border:0;padding:0;cursor:pointer;width:100%", "aria-label": "Play " + v.name, disabled: !hasThumb,
      onclick: () => openPlayer({ video_id: v.id, name: v.name, duration: v.duration, moments: [{ ts_ms: v.poster_ms, score: 100 }] }) },
      hasThumb ? h("img", { src: thumb(v.id, v.poster_ms), alt: "", loading: "lazy" }) : null, v.duration ? h("span", { class: "badge" }, fmtTime(v.duration * 1000)) : null),
    h("div", { class: "vbody" },
      h("div", { class: "vname", title: v.path }, v.name),
      h("div", { class: "vmeta" }, meta),
      v.error ? h("div", { class: "verr" }, v.error) : null,
      !v.exists ? h("div", { class: "verr" }, "File is missing from its folder") : null,
      h("div", { class: "vfoot" }, h("span", { class: `status ${v.status}`, "data-live": v.id }, label),
        h("span", { class: "actions" },
          h("button", { class: "icon-btn", type: "button", title: "Index again", "aria-label": "Index " + v.name + " again", onclick: () => api(`/api/videos/${v.id}/reindex`, { method: "POST" }).then(() => { toast("Queued again"); poll(); refreshVideos(); }, fail) }, icon("refresh")),
          h("button", { class: "icon-btn", type: "button", title: "Remove from library", "aria-label": "Remove " + v.name, onclick: () => removeVideo(v) }, icon("trash"))))));
}

function updateLiveCards(st) {
  const cur = st.indexing.current;
  $$("[data-live]").forEach((el) => {
    if (cur && String(cur.video_id) === el.dataset.live) el.textContent = `Indexing ${Math.round(cur.pct)}%`;
  });
  const ready = state.videos.filter((v) => v.status === "ready");
  if (ready.length !== st.stats.videos) refreshVideos();
}

function removeVideo(v) {
  if (!confirm(`Remove “${v.name}” from Sceneseek?\n\nThe video file itself is not deleted.`)) return;
  api(`/api/videos/${v.id}`, { method: "DELETE" }).then(() => { refreshVideos(true); poll(); }, fail);
}
async function unwatch(folder) {
  if (!confirm(`Stop watching this folder for new videos?\n\n${folder}`)) return;
  const removeVideos = confirm("Also remove this folder's videos from the library?\n\nOK = remove them from Sceneseek (your files are never deleted).\nCancel = keep them.");
  try { await api(`/api/folders?path=${encodeURIComponent(folder)}&remove_videos=${removeVideos}`, { method: "DELETE" }); await poll(); refreshVideos(true); } catch (e) { fail(e); }
}

async function queuePaths(paths, watch) {
  try {
    const { queued } = await api("/api/index/paths", { json: { paths, watch } });
    toast(queued ? `Indexing ${plural(queued, "video")}. You can search as soon as the first one finishes.` : "Those videos are already up to date.", queued ? "ok" : "");
    await poll(); refreshVideos(true);
  } catch (e) { fail(e); }
}
async function pickAndQueue(kind) {
  try {
    const { paths } = await api("/api/pick", { json: { kind } });
    if (paths.length) await queuePaths(paths, kind === "folder");
  } catch (e) { fail(e); }
}
$("#addFolder").addEventListener("click", () => pickAndQueue("folder"));
$("#addFiles").addEventListener("click", () => pickAndQueue("files"));
$("#rescan").addEventListener("click", () => api("/api/rescan", { method: "POST" }).then((r) => { toast(r.queued ? `Found ${plural(r.queued, "new video")}.` : "Nothing new found.", r.queued ? "ok" : ""); poll(); }, fail));

const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); if (state.view === "library") drop.classList.add("over"); } }));
["dragleave", "drop"].forEach((ev) => addEventListener(ev, () => drop.classList.remove("over")));
addEventListener("drop", async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  if (state.view !== "library") location.hash = "#library";
  if (window.pywebview) { toast("Adding your videos…"); setTimeout(() => { poll(); refreshVideos(true); }, 800); return; }   // the desktop window indexes dropped files itself
  const files = [...e.dataTransfer.files];
  const local = files.map((f) => f.pywebviewFullPath || f.path).filter(Boolean);
  if (local.length === files.length) return queuePaths(local, false);
  toast(`Copying ${plural(files.length, "file")} into Sceneseek's own folder…`);
  const form = new FormData(); files.forEach((f) => form.append("files", f));
  try { const r = await api("/api/index/upload", { form }); toast(`Indexing ${plural(r.queued, "video")}.`, "ok"); poll(); refreshVideos(true); } catch (err) { fail(err); }
});
$("#fileInput").addEventListener("change", async (e) => {
  const form = new FormData(); [...e.target.files].forEach((f) => form.append("files", f));
  try { await api("/api/index/upload", { form }); poll(); refreshVideos(true); } catch (err) { fail(err); }
  e.target.value = "";
});

/* ── settings ──────────────────────────────────────────────── */
function dedupeLabel(v) { return v == 0 ? "Off" : v <= 0.3 ? "Low" : v <= 0.6 ? "Medium" : "High"; }
function renderSettings() {
  const st = state.status; if (!st) return;
  const c = st.settings;
  $("#sInterval").value = c.interval; $("#oInterval").textContent = `every ${c.interval} s`;
  $("#sDedupe").value = c.dedupe; $("#oDedupe").textContent = dedupeLabel(c.dedupe);
  $$("#sSpeed button").forEach((b) => b.classList.toggle("on", b.dataset.v === c.speed));
  $$("#sQuality button").forEach((b) => b.classList.toggle("on", b.dataset.v === c.quality));
  $("#modelHelp").textContent = c.quality === "best" ? "You are using the full-precision model: most accurate, slower to index." : "You are using the small, fast model. Switch to Best for slightly sharper results; your videos will be indexed again.";
  $("#dataDir").textContent = st.data_dir;
  $("#aboutVersion").textContent = "v" + st.version;
  renderModelProgress(st);
}
function renderModelProgress(st) {
  const d = st.download, on = d.active;
  $("#mdlBar").hidden = !on;
  if (on) { const pct = d.total ? Math.round(d.done / d.total * 100) : 0; $("#mdlFill").style.width = pct + "%"; $("#mdlText").textContent = `Downloading the ${d.quality} model… ${pct}%`; }
  else if (d.error) $("#mdlText").textContent = "Download failed: " + d.error;
  else $("#mdlText").textContent = "";
  if (!on && pendingQuality && st.models[pendingQuality]) { const q = pendingQuality; pendingQuality = null; applyQuality(q); }
}
let saveTimer;
function save(change) { clearTimeout(saveTimer); saveTimer = setTimeout(() => api("/api/settings", { json: change }).then(poll, fail), 350); }
$("#sInterval").addEventListener("input", (e) => { $("#oInterval").textContent = `every ${e.target.value} s`; save({ interval: +e.target.value }); });
$("#sDedupe").addEventListener("input", (e) => { $("#oDedupe").textContent = dedupeLabel(+e.target.value); save({ dedupe: +e.target.value }); });
$("#sSpeed").addEventListener("click", (e) => { const v = e.target.dataset?.v; if (v) api("/api/settings", { json: { speed: v } }).then(() => poll().then(renderSettings), fail); });
let pendingQuality = null;
async function applyQuality(q) {
  const need = state.status.stats.frames > 0;
  if (need && !confirm("Switching the model means all your videos are indexed again. Continue?")) return;
  try { await api("/api/settings", { json: { quality: q, confirm_reindex: true } }); toast("Switched. Re-indexing your videos…", "ok"); await poll(); renderSettings(); } catch (e) { fail(e); }
}
$("#sQuality").addEventListener("click", async (e) => {
  const q = e.target.dataset?.v;
  if (!q || q === state.status.settings.quality) return;
  if (state.status.models[q]) return applyQuality(q);
  if (!confirm(`Download the ${q === "best" ? "Best (about 600 MB)" : "Fast (about 150 MB)"} model now?`)) return;
  pendingQuality = q;
  api("/api/models/download", { json: { quality: q } }).then(poll, fail);
});
$("#clearAll").addEventListener("click", () => {
  if (!confirm("Clear the whole index? Your videos are not deleted, but you will need to add them again.")) return;
  api("/api/clear", { method: "POST" }).then(() => { state.results = null; poll(); refreshVideos(true); toast("Index cleared", "ok"); }, fail);
});

/* ── go ────────────────────────────────────────────────────── */
refreshVideos().then(poll);
