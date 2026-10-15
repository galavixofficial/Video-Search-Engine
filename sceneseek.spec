# PyInstaller build: .venv/Scripts/pyinstaller sceneseek.spec --noconfirm
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas = [("app/static", "app/static")]
binaries = []
hidden = collect_submodules("uvicorn") + ["multipart", "python_multipart"]
for pkg in ("webview", "clr_loader", "pythonnet", "onnxruntime", "tokenizers"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hidden += h

a = Analysis(["main.py"], pathex=["."], binaries=binaries, datas=datas, hiddenimports=hidden,
             excludes=["matplotlib", "scipy", "pandas", "IPython", "notebook", "torch", "pytest"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Sceneseek", console=False,
          icon="build_assets/sceneseek.ico", version=None)
coll = COLLECT(exe, a.binaries, a.datas, name="Sceneseek")
