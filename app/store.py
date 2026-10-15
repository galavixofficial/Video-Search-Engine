"""The video library: SQLite for metadata and vectors, with an in-memory matrix for fast search."""
from __future__ import annotations

import os
import sqlite3
import threading
import time

import numpy as np

from .clip import DIM

SCHEMA = """
CREATE TABLE IF NOT EXISTS videos(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  duration REAL DEFAULT 0, fps REAL DEFAULT 0, width INTEGER DEFAULT 0, height INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0, mtime REAL DEFAULT 0, added REAL DEFAULT 0,
  frames INTEGER DEFAULT 0,
  status TEXT DEFAULT 'queued',
  error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS frames(
  id INTEGER PRIMARY KEY,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  ts_ms INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS frames_video ON frames(video_id);
CREATE TABLE IF NOT EXISTS saved(
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  note TEXT DEFAULT '',
  created REAL DEFAULT 0
);
"""

# CLIP text-to-image cosine similarity is small even for perfect matches, so raw numbers are
# stretched onto a 0-100 scale. Image-to-image similarity is much higher, hence a second range.
SCORE_RANGE = {"text": (0.21, 0.32), "image": (0.55, 0.95)}


def path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(path)))


def to_percent(raw: float, kind: str = "text") -> float:
    lo, hi = SCORE_RANGE[kind]
    return round(max(0.0, min(1.0, (raw - lo) / (hi - lo))) * 100, 1)


class Store:
    def __init__(self, db_path):
        self.db = sqlite3.connect(str(db_path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(SCHEMA)
        self.lock = threading.RLock()
        self._load()

    # ── memory matrix ───────────────────────────────────────────
    def _load(self):
        with self.lock:
            rows = self.db.execute("SELECT id, video_id, ts_ms, vec FROM frames ORDER BY id").fetchall()
            n = len(rows)
            self.n = n
            self.vecs = np.zeros((max(n, 1024), DIM), dtype=np.float16)
            self.frame_ids = np.zeros(max(n, 1024), dtype=np.int64)
            self.frame_video = np.zeros(max(n, 1024), dtype=np.int64)
            self.frame_ts = np.zeros(max(n, 1024), dtype=np.int64)
            for i, r in enumerate(rows):
                self.vecs[i] = np.frombuffer(r["vec"], dtype=np.float16)
                self.frame_ids[i], self.frame_video[i], self.frame_ts[i] = r["id"], r["video_id"], r["ts_ms"]

    def _grow(self, need: int):
        cap = len(self.vecs)
        if need <= cap:
            return
        new = max(need, cap * 2)
        for name in ("vecs", "frame_ids", "frame_video", "frame_ts"):
            old = getattr(self, name)
            arr = np.zeros((new,) + old.shape[1:], dtype=old.dtype)
            arr[: self.n] = old[: self.n]
            setattr(self, name, arr)

    # ── videos ──────────────────────────────────────────────────
    def get_video(self, video_id: int):
        with self.lock:
            return self.db.execute("SELECT * FROM videos WHERE id=?", (video_id,)).fetchone()

    def find_by_path(self, path: str):
        with self.lock:
            return self.db.execute("SELECT * FROM videos WHERE key=?", (path_key(path),)).fetchone()

    def upsert_video(self, path: str, size: int, mtime: float) -> int:
        with self.lock:
            row = self.find_by_path(path)
            if row:
                self.db.execute("UPDATE videos SET path=?, name=?, size=?, mtime=?, status='queued', error='' WHERE id=?",
                                (path, os.path.basename(path), size, mtime, row["id"]))
                self.db.commit()
                return row["id"]
            cur = self.db.execute("INSERT INTO videos(path,key,name,size,mtime,added) VALUES(?,?,?,?,?,?)",
                                  (path, path_key(path), os.path.basename(path), size, mtime, time.time()))
            self.db.commit()
            return cur.lastrowid

    def update_video(self, video_id: int, **fields):
        if not fields:
            return
        cols = ", ".join(f"{k}=?" for k in fields)
        with self.lock:
            self.db.execute(f"UPDATE videos SET {cols} WHERE id=?", (*fields.values(), video_id))
            self.db.commit()

    def list_videos(self) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM videos ORDER BY added DESC, id DESC")]

    def clear_frames(self, video_id: int):
        with self.lock:
            self.db.execute("DELETE FROM frames WHERE video_id=?", (video_id,))
            self.db.commit()
            keep = self.frame_video[: self.n] != video_id
            self._compact(keep)

    def delete_video(self, video_id: int) -> bool:
        with self.lock:
            if not self.get_video(video_id):
                return False
            self.db.execute("DELETE FROM frames WHERE video_id=?", (video_id,))
            self.db.execute("DELETE FROM videos WHERE id=?", (video_id,))
            self.db.commit()
            self._compact(self.frame_video[: self.n] != video_id)
            return True

    def clear_all(self):
        with self.lock:
            self.db.execute("DELETE FROM frames")
            self.db.execute("DELETE FROM videos")
            self.db.commit()
            self.n = 0

    def _compact(self, keep: np.ndarray):
        if keep.all():
            return
        m = int(keep.sum())
        for name in ("vecs", "frame_ids", "frame_video", "frame_ts"):
            arr = getattr(self, name)
            arr[:m] = arr[: self.n][keep]
        self.n = m

    # ── frames ──────────────────────────────────────────────────
    def add_frames(self, video_id: int, ts_ms: list[int], vecs: np.ndarray):
        vecs16 = np.asarray(vecs, dtype=np.float32).astype(np.float16)
        with self.lock:
            ids = []
            for ts, v in zip(ts_ms, vecs16):
                cur = self.db.execute("INSERT INTO frames(video_id, ts_ms, vec) VALUES(?,?,?)", (video_id, int(ts), v.tobytes()))
                ids.append(cur.lastrowid)
            self.db.commit()
            k = len(ids)
            self._grow(self.n + k)
            s = self.n
            self.vecs[s:s + k] = vecs16
            self.frame_ids[s:s + k] = ids
            self.frame_video[s:s + k] = video_id
            self.frame_ts[s:s + k] = ts_ms
            self.n += k

    def frame_vector(self, frame_id: int):
        with self.lock:
            hit = np.nonzero(self.frame_ids[: self.n] == frame_id)[0]
            if not len(hit):
                return None
            return self.vecs[hit[0]].astype(np.float32)

    def nearest_frame(self, video_id: int, ts_ms: int):
        with self.lock:
            idx = np.nonzero(self.frame_video[: self.n] == video_id)[0]
            if not len(idx):
                return None
            best = idx[np.argmin(np.abs(self.frame_ts[idx] - ts_ms))]
            return self.vecs[best].astype(np.float32), int(self.frame_ids[best])

    def stats(self) -> dict:
        with self.lock:
            row = self.db.execute(
                "SELECT COUNT(*) c, COALESCE(SUM(duration),0) d, COALESCE(SUM(size),0) s FROM videos WHERE status='ready'").fetchone()
            return {"videos": row["c"], "seconds": row["d"], "bytes": row["s"], "frames": self.n}

    # ── search ──────────────────────────────────────────────────
    def _similarities(self, q: np.ndarray):
        with self.lock:
            n = self.n
            sims = np.empty(n, dtype=np.float32)
            for s in range(0, n, 50000):
                sims[s:s + 50000] = self.vecs[s:min(n, s + 50000)].astype(np.float32) @ q
            return sims, self.frame_video[:n].copy(), self.frame_ts[:n].copy(), self.frame_ids[:n].copy()

    def search(self, query: np.ndarray, kind: str = "text", k: int = 24, video_ids: set[int] | None = None,
               per_video: int = 3, gap_ms: int = 5000, min_percent: float = 0.0, exclude_frame: int | None = None,
               heat_bins: int = 80) -> list[dict]:
        """Best videos for a query vector. Each has up to `per_video` distinct moments scoring at least
        `min_percent`, plus a `heat` strip: the best match in each slice of the video's timeline."""
        q = np.asarray(query, dtype=np.float32).reshape(-1)
        sims, vids, ts, fids = self._similarities(q)
        n = len(sims)
        if n == 0:
            return []
        OFF = -9.0                      # marks frames that must not be returned
        if video_ids is not None:
            sims[~np.isin(vids, list(video_ids))] = OFF
        if exclude_frame is not None:
            sims[fids == exclude_frame] = OFF
        lo, hi = SCORE_RANGE[kind]
        min_raw = lo + (hi - lo) * (min_percent / 100.0) if min_percent > 0 else OFF / 2
        top = min(n, max(k * per_video * 12, 300))
        cand = np.argpartition(-sims, top - 1)[:top] if top < n else np.arange(n)
        cand = cand[np.argsort(-sims[cand])]

        found: dict[int, list[dict]] = {}
        order: list[int] = []
        for i in cand:
            raw = float(sims[i])
            if raw < min_raw:
                break
            vid = int(vids[i])
            moments = found.get(vid)
            if moments is None:
                if len(found) >= k:
                    continue
                moments = found[vid] = []
                order.append(vid)
            if len(moments) >= per_video or any(abs(int(ts[i]) - m["ts_ms"]) < gap_ms for m in moments):
                continue
            moments.append({"frame_id": int(fids[i]), "ts_ms": int(ts[i]), "raw": round(raw, 4), "score": to_percent(raw, kind)})

        results = []
        with self.lock:
            rows = {vid: self.get_video(vid) for vid in order}
        for vid in order:
            row = rows[vid]
            if not row:
                continue
            mask = vids == vid
            heat = self._heat(ts[mask], sims[mask], row["duration"], kind, heat_bins)
            results.append({"video_id": vid, "name": row["name"], "duration": row["duration"], "added": row["added"],
                            "score": found[vid][0]["score"], "moments": found[vid], "heat": heat})
        return results

    @staticmethod
    def _heat(ts: np.ndarray, sims: np.ndarray, duration: float, kind: str, bins: int) -> list[int]:
        dur_ms = max(float(duration) * 1000, float(ts.max()) + 1 if len(ts) else 1)
        out = np.full(bins, -1.0, dtype=np.float32)
        idx = np.minimum((ts / dur_ms * bins).astype(int), bins - 1)
        np.maximum.at(out, idx, sims)
        # frames skipped as repeats leave gaps: carry the last known value forward
        last = -1.0
        for i in range(bins):
            if out[i] < -0.5:
                out[i] = last
            else:
                last = out[i]
        return [int(to_percent(float(v), kind)) if v > -0.5 else 0 for v in out]

    def scenes(self, video_id: int, limit: int = 240) -> list[int]:
        """Timestamps of the stored (distinct) frames of a video, thinned evenly to `limit`."""
        with self.lock:
            ts = np.sort(self.frame_ts[: self.n][self.frame_video[: self.n] == video_id])
        if len(ts) > limit:
            ts = ts[np.linspace(0, len(ts) - 1, limit).astype(int)]
        return [int(t) for t in ts]

    def snapshot_matrix(self):
        with self.lock:
            n = self.n
            return self.vecs[:n].copy(), self.frame_video[:n].copy(), self.frame_ts[:n].copy()

    # ── saved moments ───────────────────────────────────────────
    def list_saved(self) -> list[dict]:
        with self.lock:
            rows = [dict(r) for r in self.db.execute("SELECT * FROM saved ORDER BY created DESC")]
            ids = {r["key"]: r["id"] for r in self.db.execute("SELECT id, key FROM videos")}
        for r in rows:
            r["video_id"] = ids.get(r.pop("key"))
        return rows

    def add_saved(self, video_id: int, ts_ms: int, note: str = "") -> dict | None:
        row = self.get_video(video_id)
        if not row:
            return None
        with self.lock:
            dup = self.db.execute("SELECT id FROM saved WHERE key=? AND ABS(ts_ms-?) < 1000", (row["key"], ts_ms)).fetchone()
            if dup:
                return {"id": dup["id"], "duplicate": True}
            cur = self.db.execute("INSERT INTO saved(key, path, name, ts_ms, note, created) VALUES(?,?,?,?,?,?)",
                                  (row["key"], row["path"], row["name"], int(ts_ms), note[:500], time.time()))
            self.db.commit()
            return {"id": cur.lastrowid, "duplicate": False}

    def update_saved(self, saved_id: int, note: str) -> bool:
        with self.lock:
            cur = self.db.execute("UPDATE saved SET note=? WHERE id=?", (note[:500], saved_id))
            self.db.commit()
            return cur.rowcount > 0

    def delete_saved(self, saved_id: int) -> bool:
        with self.lock:
            cur = self.db.execute("DELETE FROM saved WHERE id=?", (saved_id,))
            self.db.commit()
            return cur.rowcount > 0
