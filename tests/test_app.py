import cv2
import numpy as np
from fastapi.testclient import TestClient

from conftest import make_video, wait_idle


def index(engine, tmp_path, name="clip.mp4", **kw):
    p = make_video(tmp_path / name, **kw)
    assert engine.indexer.enqueue([str(p)]) == 1
    wait_idle(engine)
    return p


def test_indexes_and_finds_the_right_moment(engine, client, tmp_path):
    index(engine, tmp_path)
    res = client.get("/api/search", params={"q": "green"}).json()
    assert len(res["results"]) == 1
    top = res["results"][0]["moments"][0]
    assert 2.5 <= top["ts_ms"] / 1000 <= 6.0          # the green section is 3s-6s
    assert top["score"] > 90
    red = client.get("/api/search", params={"q": "red"}).json()["results"][0]["moments"][0]
    assert red["ts_ms"] < 3000


def test_duplicate_frames_are_skipped(engine, tmp_path):
    index(engine, tmp_path)                 # 9 seconds, 3 distinct scenes
    assert engine.store.stats()["frames"] <= 4


def test_unchanged_video_is_not_reindexed_and_changed_one_is(engine, tmp_path):
    p = index(engine, tmp_path)
    assert engine.indexer.enqueue([str(p)]) == 0
    make_video(p, seconds_per_color=4)
    assert engine.indexer.enqueue([str(p)]) == 1
    wait_idle(engine)
    assert engine.store.stats()["videos"] == 1


def test_folder_indexing_and_removal(engine, client, tmp_path):
    make_video(tmp_path / "a.mp4")
    make_video(tmp_path / "b.mp4", order=("blue", "green", "red"))
    engine.indexer.enqueue([str(tmp_path)])
    wait_idle(engine)
    vids = client.get("/api/videos").json()["videos"]
    assert {v["name"] for v in vids} == {"a.mp4", "b.mp4"}
    first = [v for v in vids if v["name"] == "a.mp4"][0]
    assert client.delete(f"/api/videos/{first['id']}").status_code == 200
    res = client.get("/api/search", params={"q": "green"}).json()["results"]
    assert [r["name"] for r in res] == ["b.mp4"]


def test_similar_moments_excludes_itself(engine, client, tmp_path):
    index(engine, tmp_path, name="one.mp4")
    index(engine, tmp_path, name="two.mp4", order=("green", "red", "blue"))
    vid = [v for v in client.get("/api/videos").json()["videos"] if v["name"] == "one.mp4"][0]
    res = client.get("/api/similar", params={"video_id": vid["id"], "ts_ms": 4000}).json()["results"]
    assert res and res[0]["name"] == "two.mp4"           # the other green moment, not the same frame


def test_broken_file_reports_error_and_queue_continues(engine, tmp_path):
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"not a video")
    good = make_video(tmp_path / "good.mp4")
    engine.indexer.enqueue([str(bad), str(good)])
    wait_idle(engine)
    names = {v["name"]: v["status"] for v in engine.store.list_videos()}
    assert names["bad.mp4"] == "error" and names["good.mp4"] == "ready"
    assert engine.indexer.snapshot()["errors"]


def test_thumbnail_and_stream(engine, client, tmp_path):
    index(engine, tmp_path)
    vid = client.get("/api/videos").json()["videos"][0]["id"]
    r = client.get(f"/api/thumb/{vid}", params={"t": 4000, "w": 200})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    r = client.get(f"/api/video/{vid}", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100


def test_cannot_read_arbitrary_files(engine, client, tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret")
    assert client.get("/api/video/1").status_code == 404
    assert client.get("/video", params={"path": str(secret)}).status_code == 404
    assert b"top secret" not in client.get("/frame", params={"path": str(secret)}).content


def test_rejects_foreign_hosts_and_origins(engine):
    from app.main import create_app
    app = create_app(engine)
    assert TestClient(app, base_url="http://evil.example").get("/api/status").status_code == 403
    local = TestClient(app, base_url="http://127.0.0.1")
    assert local.get("/api/status").status_code == 200
    assert local.post("/api/clear", headers={"Origin": "http://evil.example"}).status_code == 403


def test_search_by_image(engine, client, tmp_path):
    index(engine, tmp_path)
    img = np.full((60, 80, 3), (255, 0, 0), dtype=np.uint8)       # blue in BGR
    ok, buf = cv2.imencode(".png", img)
    r = client.post("/api/search/image", files={"file": ("q.png", buf.tobytes(), "image/png")}).json()
    assert r["results"][0]["moments"][0]["ts_ms"] >= 6000          # the blue section


def test_settings_are_clamped(client):
    out = client.post("/api/settings", json={"interval": 99, "dedupe": -3, "evil": 1}).json()
    assert out["interval"] == 10.0 and out["dedupe"] == 0.0 and "evil" not in out


def test_pause_and_cancel(engine, tmp_path):
    for i in range(3):
        make_video(tmp_path / f"v{i}.mp4")
    engine.indexer.pause(True)
    engine.indexer.enqueue([str(tmp_path)])
    engine.indexer.cancel()
    engine.indexer.pause(False)
    wait_idle(engine)
    assert not engine.store.list_videos()
