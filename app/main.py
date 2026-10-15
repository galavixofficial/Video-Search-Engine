"""Sceneseek API and web UI server. Everything runs on this computer; nothing is uploaded."""
from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import platform
import re
import time
import shutil
import subprocess
import threading
from collections import OrderedDict
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import clip, picker
from .config import APP_NAME, VERSION, VIDEO_EXTENSIONS, Settings, data_dir, resource_dir
from .explore import Explorer
from .indexer import Indexer
from .store import Store, path_key

ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
SPEED_THREADS = {"balanced": max(1, (os.cpu_count() or 4) // 2), "max": 0}


_NEG = re.compile(r'(?:^|\s)-(?:"([^"]+)"|(\S+))')


def parse_query(text: str) -> tuple[list[str], list[str]]:
    """Split a query into things to find and things to avoid."""
    neg = [a or b for a, b in _NEG.findall(text)]
    rest = _NEG.sub(" ", text)
    pos = [p.strip() for p in re.split(r"\+|,", rest) if p.strip()]
    return pos, [n.strip() for n in neg if n.strip()]


class Engine:
    """Owns the long-lived pieces: settings, library, model, indexer."""

    def __init__(self, home: Path | None = None):
        self.home = home or data_dir()
        self.home.mkdir(parents=True, exist_ok=True)
        self.settings = Settings(self.home / "settings.json")
        self.store = Store(self.home / "library.db")
        self.downloader = clip.Downloader()
        self._encoder = None
        self._encoder_key = None
        self._enc_lock = threading.Lock()
        self._qcache: OrderedDict[str, np.ndarray] = OrderedDict()
        self.indexer = Indexer(self.store, self.encoder, self.settings.get)
        self.explorer = Explorer(self.store, self.encoder)
        self.thumbs = self.home / "thumbs"
        self.thumbs.mkdir(exist_ok=True)
        self.uploads = self.home / "videos"
        self.meta_path = self.home / "index_meta.json"

    # model ----------------------------------------------------
    def index_quality(self) -> str | None:
        try:
            return json.loads(self.meta_path.read_text(encoding="utf8")).get("quality")
        except (OSError, ValueError):
            return None

    def encoder(self):
        cfg = self.settings.get()
        key = (cfg["quality"], cfg["speed"])
        with self._enc_lock:
            if self._encoder is None or self._encoder_key != key:
                if not clip.models_present(cfg["quality"]):
                    raise RuntimeError("The search model has not been downloaded yet.")
                self._encoder = clip.ClipEncoder(cfg["quality"], SPEED_THREADS[cfg["speed"]])
                self._encoder_key = key
                self._qcache.clear()
            return self._encoder

    def ready(self) -> bool:
        return clip.models_present(self.settings.get()["quality"])

    def note_index_quality(self):
        self.meta_path.write_text(json.dumps({"quality": self.settings.get()["quality"]}), encoding="utf8")

    def _phrase_vector(self, text: str) -> np.ndarray:
        key = text.strip().lower()
        if key in self._qcache:
            self._qcache.move_to_end(key)
            return self._qcache[key]
        enc = self.encoder()
        texts = [text] + ([f"a photo of {text}"] if len(text.split()) <= 6 else [])
        v = enc.encode_text(texts).mean(axis=0)
        v = (v / max(float(np.linalg.norm(v)), 1e-12)).astype(np.float32)
        self._qcache[key] = v
        while len(self._qcache) > 256:
            self._qcache.popitem(last=False)
        return v

    def text_vector(self, text: str) -> np.ndarray:
        """Turn a query into one vector. `a + b` asks for both, `-word` or `-"two words"` pushes results away."""
        pos, neg = parse_query(text)
        if not pos:
            raise HTTPException(400, "Describe what you are looking for, not only what to leave out.")
        v = np.mean([self._phrase_vector(p) for p in pos], axis=0)
        v = v / max(float(np.linalg.norm(v)), 1e-12)
        if neg:
            n = np.mean([self._phrase_vector(p) for p in neg], axis=0)
            n = n / max(float(np.linalg.norm(n)), 1e-12)
            v = v - 0.35 * n
            v = v / max(float(np.linalg.norm(v)), 1e-12)
        return v.astype(np.float32)

    # files ----------------------------------------------------
    def rescan(self) -> int:
        folders = [f for f in self.settings.get()["folders"] if os.path.isdir(f)]
        return self.indexer.enqueue(folders)

    def thumb(self, video_id: int, t_ms: int, width: int) -> Path | None:
        row = self.store.get_video(video_id)
        if not row or not os.path.isfile(row["path"]):
            return None
        out = self.thumbs / f"{video_id}_{max(0, t_ms) // 250}_{width}.jpg"
        if out.exists():
            return out
        cap = cv2.VideoCapture(row["path"])
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0, t_ms))
            ok, frame = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                ok, frame = cap.read()
        finally:
            cap.release()
        if not ok:
            return None
        h, w = frame.shape[:2]
        if w > width:
            frame = cv2.resize(frame, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
        return out

    def video_payload(self, row) -> dict:
        d = dict(row)
        d.pop("key", None)
        d["exists"] = os.path.isfile(row["path"])
        d["poster_ms"] = int(row["duration"] * 1000 * 0.1)
        return d

    def reset_library(self):
        self.indexer.cancel()
        self.store.clear_all()
        shutil.rmtree(self.thumbs, ignore_errors=True)
        self.thumbs.mkdir(exist_ok=True)


def _reveal(path: str):
    system = platform.system()
    if system == "Windows":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif system == "Darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(path)])


def create_app(engine: Engine | None = None) -> FastAPI:
    eng = engine or Engine()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if eng.ready():
            threading.Thread(target=eng.rescan, daemon=True).start()
        yield
        eng.indexer.stop = True

    app = FastAPI(title=APP_NAME, version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.engine = eng

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        """This server controls files on your computer, so it only answers to the local machine's own pages."""
        raw = request.headers.get("host") or ""
        host = raw[: raw.index("]") + 1] if raw.startswith("[") and "]" in raw else raw.split(":")[0]
        if host not in ALLOWED_HOSTS:
            return JSONResponse({"error": "Forbidden"}, status_code=403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("origin")
            if origin and origin.split("://", 1)[-1] != request.headers.get("host"):
                return JSONResponse({"error": "Forbidden"}, status_code=403)
        response = await call_next(request)
        if not request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-cache"   # always pick up a new version of the UI
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def need_model():
        if not eng.ready():
            raise HTTPException(409, "The search model is not downloaded yet.")

    # ── status / settings ───────────────────────────────────────
    @app.get("/api/status")
    def status():
        cfg = eng.settings.get()
        return {
            "app": APP_NAME, "version": VERSION,
            "ready": eng.ready(), "quality": cfg["quality"],
            "models": {q: clip.models_present(q) for q in ("fast", "best")},
            "download": eng.downloader.snapshot(),
            "stats": eng.store.stats(), "indexing": eng.indexer.snapshot(),
            "settings": cfg, "data_dir": str(eng.home),
            "index_quality": eng.index_quality(),
        }

    @app.post("/api/settings")
    async def set_settings(request: Request):
        body = await request.json()
        cfg = eng.settings.get()
        new_quality = body.get("quality")
        if new_quality and new_quality != cfg["quality"]:
            if not clip.models_present(new_quality):
                raise HTTPException(409, "Download that model first.")
            if eng.store.stats()["frames"] and not body.get("confirm_reindex"):
                raise HTTPException(409, "Changing quality means indexing your videos again. Confirm to continue.")
            known = [v["path"] for v in eng.store.list_videos()]
            eng.reset_library()
            eng.settings.update(body)
            eng.note_index_quality()
            eng.indexer.enqueue(known)
            return eng.settings.get()
        return eng.settings.update(body)

    @app.post("/api/models/download")
    async def download(request: Request):
        body = await request.json()
        quality = body.get("quality", "fast")
        if quality not in ("fast", "best"):
            raise HTTPException(400, "Unknown quality")
        if not eng.store.stats()["frames"] and not eng.ready():
            eng.settings.update({"quality": quality})   # first run: nothing indexed yet, so switching is free
        eng.downloader.start(quality)
        return eng.downloader.snapshot()

    # ── indexing ────────────────────────────────────────────────
    @app.post("/api/index/paths")
    async def index_paths(request: Request):
        need_model()
        body = await request.json()
        paths = [p for p in body.get("paths", []) if isinstance(p, str) and os.path.exists(p)]
        if not paths:
            raise HTTPException(400, "None of those files or folders exist.")
        watch = bool(body.get("watch"))
        if watch:
            cfg = eng.settings.get()
            folders = list(cfg["folders"])
            for p in paths:
                if os.path.isdir(p) and path_key(p) not in {path_key(f) for f in folders}:
                    folders.append(os.path.abspath(p))
            eng.settings.update({"folders": folders})
        added = eng.indexer.enqueue(paths)
        if added:
            eng.note_index_quality()
        return {"queued": added}

    @app.post("/api/index/upload")
    async def upload(files: list[UploadFile] = File(...)):
        need_model()
        eng.uploads.mkdir(exist_ok=True)
        saved = []
        for f in files:
            name = os.path.basename(f.filename or "video")
            if Path(name).suffix.lower() not in VIDEO_EXTENSIONS:
                continue
            dest = eng.uploads / name
            n = 1
            while dest.exists():
                dest = eng.uploads / f"{Path(name).stem}_{n}{Path(name).suffix}"
                n += 1
            with open(dest, "wb") as out:
                shutil.copyfileobj(f.file, out)
            saved.append(str(dest))
        if not saved:
            raise HTTPException(400, "No video files in that upload.")
        eng.note_index_quality()
        return {"queued": eng.indexer.enqueue(saved)}

    @app.post("/api/index/control")
    async def control(request: Request):
        action = (await request.json()).get("action")
        if action == "pause":
            eng.indexer.pause(True)
        elif action == "resume":
            eng.indexer.pause(False)
        elif action == "cancel":
            eng.indexer.cancel()
        elif action == "clear_errors":
            eng.indexer.reset_errors()
        else:
            raise HTTPException(400, "Unknown action")
        return eng.indexer.snapshot()

    @app.post("/api/rescan")
    def rescan():
        need_model()
        return {"queued": eng.rescan()}

    @app.post("/api/pick")
    async def pick(request: Request):
        kind = (await request.json()).get("kind", "files")
        paths = picker.pick("folder" if kind == "folder" else "files")
        return {"paths": paths}

    @app.get("/api/folders")
    def folders():
        return {"folders": eng.settings.get()["folders"]}

    @app.delete("/api/folders")
    def remove_folder(path: str, remove_videos: bool = False):
        cfg = eng.settings.get()
        keep = [f for f in cfg["folders"] if path_key(f) != path_key(path)]
        eng.settings.update({"folders": keep})
        removed = 0
        if remove_videos:
            prefix = path_key(path) + os.sep
            for v in eng.store.list_videos():
                if path_key(v["path"]).startswith(prefix):
                    removed += eng.store.delete_video(v["id"])
        return {"removed": removed}

    # ── library ─────────────────────────────────────────────────
    @app.get("/api/videos")
    def videos():
        return {"videos": [eng.video_payload(r) for r in eng.store.list_videos()]}

    @app.delete("/api/videos/{video_id}")
    def delete_video(video_id: int):
        if not eng.store.delete_video(video_id):
            raise HTTPException(404, "Video not found")
        return {"ok": True}

    @app.post("/api/videos/{video_id}/reindex")
    def reindex(video_id: int):
        need_model()
        row = eng.store.get_video(video_id)
        if not row:
            raise HTTPException(404, "Video not found")
        eng.store.update_video(video_id, status="queued", mtime=0)
        return {"queued": eng.indexer.enqueue([row["path"]])}

    @app.post("/api/clear")
    def clear():
        eng.reset_library()
        return {"ok": True}

    # ── search ──────────────────────────────────────────────────
    def _ids(video_ids: str | None):
        if not video_ids:
            return None
        return {int(x) for x in video_ids.split(",") if x.strip().isdigit()} or None

    def _scope(video_ids: str | None, folder: str | None):
        ids = _ids(video_ids)
        if folder:
            prefix = path_key(folder) + os.sep
            in_folder = {v["id"] for v in eng.store.list_videos() if path_key(v["path"]).startswith(prefix)}
            ids = in_folder if ids is None else ids & in_folder
            if not ids:
                ids = {-1}
        return ids

    @app.get("/api/search")
    def search(q: str, k: int = 24, per_video: int = 3, video_ids: str | None = None, folder: str | None = None,
               min_percent: float = 0):
        need_model()
        q = q.strip()
        if not q:
            raise HTTPException(400, "Type something to search for.")
        t0 = time.perf_counter()
        results = eng.store.search(eng.text_vector(q), "text", k=min(max(k, 1), 60), per_video=min(max(per_video, 1), 12),
                                   video_ids=_scope(video_ids, folder), min_percent=max(0.0, min(min_percent, 100.0)))
        pos, neg = parse_query(q)
        return {"query": q, "terms": pos, "excluded": neg, "results": results, "total_frames": eng.store.n,
                "took_ms": round((time.perf_counter() - t0) * 1000)}

    @app.post("/api/search/image")
    async def search_image(file: UploadFile = File(...)):
        need_model()
        try:
            img = np.asarray(Image.open(io.BytesIO(await file.read())).convert("RGB"))
        except Exception:
            raise HTTPException(400, "That does not look like an image.")
        vec = eng.encoder().encode_images([img])[0]
        return {"query": "image", "results": eng.store.search(vec, "image", k=24, per_video=4), "total_frames": eng.store.n}

    @app.get("/api/similar")
    def similar(video_id: int, ts_ms: int, k: int = 24):
        need_model()
        hit = eng.store.nearest_frame(video_id, ts_ms)
        if hit is None:
            raise HTTPException(404, "Moment not found")
        vec, fid = hit
        return {"query": "similar", "results": eng.store.search(vec, "image", k=min(max(k, 1), 60), per_video=4, exclude_frame=fid),
                "total_frames": eng.store.n}

    # ── explore / saved / scenes ────────────────────────────────
    @app.get("/api/explore")
    def explore():
        need_model()
        return {"concepts": eng.explorer.overview(eng.settings.get()["quality"]), "stats": eng.store.stats()}

    @app.get("/api/videos/{video_id}/scenes")
    def scenes(video_id: int):
        if not eng.store.get_video(video_id):
            raise HTTPException(404, "Video not found")
        return {"scenes": eng.store.scenes(video_id)}

    @app.get("/api/saved")
    def saved():
        items = eng.store.list_saved()
        for it in items:
            row = eng.store.get_video(it["video_id"]) if it["video_id"] else None
            it["duration"] = row["duration"] if row else 0
            it["available"] = bool(row) and os.path.isfile(row["path"])
        return {"saved": items}

    @app.post("/api/saved")
    async def add_saved(request: Request):
        body = await request.json()
        res = eng.store.add_saved(int(body.get("video_id", 0)), int(body.get("ts_ms", 0)), str(body.get("note", "")))
        if res is None:
            raise HTTPException(404, "Video not found")
        return res

    @app.patch("/api/saved/{saved_id}")
    async def edit_saved(saved_id: int, request: Request):
        if not eng.store.update_saved(saved_id, str((await request.json()).get("note", ""))):
            raise HTTPException(404, "Not found")
        return {"ok": True}

    @app.delete("/api/saved/{saved_id}")
    def delete_saved(saved_id: int):
        if not eng.store.delete_saved(saved_id):
            raise HTTPException(404, "Not found")
        return {"ok": True}

    def frames_dir() -> Path:
        return Path(os.environ.get("SCENESEEK_FRAMES") or (Path.home() / "Pictures" / APP_NAME))

    @app.post("/api/videos/{video_id}/save-frame")
    async def save_frame(video_id: int, request: Request):
        """Save the full-resolution frame at a moment to Pictures/Sceneseek."""
        ts_ms = int((await request.json()).get("ts_ms", 0))
        path = _row_path(video_id)
        cap = cv2.VideoCapture(path)
        try:
            cap.set(cv2.CAP_PROP_POS_MSEC, max(0, ts_ms))
            ok, frame = cap.read()
        finally:
            cap.release()
        if not ok:
            raise HTTPException(422, "Could not read that frame.")
        out_dir = frames_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        sec = ts_ms // 1000
        stamp = f"{sec // 3600:02d}h{sec % 3600 // 60:02d}m{sec % 60:02d}s"
        out = out_dir / f"{Path(path).stem}_{stamp}.jpg"
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        out.write_bytes(buf.tobytes())   # imencode + write_bytes also works for non-ASCII paths on Windows
        return {"path": str(out), "folder": str(out_dir)}

    @app.post("/api/reveal-path")
    async def reveal_path(request: Request):
        """Show a file Sceneseek itself saved (only inside its own frames folder)."""
        target = Path(str((await request.json()).get("path", ""))).resolve()
        allowed = frames_dir().resolve()
        if allowed not in target.parents or not target.exists():
            raise HTTPException(403, "Not allowed")
        _reveal(str(target))
        return {"ok": True}

    # ── media ───────────────────────────────────────────────────
    @app.get("/api/thumb/{video_id}")
    def thumb(video_id: int, t: int = 0, w: int = 480):
        p = eng.thumb(video_id, t, min(max(w, 120), 1280))
        if p is None:
            raise HTTPException(404, "No thumbnail")
        return FileResponse(p, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/video/{video_id}")
    def stream(video_id: int):
        row = eng.store.get_video(video_id)
        if not row or not os.path.isfile(row["path"]):
            raise HTTPException(404, "Video file not found")
        mime = mimetypes.guess_type(row["path"])[0] or "video/mp4"
        return FileResponse(row["path"], media_type=mime)

    def _row_path(video_id: int) -> str:
        row = eng.store.get_video(video_id)
        if not row or not os.path.isfile(row["path"]):
            raise HTTPException(404, "Video file not found")
        return row["path"]

    @app.post("/api/videos/{video_id}/reveal")
    def reveal(video_id: int):
        _reveal(_row_path(video_id))
        return {"ok": True}

    @app.post("/api/videos/{video_id}/open")
    def open_external(video_id: int):
        path = _row_path(video_id)
        if platform.system() == "Windows":
            os.startfile(path)  # noqa: S606 - the user asked to open their own file
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return {"ok": True}

    # ── web UI ──────────────────────────────────────────────────
    static = resource_dir() / "app" / "static"
    if static.is_dir():
        app.mount("/", StaticFiles(directory=str(static), html=True), name="ui")
    return app


app = None


def get_app() -> FastAPI:
    global app
    if app is None:
        app = create_app()
    return app
