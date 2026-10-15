"""Background indexing: reads videos, samples frames, embeds them, stores the vectors."""
from __future__ import annotations

import os
import queue
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .config import VIDEO_EXTENSIONS
from .store import Store

BATCH = 16


def find_videos(path: str) -> list[str]:
    """A video file, or every video under a folder."""
    p = Path(path)
    if p.is_file():
        return [str(p)] if p.suffix.lower() in VIDEO_EXTENSIONS else []
    found = []
    for root, _dirs, files in os.walk(p):
        for name in sorted(files):
            if Path(name).suffix.lower() in VIDEO_EXTENSIONS and not name.startswith("."):
                found.append(os.path.join(root, name))
    return found


class Cancelled(Exception):
    pass


class Indexer:
    def __init__(self, store: Store, get_encoder, get_settings):
        self.store = store
        self.get_encoder = get_encoder      # callable -> ClipEncoder (raises if models missing)
        self.get_settings = get_settings    # callable -> settings dict
        self.q: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        self.pending: list[str] = []        # paths waiting
        self.current: dict | None = None
        self.busy = False                   # a job has been taken off the queue and not finished yet
        self.completed = 0
        self.errors: list[str] = []
        self.paused = threading.Event()
        self.gen = 0                        # bumped by cancel(); jobs from older generations are dropped
        self.job_gen = 0
        self.stop = False
        self.thread = threading.Thread(target=self._loop, daemon=True, name="indexer")
        self.thread.start()

    # ── public ──────────────────────────────────────────────────
    def enqueue(self, paths: list[str]) -> int:
        """Queue videos (files or folders). Unchanged videos that are already indexed are skipped."""
        added = 0
        for src in paths:
            for vp in find_videos(src):
                row = self.store.find_by_path(vp)
                try:
                    st = os.stat(vp)
                except OSError:
                    continue
                if row and row["status"] == "ready" and row["size"] == st.st_size and abs(row["mtime"] - st.st_mtime) < 1:
                    continue
                with self.lock:
                    if vp in self.pending or (self.current and self.current["path"] == vp):
                        continue
                    self.pending.append(vp)
                self.q.put((vp, self.gen))
                added += 1
        return added

    def snapshot(self) -> dict:
        with self.lock:
            cur = dict(self.current) if self.current else None
            if cur:
                elapsed = max(time.time() - cur["started"], 1e-6)
                frac = cur["pct"] / 100
                cur["eta"] = round(elapsed / frac - elapsed) if frac > 0.03 else None
            return {"running": self.busy or bool(self.pending), "paused": self.paused.is_set(),
                    "current": cur, "pending": len(self.pending), "completed": self.completed,
                    "errors": self.errors[-5:]}

    def pause(self, on: bool):
        (self.paused.set if on else self.paused.clear)()

    def cancel(self):
        """Drop everything that is queued and stop the video being processed."""
        with self.lock:
            self.gen += 1
            self.pending.clear()
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass
        self.paused.clear()

    def reset_errors(self):
        self.errors = []

    # ── worker ──────────────────────────────────────────────────
    def _loop(self):
        while not self.stop:
            try:
                path, gen = self.q.get(timeout=0.5)
            except queue.Empty:
                continue
            with self.lock:
                if gen == self.gen and path in self.pending:
                    self.job_gen = gen
                    self.busy = True
                    self.pending.remove(path)
                else:
                    continue  # cancelled while waiting
            try:
                self._index(path)
                with self.lock:
                    self.completed += 1
            except Cancelled:
                pass
            except Exception as exc:
                msg = f"{os.path.basename(path)}: {exc}"
                self.errors.append(msg)
                row = self.store.find_by_path(path)
                if row:
                    self.store.update_video(row["id"], status="error", error=str(exc))
            finally:
                with self.lock:
                    self.current = None
                    self.busy = False

    def _wait_if_paused(self):
        while self.paused.is_set() and not self.stop:
            if self.job_gen != self.gen:
                raise Cancelled()
            time.sleep(0.2)
        if self.job_gen != self.gen:
            raise Cancelled()

    def _index(self, path: str):
        encoder = self.get_encoder()
        cfg = self.get_settings()
        st = os.stat(path)
        video_id = self.store.upsert_video(path, st.st_size, st.st_mtime)
        self.store.clear_frames(video_id)

        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise RuntimeError("could not open this video (unsupported or damaged file)")
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if fps <= 0 or fps > 240:
            fps = 25.0
        duration = total_frames / fps if total_frames > 0 else 0
        w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        self.store.update_video(video_id, status="indexing", duration=duration, fps=fps, width=w, height=h, error="")
        with self.lock:
            self.current = {"video_id": video_id, "path": path, "name": os.path.basename(path), "pct": 0.0,
                            "frames": 0, "started": time.time()}

        step = max(1, round(fps * cfg["interval"]))
        # frames whose small grayscale thumbnail changes less than this are treated as repeats
        threshold = cfg["dedupe"] * 4.0
        batch_img, batch_ts = [], []
        last_gray = None
        kept = 0
        idx = 0

        def flush():
            nonlocal kept
            if not batch_img:
                return
            vecs = encoder.encode_images(batch_img)
            self.store.add_frames(video_id, batch_ts, vecs)
            kept += len(batch_img)
            batch_img.clear()
            batch_ts.clear()

        try:
            next_sample = 0
            while True:
                if not cap.grab():
                    break
                if idx >= next_sample:
                    ok, frame = cap.retrieve()
                    next_sample += step
                    if ok and frame is not None:
                        gray = cv2.resize(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (32, 32), interpolation=cv2.INTER_AREA)
                        if last_gray is None or threshold <= 0 or float(np.mean(cv2.absdiff(gray, last_gray))) >= threshold:
                            last_gray = gray
                            fh, fw = frame.shape[:2]
                            if min(fh, fw) > 256:       # shrink early: the model only sees 224 px anyway
                                s = 256 / min(fh, fw)
                                frame = cv2.resize(frame, (max(1, round(fw * s)), max(1, round(fh * s))), interpolation=cv2.INTER_AREA)
                            batch_img.append(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                            batch_ts.append(int(idx / fps * 1000))
                            if len(batch_img) >= BATCH:
                                flush()
                                self._progress(idx, total_frames, kept)
                    self._wait_if_paused()
                idx += 1
            flush()
            if idx == 0:
                raise RuntimeError("no frames could be read from this video")
        except Cancelled:
            self.store.delete_video(video_id)
            raise
        finally:
            cap.release()
        if kept == 0:
            raise RuntimeError("no usable frames in this video")
        real_duration = max(duration, idx / fps)
        self.store.update_video(video_id, status="ready", frames=kept, duration=real_duration)
        self._progress(idx, idx, kept)

    def _progress(self, idx: int, total: int, kept: int):
        with self.lock:
            if self.current:
                self.current["pct"] = round(min(100.0, idx / total * 100), 1) if total else 0.0
                self.current["frames"] = kept
