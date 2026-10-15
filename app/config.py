"""Where Sceneseek keeps its data, and the user-editable settings."""
from __future__ import annotations

import json
import os
import sys
import threading
from pathlib import Path

APP_NAME = "Sceneseek"
VERSION = "1.0.0"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".m4v", ".mpg", ".mpeg", ".ts", ".3gp"}


def resource_dir() -> Path:
    """Folder holding read-only app resources (the web UI). Works from source and when frozen."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def data_dir() -> Path:
    env = os.environ.get("SCENESEEK_HOME")
    if env:
        p = Path(env)
    elif getattr(sys, "frozen", False):
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
        p = Path(base) / APP_NAME
    else:
        p = Path(__file__).resolve().parent.parent / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p


def model_dir(quality: str) -> Path:
    p = data_dir() / "models" / quality
    p.mkdir(parents=True, exist_ok=True)
    return p


DEFAULT_SETTINGS = {
    # seconds between sampled frames; smaller = finds shorter moments, slower to index
    "interval": 1.0,
    # skip frames that barely changed (0 = keep everything, higher = skip more)
    "dedupe": 0.5,
    # "fast" = small quantised model (about 150 MB), "best" = full precision (about 600 MB)
    "quality": "fast",
    # "balanced" leaves some CPU free so the computer stays responsive, "max" is fastest
    "speed": "balanced",
    # folders that are scanned for new videos on start and on request
    "folders": [],
}


class Settings:
    def __init__(self, path: Path | None = None):
        self.path = path or (data_dir() / "settings.json")
        self._lock = threading.Lock()
        self._data = dict(DEFAULT_SETTINGS)
        try:
            self._data.update(json.loads(self.path.read_text(encoding="utf8")))
        except (OSError, ValueError):
            pass

    def get(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._data))

    def update(self, changes: dict) -> dict:
        with self._lock:
            for key, value in changes.items():
                if key not in DEFAULT_SETTINGS:
                    continue
                if key == "interval":
                    value = min(10.0, max(0.25, float(value)))
                elif key == "dedupe":
                    value = min(1.0, max(0.0, float(value)))
                elif key == "quality":
                    if value not in ("fast", "best"):
                        continue
                elif key == "speed":
                    if value not in ("balanced", "max"):
                        continue
                elif key == "folders":
                    value = [str(v) for v in value]
                self._data[key] = value
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, indent=2), encoding="utf8")
            tmp.replace(self.path)
            return json.loads(json.dumps(self._data))
