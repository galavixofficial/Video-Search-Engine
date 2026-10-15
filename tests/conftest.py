import os
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("SCENESEEK_HOME", tempfile.mkdtemp(prefix="sceneseek-test-"))

from app import clip  # noqa: E402

COLORS = {"red": (0, 0, 255), "green": (0, 255, 0), "blue": (255, 0, 0)}  # BGR for OpenCV


class FakeEncoder:
    """Maps the average colour of an image (or a colour word) onto a fixed 512-d direction."""

    def _vec(self, rgb):
        v = np.zeros(clip.DIM, dtype=np.float32)
        v[:3] = np.asarray(rgb, dtype=np.float32) + 1e-3
        return v / np.linalg.norm(v)

    def encode_images(self, images):
        return np.stack([self._vec(np.asarray(im).reshape(-1, 3).mean(axis=0)) for im in images])

    def encode_text(self, texts):
        out = []
        for t in texts:
            rgb = [0, 0, 0]
            for name, (b, g, r) in COLORS.items():
                if name in t:
                    rgb = [r, g, b]
            out.append(self._vec(rgb))
        return np.stack(out)


def make_video(path, seconds_per_color=3, fps=10, size=(160, 120), order=("red", "green", "blue")):
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), fps, size)
    for name in order:
        frame = np.full((size[1], size[0], 3), COLORS[name], dtype=np.uint8)
        for _ in range(seconds_per_color * fps):
            w.write(frame)
    w.release()
    return path


@pytest.fixture
def fake_encoder():
    return FakeEncoder()


@pytest.fixture
def engine(tmp_path, monkeypatch, fake_encoder):
    from app import main as appmain
    monkeypatch.setattr(clip, "models_present", lambda quality: True)
    eng = appmain.Engine(home=tmp_path / "home")
    monkeypatch.setattr(eng, "encoder", lambda: fake_encoder)
    eng.indexer.get_encoder = lambda: fake_encoder
    eng.explorer.get_encoder = lambda: fake_encoder
    yield eng
    eng.indexer.stop = True


@pytest.fixture
def client(engine):
    from fastapi.testclient import TestClient
    from app.main import create_app
    return TestClient(create_app(engine), base_url="http://127.0.0.1")


def wait_idle(engine, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if not engine.indexer.snapshot()["running"]:
            return
        time.sleep(0.1)
    raise AssertionError("indexing did not finish")
