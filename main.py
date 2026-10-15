"""Sceneseek launcher: starts the local server and opens the app window."""
import socket
import sys
import threading
import time
import webbrowser


def free_port(preferred: int = 8765) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free port")


def serve(engine, port: int):
    import uvicorn
    from app.main import create_app
    uvicorn.run(create_app(engine), host="127.0.0.1", port=port, log_config=None, access_log=False)


def already_running(port: int = 8765) -> bool:
    """True if another Sceneseek is serving on the usual port (so a second launch just opens a window to it)."""
    import json
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status", timeout=1.5) as r:
            return json.load(r).get("app") == "Sceneseek"
    except Exception:
        return False


def wait_for(port: int, timeout: float = 30) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        with socket.socket() as s:
            s.settimeout(0.3)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.15)
    return False


def bind_drop(window, engine):
    """Dropped files carry their real paths inside the desktop window, so index them in place (no copying)."""
    if engine is None:
        return
    try:
        from webview.dom import DOMEventHandler

        def on_drop(event):
            files = (event.get("dataTransfer") or {}).get("files") or []
            paths = [f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")]
            if paths and engine.ready() and engine.indexer.enqueue(paths):
                engine.note_index_quality()

        window.dom.document.events.drop += DOMEventHandler(on_drop, False, False)
    except Exception as exc:  # drag and drop is a convenience; the buttons always work
        print(f"Drag and drop into the window is unavailable: {exc}")


def main():
    if len(sys.argv) >= 3 and sys.argv[1] == "--pick":
        from app import picker
        return picker.main(sys.argv[2])

    from app.config import APP_NAME
    engine = None
    if already_running():
        port = 8765
    else:
        from app.main import Engine
        engine = Engine()
        port = free_port()
        threading.Thread(target=serve, args=(engine, port), daemon=True).start()
        if not wait_for(port):
            print("Sceneseek could not start its local server.")
            return 1
    url = f"http://127.0.0.1:{port}/"
    if "--no-window" in sys.argv:          # server only (development, tests)
        print(f"{APP_NAME} running at {url}")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return 0
    if "--browser" not in sys.argv:
        try:
            import webview
            window = webview.create_window(APP_NAME, url, width=1280, height=820, min_size=(900, 600), background_color="#0b0c10")
            webview.start(lambda w: bind_drop(w, engine), window)
            return 0
        except Exception as exc:             # no WebView2 etc: fall back to the default browser
            print(f"Native window unavailable ({exc}); opening your browser instead.")
    webbrowser.open(url)
    print(f"{APP_NAME} is running at {url}  (close this window to quit)")
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
