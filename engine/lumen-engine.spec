# -*- mode: python ; coding: utf-8 -*-
# Silnik EmuStart dla Lumen (engine_main.py) — bez okna i bez pywebview.
# Budowa (z katalogu engine/):  py -3 -m PyInstaller --noconfirm lumen-engine.spec
# Wynik: dist/EmuStartEngine/EmuStartEngine.exe (+ _internal/). Lumen pakuje go jako
# resources/engine/EmuStartEngine/ (electron-builder.yml → extraResources).
# console=True: Lumen czyta handshake ze stdout; proces startuje ukryty (windowsHide).

from PyInstaller.utils.hooks import collect_submodules

import sys as _sys
from pathlib import Path as _P

_sys.path.insert(0, ".")
from tools.pack_assets import build as _pack_logos

_logos = _P("build") / "systems.media"
_pack_logos(_P("assets") / "systems", _logos)

hiddenimports = collect_submodules("emustart")
try:
    hiddenimports += collect_submodules("segno")
except Exception:
    pass
hiddenimports += ["cryptography.x509", "cryptography.x509.oid", "cryptography.hazmat.primitives.hashes",
                  "cryptography.hazmat.primitives.serialization",
                  "cryptography.hazmat.primitives.asymmetric.ec"]

a = Analysis(
    ["engine_main.py"],
    pathex=["."],
    binaries=[],
    # bez web/ — interfejs to Lumen; assets: logo systemów (karuzela, lokalne kopie)
    datas=[(str(_logos), "assets")],
    hiddenimports=hiddenimports,
    # wybór folderu i okno robi Lumen — pywebview / .NET nie są potrzebne
    excludes=["tkinter", "test", "unittest", "pytest", "webview", "clr_loader", "pythonnet"],
)
pyz = PYZ(a.pure, a.zipped_data)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="EmuStartEngine",
    debug=False,
    strip=False,
    upx=False,
    console=True,
    icon="assets/icon.ico",
)
COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="EmuStartEngine")
