"""EmuStart jako silnik Lumen — bez okna, sterowany przez proces Lumen.

    python engine_main.py
    python engine_main.py --diag-controllers [--json] [--no-sdl] [--profile=game:ID|emu:RODZINA|default] [--home=KATALOG]

Zmienne środowiskowe (ustawia Lumen):
    EMUSTART_HOME        katalog danych (config.json, data, cache, profile, logi)
    LUMEN_ENGINE_TOKEN   token sesji wymagany przez /api (nagłówek X-Lumen-Token)
    LUMEN_WINDOW_TITLE   tytuł okna Lumen (menu w grze i powrót po grze wyciągają je na wierzch)

Na stdout pierwsza linia: {"lumen_engine": 1, "port": …, "version": …}; dalej zdarzenia
{"lumen_event": …}. Zamknięcie stdin (koniec procesu Lumen) kończy silnik.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import sys
import threading

DIAG = "--diag-controllers" in sys.argv
if DIAG and not os.environ.get("EMUSTART_HOME"):
    # dane Lumen (etykiety kontrolerów, emulatory): --home=…, a w paczce Lumen
    # <Lumen>\resources\engine\EmuStartEngine\EmuStartEngine.exe → <Lumen>\LumenData\emustart
    _home = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--home=")), "")
    if not _home and getattr(sys, "frozen", False):
        _guess = Path(sys.executable).resolve().parents[3] / "LumenData" / "emustart"
        _home = str(_guess) if _guess.is_dir() else ""
    if _home:
        os.environ["EMUSTART_HOME"] = _home

# pady w interfejsie obsługuje Lumen (XInput w procesie głównym); menu w grze (LB + A) — nadal EmuStart:
# „browser”, nie „none” — przy „none” hotkey.GameMenu wyłącza menu w grze
if not any(a.startswith("--pady=") for a in sys.argv):
    sys.argv.append("--pady=browser")

from emustart import boot  # noqa: E402

_UNBLOCKED = boot.unblock_self()

from emustart import __version__, lumen, paths, server  # noqa: E402


def diag_controllers() -> None:
    """Kontrolery: indeks SDL, stabilny klucz, widoczność, slot (Gracz) — tylko odczyt, bez zapisu."""
    from emustart import config, lumen_pads
    logging.basicConfig(level=logging.WARNING)
    if not sys.stdout.isatty():
        sys.stdout.reconfigure(encoding="utf-8")       # przekierowanie do pliku / potoku: UTF-8
    cfg = config.load()
    prof = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--profile=")), None)
    r = lumen_pads.diag(cfg, with_sdl="--no-sdl" not in sys.argv, profile_key=prof)
    if "--json" in sys.argv:
        sys.stdout.write(json.dumps(r, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(f"Dane: {paths.APP}\n" + lumen_pads.format_diag(r) + "\n")
    sys.stdout.flush()


def main() -> None:
    if DIAG:
        diag_controllers()
        return
    boot.setup_logging("emustart.log", _UNBLOCKED)
    boot.log_versions()
    log = logging.getLogger("emustart")
    log.info("silnik Lumen, dane: %s", paths.APP)
    server.ENGINE_TOKEN = os.environ.get("LUMEN_ENGINE_TOKEN", "")
    api = lumen.LumenApi()
    server.MEDIA_CFG = lambda: api._cfg

    def bye():
        log.info("silnik Lumen: koniec")
        try:
            api._shutdown()
        finally:
            logging.shutdown()
            os._exit(0)

    api.attach(lumen.HostWindow(lumen.engine_title(), on_quit=lambda: lumen.emit({"type": "quit"})))
    base = server.start(0, dev_api=api)
    port = int(base.rsplit(":", 1)[1])
    sys.stdout.write(json.dumps({"lumen_engine": 1, "port": port, "version": __version__}) + "\n")
    sys.stdout.flush()

    # Lumen zamknięty (także awaryjnie) → stdin dostaje EOF → koniec silnika
    def watch_stdin():
        try:
            while sys.stdin.readline():
                pass
        except Exception:
            pass
        bye()
    threading.Thread(target=watch_stdin, daemon=True, name="lumen-stdin").start()
    threading.Event().wait()


if __name__ == "__main__":
    main()
