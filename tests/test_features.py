from conftest import make_video, wait_idle

from app.main import parse_query


def index(engine, tmp_path, name="clip.mp4", **kw):
    p = make_video(tmp_path / name, **kw)
    engine.indexer.enqueue([str(p)])
    wait_idle(engine)
    return p


def vid_id(client, name):
    return [v for v in client.get("/api/videos").json()["videos"] if v["name"] == name][0]["id"]


def test_query_syntax():
    assert parse_query("a dog on a beach -night") == (["a dog on a beach"], ["night"])
    assert parse_query('cat -"black and white" + snow') == (["cat", "snow"], ["black and white"])
    assert parse_query("a t-shirt") == (["a t-shirt"], [])


def test_min_match_filters_individual_moments(engine, client, tmp_path):
    index(engine, tmp_path, seconds_per_color=6)     # moments 6 s apart, so none are merged
    loose = client.get("/api/search", params={"q": "green"}).json()["results"][0]["moments"]
    strict = client.get("/api/search", params={"q": "green", "min_percent": 90}).json()["results"][0]["moments"]
    assert len(loose) > 1                      # red/blue frames still appear as weak matches
    assert len(strict) == 1 and strict[0]["score"] >= 90


def test_excluded_terms_change_ranking(engine, client, tmp_path):
    index(engine, tmp_path)
    res = client.get("/api/search", params={"q": "green + blue -blue"}).json()
    assert res["excluded"] == ["blue"]
    top = res["results"][0]["moments"][0]
    assert 3000 <= top["ts_ms"] < 6000         # green wins once blue is pushed away


def test_heat_strip_peaks_where_the_match_is(engine, client, tmp_path):
    index(engine, tmp_path)
    heat = client.get("/api/search", params={"q": "blue"}).json()["results"][0]["heat"]
    assert len(heat) == 80
    third = len(heat) // 3
    assert max(heat[2 * third:]) > max(heat[:third])     # blue is the last third


def test_scope_by_folder(engine, client, tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    make_video(tmp_path / "a" / "one.mp4")
    make_video(tmp_path / "b" / "two.mp4")
    engine.indexer.enqueue([str(tmp_path)])
    wait_idle(engine)
    res = client.get("/api/search", params={"q": "green", "folder": str(tmp_path / "b")}).json()["results"]
    assert [r["name"] for r in res] == ["two.mp4"]
    none = client.get("/api/search", params={"q": "green", "folder": str(tmp_path / "missing")}).json()["results"]
    assert none == []


def test_saved_moments_round_trip(engine, client, tmp_path):
    index(engine, tmp_path)
    vid = vid_id(client, "clip.mp4")
    first = client.post("/api/saved", json={"video_id": vid, "ts_ms": 4000, "note": "green bit"}).json()
    again = client.post("/api/saved", json={"video_id": vid, "ts_ms": 4300}).json()
    assert again["duplicate"] and again["id"] == first["id"]
    assert client.patch(f"/api/saved/{first['id']}", json={"note": "renamed"}).status_code == 200
    items = client.get("/api/saved").json()["saved"]
    assert items[0]["note"] == "renamed" and items[0]["video_id"] == vid and items[0]["available"]
    assert client.delete(f"/api/saved/{first['id']}").status_code == 200
    assert client.get("/api/saved").json()["saved"] == []


def test_saved_survives_reindexing(engine, client, tmp_path):
    index(engine, tmp_path)
    vid = vid_id(client, "clip.mp4")
    client.post("/api/saved", json={"video_id": vid, "ts_ms": 1000})
    client.delete(f"/api/videos/{vid}")
    assert client.get("/api/saved").json()["saved"][0]["video_id"] is None   # kept, marked unavailable
    index(engine, tmp_path, name="clip.mp4")
    assert client.get("/api/saved").json()["saved"][0]["video_id"] == vid_id(client, "clip.mp4")


def test_scenes(engine, client, tmp_path):
    index(engine, tmp_path)
    scenes = client.get(f"/api/videos/{vid_id(client, 'clip.mp4')}/scenes").json()["scenes"]
    assert scenes == sorted(scenes) and 2 <= len(scenes) <= 4


def test_save_frame_writes_a_jpeg(engine, client, tmp_path, monkeypatch):
    monkeypatch.setenv("SCENESEEK_FRAMES", str(tmp_path / "frames"))
    index(engine, tmp_path)
    out = client.post(f"/api/videos/{vid_id(client, 'clip.mp4')}/save-frame", json={"ts_ms": 4000}).json()
    data = open(out["path"], "rb").read()
    assert data[:2] == b"\xff\xd8" and out["path"].endswith("_00h00m04s.jpg")
    # revealing is only allowed inside that folder
    assert client.post("/api/reveal-path", json={"path": str(tmp_path / "clip.mp4")}).status_code == 403


def test_explore_groups_frames_into_concepts(engine, client, tmp_path, monkeypatch):
    import numpy as np
    from app import explore
    monkeypatch.setattr(explore, "CONCEPTS", [("Red things", "red"), ("Green things", "green"), ("Blue things", "blue")])
    engine.explorer._text = None
    client.post("/api/settings", json={"dedupe": 0})     # keep every sampled frame
    index(engine, tmp_path, seconds_per_color=4)
    concepts = client.get("/api/explore").json()["concepts"]
    assert {c["label"] for c in concepts} == {"Red things", "Green things", "Blue things"}
    green = [c for c in concepts if c["label"] == "Green things"][0]
    assert 4000 <= green["cover"]["ts_ms"] < 8000 and green["frames"] == 4
