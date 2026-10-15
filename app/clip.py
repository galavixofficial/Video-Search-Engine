"""CLIP image/text encoder running on ONNX Runtime (no PyTorch needed), plus first-run model download."""
from __future__ import annotations

import threading
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

from .config import model_dir

DIM = 512
SIZE = 224
_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
_STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)

# Pre-converted copy of OpenAI's CLIP ViT-B/16 (MIT licence), the same model the app always used.
_BASE = "https://huggingface.co/Xenova/clip-vit-base-patch16/resolve/main/"
_FILES = {
    "fast": {"vision_model.onnx": "onnx/vision_model_quantized.onnx", "text_model.onnx": "onnx/text_model_quantized.onnx"},
    "best": {"vision_model.onnx": "onnx/vision_model.onnx", "text_model.onnx": "onnx/text_model.onnx"},
}
_TOKENIZER = "tokenizer.json"


def models_present(quality: str) -> bool:
    d = model_dir(quality)
    return all((d / name).exists() for name in (*_FILES[quality], _TOKENIZER))


class Downloader:
    """Downloads the model files in a background thread and reports progress."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"active": False, "quality": "", "done": 0, "total": 0, "file": "", "error": ""}

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.state)

    def start(self, quality: str) -> bool:
        with self.lock:
            if self.state["active"]:
                return False
            self.state.update(active=True, quality=quality, done=0, total=0, file="", error="")
        threading.Thread(target=self._run, args=(quality,), daemon=True).start()
        return True

    def _set(self, **kw):
        with self.lock:
            self.state.update(kw)

    def _run(self, quality: str):
        try:
            d = model_dir(quality)
            jobs = [(_TOKENIZER, _TOKENIZER), *[(name, remote) for name, remote in _FILES[quality].items()]]
            todo = [(n, r) for n, r in jobs if not (d / n).exists()]
            sizes = {}
            for name, remote in todo:
                req = urllib.request.Request(_BASE + remote, method="HEAD")
                with urllib.request.urlopen(req, timeout=30) as resp:
                    sizes[name] = int(resp.headers.get("Content-Length", 0))
            self._set(total=sum(sizes.values()))
            done = 0
            for name, remote in todo:
                self._set(file=name)
                part = d / (name + ".part")
                with urllib.request.urlopen(_BASE + remote, timeout=60) as resp, open(part, "wb") as out:
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        self._set(done=done)
                if sizes[name] and part.stat().st_size != sizes[name]:
                    part.unlink(missing_ok=True)
                    raise IOError(f"Download of {name} was incomplete. Check your connection and try again.")
                part.replace(d / name)
            self._set(active=False)
        except Exception as exc:  # network errors, disk full...
            self._set(active=False, error=str(exc) or exc.__class__.__name__)


def preprocess(rgb_images: list[np.ndarray]) -> np.ndarray:
    """RGB uint8 HxWx3 images -> float32 NCHW batch, exactly like CLIP's own preprocessing."""
    batch = np.empty((len(rgb_images), 3, SIZE, SIZE), dtype=np.float32)
    for i, arr in enumerate(rgb_images):
        img = Image.fromarray(arr)
        w, h = img.size
        scale = SIZE / min(w, h)
        img = img.resize((max(SIZE, round(w * scale)), max(SIZE, round(h * scale))), Image.BICUBIC)
        w, h = img.size
        left, top = (w - SIZE) // 2, (h - SIZE) // 2
        img = img.crop((left, top, left + SIZE, top + SIZE))
        x = (np.asarray(img, dtype=np.float32) / 255.0 - _MEAN) / _STD
        batch[i] = x.transpose(2, 0, 1)
    return batch


def _normalize(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    return x / np.clip(np.linalg.norm(x, axis=1, keepdims=True), 1e-12, None)


class ClipEncoder:
    def __init__(self, quality: str, threads: int = 0):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = model_dir(quality)
        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        if threads:
            opts.intra_op_num_threads = threads
        cpu = ["CPUExecutionProvider"]
        self.vision = ort.InferenceSession(str(d / "vision_model.onnx"), opts, providers=cpu)
        self.text = ort.InferenceSession(str(d / "text_model.onnx"), opts, providers=cpu)
        self.tokenizer = Tokenizer.from_file(str(d / _TOKENIZER))
        self.tokenizer.enable_truncation(77)
        eot = self.tokenizer.token_to_id("<|endoftext|>") or 49407
        self.tokenizer.enable_padding(length=77, pad_id=eot, pad_token="<|endoftext|>")
        self._vin = self.vision.get_inputs()[0].name
        self._tin = {i.name for i in self.text.get_inputs()}

    @staticmethod
    def _pick(outputs, session):
        for meta, out in zip(session.get_outputs(), outputs):
            if "embeds" in meta.name:
                return out
        return outputs[0]

    def encode_images(self, rgb_images: list[np.ndarray]) -> np.ndarray:
        out = self.vision.run(None, {self._vin: preprocess(rgb_images)})
        return _normalize(self._pick(out, self.vision))

    def encode_text(self, texts: list[str]) -> np.ndarray:
        enc = self.tokenizer.encode_batch(texts)
        feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64)}
        if "attention_mask" in self._tin:
            feed["attention_mask"] = np.array([e.attention_mask for e in enc], dtype=np.int64)
        out = self.text.run(None, feed)
        return _normalize(self._pick(out, self.text))


def image_from_file(path: str | Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))
