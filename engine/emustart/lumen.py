"""lumen — EmuStart jako silnik Lumen (bez własnego okna).

Lumen (Electron) uruchamia `engine_main.py` i woła metody `Api` przez lokalne
`POST /api/<metoda>` z tokenem sesji. Pełnoekranowy interfejs EmuStart (web/) działa
w oknie Lumen i woła te same metody przez most Lumen, a widok pulpitowy Lumen —
metody `lumen_*` poniżej. Logika (pobieranie, uruchamianie, zapisy, emulatory) jest
jedna: ta z `emustart/api.py`; tu tylko zestawienia dla biblioteki i kolejki zadań.

Okno: Lumen podaje tytuł swojego okna (`LUMEN_WINDOW_TITLE`), żeby menu w grze (A+Y)
i powrót po grze wyciągały na wierzch okno Lumen, jak dotąd okno EmuStart.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
import sys
import threading
import time

from emustart import api as api_mod, cache, catalog, libsync, library, lumen_discs, netsrc, profiles, savesync

log = logging.getLogger("emustart.lumen")

CONFLICTS_KEEP = 20


class _Event:
    """Zastępnik `window.events.shown` z pywebview (`+=` bez działania)."""

    def __iadd__(self, _fn):
        return self


class _Events:
    shown = _Event()


class HostWindow:
    """Okno Lumen widziane przez `Api`: tytuł do odszukania okna (winutil.find_window)."""

    native = None
    events = _Events()

    def __init__(self, title: str, on_quit):
        self.title = title
        self._on_quit = on_quit

    def destroy(self) -> None:
        self._on_quit()

    def create_file_dialog(self, *_a, **_k):
        return None                     # wybór folderu robi Lumen (most przechwytuje pick_folder)


def emit(event: dict) -> None:
    """Zdarzenie dla procesu Lumen — jedna linia JSON na stdout."""
    import json
    sys.stdout.write(json.dumps({"lumen_event": event}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def disc_counts(es: str | None = None) -> dict:
    """{id gry: liczba płyt} dla gier wielopłytowych (płyty „(Disc N)” bez .m3u albo playlisty .m3u)."""
    import json
    q = "SELECT id, files FROM games WHERE (multidisc=1 OR lower(rel) LIKE '%.m3u')"
    rows = library.db().execute(q + (" AND es=?" if es else ""), (es,) if es else ()).fetchall()
    out = {}
    for r in rows:
        try:
            files = json.loads(r["files"]) if isinstance(r["files"], str) else r["files"]
        except ValueError:
            continue
        labels = {sp[1].lower() for f in files if (sp := lumen_discs.disc_split(Path(str(f[0])).stem))}
        if len(labels) > 1:
            out[r["id"]] = len(labels)
    return out


def launchbox_ids() -> dict:
    """{id gry: id LaunchBox Games DB} z metadanych serwera — ten sam dla wszystkich wydań gry
    (regiony, tytuły japońskie / europejskie), więc Lumen łączy po nim wersje gry."""
    import json
    out = {}
    for r in library.db().execute("SELECT game_id, data FROM game_meta"):
        try:
            v = json.loads(r["data"] or "{}").get("lb_id")
        except (ValueError, TypeError):
            continue
        if isinstance(v, int) and v > 0:
            out[r["game_id"]] = v
    return out


class LumenApi(api_mod.Api):
    """`Api` EmuStart + zestawienia dla widoku pulpitowego Lumen."""

    def __init__(self):
        # gry wielopłytowe jako jedna gra (lumen_discs): po każdej synchronizacji z serwerem i od razu
        # w zapisanej kopii biblioteki — przed startem Api, które zaczyna synchronizację w tle
        lumen_discs.install(netsrc, libsync, library)
        try:
            lumen_discs.merge(library.db())
        except Exception:
            log.exception("łączenie płyt")
        super().__init__()
        self._conflicts: list = []
        self._conflicts_lock = threading.Lock()

    # konflikty zapisów: EmuStart oddaje je raz (pop) — tu zostają dla obu interfejsów
    def _keep_conflicts(self, items: list) -> list:
        if items:
            now = int(time.time())
            with self._conflicts_lock:
                self._conflicts = ([dict(c, at=now) for c in items] + self._conflicts)[:CONFLICTS_KEEP]
        return items

    def get_state(self) -> dict:
        st = super().get_state()
        self._keep_conflicts(st.get("conflicts") or [])
        return st

    def quit(self) -> None:
        # „Wyjdź z EmuStart” w trybie pełnoekranowym zamyka Lumen — decyduje Lumen
        emit({"type": "quit"})

    # ── biblioteka dla Lumen ──
    def lumen_library(self) -> dict:
        """Wszystkie widoczne gry wszystkich systemów (te same filtry co lista gier EmuStart)."""
        systems = self.list_systems()
        discs = disc_counts()
        lb = launchbox_ids()
        games = []
        for s in systems:
            try:
                rows = catalog.list_games(self._cfg, s["es"], self._profile)
            except Exception:
                log.exception("lista gier %s", s["es"])
                continue
            for r in rows:
                games.append({
                    "id": r["id"], "sid": savesync.game_id(s["es"], r["name"]), "es": s["es"],
                    "system": s["display"], "title": r["title"], "name": r["name"], "tags": r["tags"],
                    "size": r["size"], "cached": bool(r["cached"]), "pinned": bool(r["pinned"]),
                    "last": r["last"], "seconds": r["seconds"], "favorite": bool(r.get("favorite")),
                    "box": r.get("box", ""), "snap": r.get("snap", ""), "logo": r.get("logo", ""),
                    "genre": r.get("genre", ""), "year": r.get("year", ""),
                    "developer": r.get("developer", ""), "publisher": r.get("publisher", ""),
                    "players": r.get("players", ""), "discs": discs.get(r["id"], 1),
                    "lb": lb.get(r["id"], 0)})
        prof = profiles.get(self._profile) or {}
        return {"systems": systems, "games": games, "lib_version": getattr(self, "_lib_version", 0),
                "profile": {"id": prof.get("id"), "name": prof.get("name", "")},   # bez PIN-u / tokenu
                "server": self._server_state(),
                "configured": bool(self._cfg.get("emu_root")) or bool(self._cfg.get("server_key"))}

    def list_games(self, es: str) -> list:
        """Lista gier EmuStart (tryb TV) + liczba płyt (ikona przy grach wielopłytowych)."""
        rows = super().list_games(es)
        discs = disc_counts(es)
        for r in rows:
            r["discs"] = discs.get(r["id"], 1)
        return rows

    def lumen_status(self) -> dict:
        """Kolejka zadań EmuStart: uruchamianie, pobieranie, emulatory, wysyłka zapisów."""
        self._keep_conflicts(profiles.pop_conflicts())
        with self._conflicts_lock:
            conflicts = list(self._conflicts)
        return {"launch": self.launch_status(), "copies": self.copy_status(),
                "install": self.install_status(), "emu_sync": self.emu_sync_status(),
                "post": self.post_status(), "scan": dict(self._scan),
                "server": self._server_state(), "conflicts": conflicts,
                "lib_version": getattr(self, "_lib_version", 0),
                "cache": cache.usage(self._cfg)}     # zmiana = gra pobrana / usunięta (odśwież bibliotekę)

    def lumen_readiness(self, game_id: int) -> dict:
        """Czego brakuje przed uruchomieniem: emulator (i co z serwera go zainstaluje)."""
        from pathlib import Path

        from emustart import installer, systems
        g = library.game(int(game_id))
        if not g:
            return {"ok": False, "reason": "Nie ma takiej gry w bibliotece."}
        emu = self._effective_emu(g)
        info = systems.info(g["es"])
        out = {"ok": True, "emulator": emu.get("label", ""), "system": info["display"], "missing": [],
               "sync": self._sync_status(g)}           # zapisy gry na serwerze (syncclient)
        if not emu["exe"] or not Path(emu["exe"]).is_file():
            steps = installer.plan_for(g["es"], self._cfg.get("emu_root", ""))
            out["missing"].append({"kind": "emulator", "es": g["es"], "system": info["display"],
                                   "installable": bool(steps),
                                   "steps": installer.describe(steps) if steps else []})
        return out

    def lumen_conflicts_clear(self) -> None:
        with self._conflicts_lock:
            self._conflicts = []


def engine_title() -> str:
    return os.environ.get("LUMEN_WINDOW_TITLE", "Lumen")
