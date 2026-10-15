"""Explore: discover what is in the library without typing, by matching every frame against a fixed
vocabulary of everyday things (zero-shot CLIP classification)."""
from __future__ import annotations

import threading

import numpy as np

# (label shown to people, text the model compares frames with)
CONCEPTS = [
    ("People talking", "people having a conversation"), ("A crowd", "a large crowd of people"),
    ("Close-up of a face", "a close-up of a person's face"), ("Children", "children playing"),
    ("Dancing", "people dancing"), ("Eating together", "people eating a meal at a table"),
    ("Sports", "people playing a sport"), ("Running", "a person running"), ("On stage", "a performer on a stage with lights"),
    ("Concert", "a music concert"), ("Wedding", "a wedding ceremony"), ("Birthday", "a birthday party with a cake"),
    ("Presentation", "a person giving a presentation"), ("Classroom", "a classroom with students"),
    ("Office", "an office with desks and computers"), ("Kitchen", "a kitchen"), ("Cooking", "someone cooking food"),
    ("Food", "a plate of food"), ("Living room", "a living room interior"), ("Bedroom", "a bedroom"),
    ("Dogs", "a dog"), ("Cats", "a cat"), ("Birds", "a bird"), ("Horses", "a horse"), ("Fish", "fish swimming"),
    ("Insects", "an insect close-up"), ("Wildlife", "a wild animal in nature"), ("Rabbits", "a rabbit"),
    ("Beach", "a beach with sand and waves"), ("Ocean", "the open ocean"), ("Underwater", "an underwater scene"),
    ("Lake or river", "a lake or a river"), ("Waterfall", "a waterfall"), ("Forest", "a forest with tall trees"),
    ("Mountains", "mountains"), ("Snow", "a snowy landscape"), ("Desert", "a desert"), ("Fields", "a green field of grass"),
    ("Flowers", "flowers"), ("Garden or park", "a park or garden"), ("Cave", "a dark cave"),
    ("Sunset", "a sunset sky"), ("Clouds and sky", "a blue sky with clouds"), ("Night", "a scene at night"),
    ("Rain", "rain falling"), ("Fire", "fire and flames"), ("Fireworks", "fireworks in the night sky"),
    ("City streets", "a busy city street"), ("Skyline", "a city skyline"), ("Roads", "a road with cars"),
    ("Cars", "a car"), ("Motorbikes", "a motorcycle"), ("Bicycles", "a bicycle"), ("Trains", "a train"),
    ("Airplanes", "an airplane"), ("Boats", "a boat on water"), ("Bridges", "a bridge"), ("Buildings", "a large building"),
    ("Castles", "a castle"), ("Ruins", "ancient ruins"), ("Machines", "industrial machinery"),
    ("Robots", "a robot"), ("Screens", "a computer screen"), ("Phones", "a person using a phone"),
    ("Slides and charts", "a presentation slide with text and charts"), ("Text on screen", "large text on a screen"),
    ("Maps", "a map"), ("Books", "an open book"), ("Art", "a painting or drawing"), ("Toys", "toys"),
    ("Animation", "a cartoon animation"), ("Black and white", "an old black and white film"),
    ("Aerial view", "an aerial drone view from above"), ("Space", "outer space with stars"),
    ("Dragons", "a dragon"), ("Swords and battles", "people fighting with swords"),
    ("Explosions", "an explosion"), ("Weapons", "a gun"), ("Money", "money and banknotes"),
]


class Explorer:
    def __init__(self, store, get_encoder):
        self.store = store
        self.get_encoder = get_encoder
        self.lock = threading.Lock()
        self._text = None
        self._text_key = None
        self._cache = None
        self._cache_key = None

    def _concept_vectors(self, quality_key):
        if self._text is None or self._text_key != quality_key:
            enc = self.get_encoder()
            prompts = [f"a photo of {p}" for _, p in CONCEPTS]
            self._text = np.concatenate([enc.encode_text(prompts[i:i + 32]) for i in range(0, len(prompts), 32)])
            self._text_key = quality_key
        return self._text

    def overview(self, quality_key, limit: int = 30) -> list[dict]:
        with self.lock:
            key = (quality_key, self.store.n, self.store.stats()["videos"])
            if self._cache is not None and self._cache_key == key:
                return self._cache
            vecs, vids, ts = self.store.snapshot_matrix()
            if not len(vecs):
                self._cache, self._cache_key = [], key
                return []
            T = self._concept_vectors(quality_key)
            best = np.empty(len(vecs), dtype=np.int32)
            conf = np.empty(len(vecs), dtype=np.float32)
            sim_best = np.empty(len(vecs), dtype=np.float32)
            for s in range(0, len(vecs), 20000):
                sims = vecs[s:s + 20000].astype(np.float32) @ T.T
                logits = sims * 100.0
                logits -= logits.max(axis=1, keepdims=True)
                p = np.exp(logits)
                p /= p.sum(axis=1, keepdims=True)
                b = p.argmax(axis=1)
                best[s:s + 20000] = b
                conf[s:s + 20000] = p[np.arange(len(b)), b]
                sim_best[s:s + 20000] = sims[np.arange(len(b)), b]
            confident = conf >= 0.35
            out = []
            min_frames = max(3, int(len(vecs) * 0.0025))
            for c, (label, prompt) in enumerate(CONCEPTS):
                idx = np.nonzero(confident & (best == c))[0]
                if len(idx) < min_frames:
                    continue
                top = idx[np.argmax(sim_best[idx])]
                out.append({"label": label, "query": prompt, "frames": int(len(idx)),
                            "videos": int(len(np.unique(vids[idx]))),
                            "cover": {"video_id": int(vids[top]), "ts_ms": int(ts[top])}})
            out.sort(key=lambda d: (-d["frames"], d["label"]))
            self._cache, self._cache_key = out[:limit], key
            return self._cache
