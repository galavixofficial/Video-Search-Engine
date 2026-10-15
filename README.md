# Sceneseek

**Find any moment in your videos by describing it.** Type "a dragon over a castle" or "two people laughing at a table" and Sceneseek jumps to the exact second. It runs entirely on your computer: no account, no cloud, nothing is uploaded.

![Search results](docs/screenshots/results.jpg)

## What it does

- **Describe it, find it.** Search your own footage in plain English. Results appear as contact sheets: a strip of real frames per video, each frame stamped with its timecode and a **colour-coded match percentage** (red for a long shot, green for a strong match), plus a heatmap of where in the film it matches.
- **Power search.** `dog + snow` asks for both, `beach -night` leaves night shots out.
- **Topics.** Sceneseek sorts your footage into topics on its own (faces, beaches, cars, text on screen...) so you can browse without typing.
- **A screening room.** The video plays at the match, above a film-strip scrubber made of real frames with match flags on top. Step through takes, change speed, search inside that one video, find similar moments, grab full-resolution frames.
- **A reel with EDL export.** Keep moments, add notes, and export a cut list (CMX3600 EDL) for Premiere Pro, DaVinci Resolve or Final Cut, or a CSV.
- **Search by image.** Paste or drop a picture to find footage that looks like it.
- **Fast to drive.** Hover previews, a command palette (`Ctrl K`), keyboard shortcuts everywhere, a dark cinema theme and a light paper theme.
- **Smart indexing.** Watched folders, repeated scenes skipped, pause and cancel, only changed files re-read.
- **Private by design.** The AI runs on your computer. Your videos are never copied or changed, and the app only answers to your own machine.

![Topics](docs/screenshots/topics.jpg)
![Screening room](docs/screenshots/watch.jpg)

## Download

Get the latest Windows build from the [Releases page](https://github.com/galavixofficial/Video-Search-Engine/releases/latest), unzip it and run `Sceneseek.exe`. The first launch downloads the search model once (about 150 MB), then everything works offline.

Windows may show a SmartScreen notice because the app is new and not code-signed yet: choose **More info**, then **Run anyway**.

## Run from source

Requires Python 3.10 or newer.

```bash
uv sync            # or: pip install -r requirements.txt
uv run python main.py
```

`python main.py --browser` opens the app in your default browser instead of its own window, and `--no-window` just starts the server.

Run the tests with `uv run pytest`. Build the Windows app with `uv run pyinstaller sceneseek.spec --noconfirm`.

## How it works

1. **Indexing.** Each video is read about once per second (configurable). Frames that barely changed are skipped, the rest are embedded with CLIP ViT-B/16 running on ONNX Runtime (no PyTorch needed), and the vectors are stored in a local SQLite database.
2. **Searching.** Your description is embedded with the same model and compared with every stored frame. The best frames are grouped by video and merged into distinct moments.
3. **Playing.** The video is streamed from where it already lives on disk, starting a moment before the match.

The model files come from a public ONNX conversion of OpenAI's CLIP (MIT licence). "Fast" is the quantised model (about 150 MB), "Best" the full-precision one (about 600 MB).

## Good to know

- CLIP matches what things **look like**. It is good at scenes, objects, colours and actions; it does not understand speech and is weak at reading text on screen.
- Indexing speed depends on your processor. On our test PC it handled roughly eight sampled frames per second, so a 10 minute video took about a minute and a half with default settings.
- Formats the built-in player cannot show (some `.mkv`, `.avi`, `.wmv` files) can still be searched; use **Open** to play them in your usual player.
- Data lives in `%LOCALAPPDATA%\Sceneseek` (or `./data` when run from source).

## Project layout

```
main.py             launcher: starts the local server and opens the window
app/main.py         API (FastAPI) and security checks
app/clip.py         ONNX CLIP encoder and model download
app/indexer.py      background indexing
app/store.py        SQLite library, in-memory search, saved moments
app/explore.py      automatic topics for the Explore page
app/static/         the web UI (plain HTML, CSS and JavaScript)
tests/              pytest suite
website/            the download website
```

## Credits and licence

MIT licensed, see [LICENSE](LICENSE). Typefaces: Instrument Serif, Geist and Geist Mono (SIL Open Font Licence). Screenshots use footage from the Blender Foundation's open movies *Big Buck Bunny*, *Sintel* and *Elephants Dream* (CC BY 3.0) and a test clip from test-videos.co.uk.

Built by [Galavix](https://github.com/galavixofficial).
