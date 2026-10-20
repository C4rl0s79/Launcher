"""EmuStart jako silnik Lumen — bez okna, sterowany przez proces Lumen.

    python engine_main.py

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
import sys
import threading

# pady w interfejsie obsługuje Lumen (XInput w procesie głównym); menu w grze (A+Y) — nadal EmuStart
if not any(a.startswith("--pady=") for a in sys.argv):
    sys.argv.append("--pady=none")

from emustart import boot  # noqa: E402

_UNBLOCKED = boot.unblock_self()

from emustart import __version__, lumen, paths, server  # noqa: E402


def main() -> None:
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
