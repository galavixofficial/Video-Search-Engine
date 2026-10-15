"""Native file/folder dialogs. Runs in a separate process because Tk wants its own main thread."""
from __future__ import annotations

import json
import subprocess
import sys

from .config import VIDEO_EXTENSIONS, resource_dir


def run_dialog(kind: str) -> list[str]:
    import tkinter as tk
    from tkinter import filedialog

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    if kind == "folder":
        chosen = filedialog.askdirectory(title="Choose a folder of videos")
        paths = [chosen] if chosen else []
    else:
        pattern = " ".join(f"*{e}" for e in sorted(VIDEO_EXTENSIONS))
        chosen = filedialog.askopenfilenames(title="Choose videos", filetypes=[("Videos", pattern), ("All files", "*.*")])
        paths = list(chosen)
    root.destroy()
    return paths


def pick(kind: str) -> list[str]:
    """Open a dialog in a child process of this same program and return the chosen paths."""
    cmd = [sys.executable, "--pick", kind] if getattr(sys, "frozen", False) else [sys.executable, str(resource_dir() / "main.py"), "--pick", kind]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    out = subprocess.run(cmd, capture_output=True, text=True, creationflags=flags, timeout=600)
    for line in reversed(out.stdout.strip().splitlines()):
        try:
            return json.loads(line)
        except ValueError:
            continue
    return []


def main(kind: str):
    print(json.dumps(run_dialog(kind)))
