"""lumen — EmuStart jako silnik Lumen (bez własnego okna i bez własnego interfejsu).

Lumen (Electron) uruchamia `engine_main.py` i woła metody `Api` przez lokalne
`POST /api/<metoda>` z tokenem sesji — jeden interfejs Lumen (React) w dwóch układach,
pulpit i TV. Logika (pobieranie, uruchamianie, zapisy, emulatory, konto, profile) jest
jedna: ta z `emustart/api.py`; tu tylko zestawienia dla biblioteki, kolejki zadań i opcji
gry (`lumen_*`) oraz to, czym Lumen różni się od samodzielnego EmuStart (urządzenie na
serwerze, łączenie płyt). Interfejs EmuStart (`web/`) nie jest używany ani pakowany.

Okno: Lumen podaje tytuł swojego okna (`LUMEN_WINDOW_TITLE`), żeby menu w grze (LB + A)
i powrót po grze wyciągały na wierzch okno Lumen, jak dotąd okno EmuStart.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
import sys
import threading
import time

from emustart import (api as api_mod, cache, catalog, config, libsync, library, lumen_discs, lumen_hide, lumen_pads,
                      netsrc, paths, profiles, savesync)

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


def install_device_identity(netsrc_mod) -> None:
    """Lumen to osobne urządzenie na serwerze, nawet na komputerze z samodzielnym EmuStart.

    Serwer trzyma jedną rejestrację na sprzęt (`devices.replace_same_hw`): logowanie z tym samym
    skrótem sprzętu unieważnia poprzednią rejestrację — Lumen i EmuStart na jednym komputerze
    wylogowywały się nawzajem („nieznane urządzenie”, 401). Jak dwa konta Windows na jednym
    komputerze (`netsrc.hw_id`), inny program to inne urządzenie: skrót sprzętu + „lumen”.
    Ponowna instalacja Lumena na tym samym komputerze nadal zastępuje poprzednią rejestrację Lumena.
    Od EmuStart 0.47 serwer rozróżnia też programy po polu `app` — Lumen wysyła „Lumen”."""
    import hashlib
    if getattr(netsrc_mod, "_lumen_hw", False):
        return
    netsrc_mod._lumen_hw = True
    base = netsrc_mod.hw_id

    def hw_id() -> str:
        hw = base()
        return hashlib.sha256(("lumen|" + hw).encode()).hexdigest()[:32] if hw else ""

    netsrc_mod.hw_id = hw_id

    # program w prośbie o zalogowanie (EmuStart 0.47+: serwer zastępuje tylko rejestrację tego samego
    # programu na tym sprzęcie, panel pokazuje program) — EmuStart wysyła tu na sztywno „EmuStart”
    post = netsrc_mod._post

    def _post(url, path, body=None, *a, **k):
        if path == "/v1/enroll/request" and isinstance(body, dict):
            body = {**body, "app": "Lumen"}
        return post(url, path, body, *a, **k)

    netsrc_mod._post = _post


class _LumenHost:
    """`socket` z nazwą urządzenia „<komputer> (Lumen)” — reszta bez zmian."""

    def __init__(self, real):
        self._real = real

    def __getattr__(self, name):
        return getattr(self._real, name)

    def gethostname(self) -> str:
        return f"{self._real.gethostname()} (Lumen)"


def install_device_name(*modules) -> None:
    """Lumen przedstawia się jako „<komputer> (Lumen)” tam, gdzie EmuStart rozpoznaje urządzenie po
    nazwie komputera: blokada profilu na czas gry (profiles: inaczej Lumen brał blokadę samodzielnego
    EmuStart z tego komputera za własną — dwie gry naraz na jednym profilu albo zdjęcie cudzej
    blokady), nazwa przy logowaniu (panel serwera, „z którego urządzenia” w konflikcie zapisów),
    znaczniki synchronizacji i kopie zapasowe. Sieć i certyfikaty — prawdziwa nazwa."""
    import socket as real
    for mod in modules:
        if not isinstance(getattr(mod, "socket", None), _LumenHost):
            mod.socket = _LumenHost(real)


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
        install_device_identity(netsrc)
        from emustart import savemgr
        install_device_name(profiles, api_mod, savemgr)
        from emustart import ingame, launcher, pads
        lumen_pads.install(launcher, pads, ingame)      # profile kontrolerów per gra/emulator
        # kontrolery wyłączone na czas gry, a Lumen padł w jej trakcie — włączane w tle
        threading.Thread(target=self._controllers_restore, daemon=True, name="lumen-hide-restore").start()
        self._steam_hidden: list = []
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
        # silnik nie ma własnego okna: zamknięcie (np. po aktualizacji EmuStart) — decyduje Lumen
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

    # ── opcje gry dla interfejsu Lumen (oba układy) ──
    def lumen_play_id(self, game_id: int) -> int:
        """Gra, którą się uruchamia, pobiera i usuwa: wersja wybrana w profilu gracza (tłumaczenie)
        albo sama gra — jak `playId` w interfejsie EmuStart (silnik nie podstawia jej sam)."""
        g = library.game(int(game_id))
        if not g:
            return int(game_id)
        v = self._variant_choice(g)
        return int(v["id"]) if v else int(g["id"])

    def lumen_game_options(self, game_id: int) -> dict:
        """Wszystko do „Opcji gry” w jednym wywołaniu: szczegóły (wersje, metadane, pamięć podręczna),
        opcje wybranej wersji (emulator, emulatory do wyboru, shader, stan zapisów, liczba stanów)
        i czy konto urządzenia jest administratorem serwera (edycja metadanych i grafik)."""
        det = self.game_detail(int(game_id))
        if not det:
            return {"ok": False, "reason": "Nie ma takiej gry w bibliotece."}
        pid = int(det.get("variant") or det["id"])
        opts, states = self._options_here(pid)
        return {"ok": True, "detail": det, "play_id": pid, "options": opts, "states": states,
                "admin": self._is_admin() if self._cfg.get("server_key") else False}

    def _options_here(self, game_id: int) -> tuple[dict, int]:
        """Opcje gry jak `Api.game_options` i liczba stanów na tym komputerze — bez czekania na
        wysyłkę po grze i bez synchronizacji zapisów z serwerem. `game_options` (lista „Wczytaj zapis”,
        wywoływana przez Lumen osobno) synchronizuje paczki gry przed pokazaniem listy — od EmuStart
        0.48.2 także stany PS2 (kilkadziesiąt–kilkaset MB), a Lumen otwiera opcje gry także przy samym
        przeglądaniu listy (pasek szczegółów trybu TV). Synchronizacja zostaje przy liście zapisów i przy
        uruchomieniu gry."""
        from emustart import emulators, ingame, metadata, savebundles, systems
        from emustart import launcher
        g = library.game(int(game_id))
        if not g:
            return {}, 0
        emu = self._effective_emu(g)
        opts = emulators.options_for(systems.info(g["es"]), self._cfg.get("emu_root", ""))
        states, slots = 0, []
        if emu["exe"]:
            try:
                ad = ingame.adapter_for(emu["exe"])
                profiles.bind(ad, self._profile)       # stany w folderze profilu, nie emulatora
                core = savebundles.core_id(emu.get("args", ""))
                bundles = savebundles.for_game(ad, core, launcher.content_guess(self._cfg, g, emu["exe"]),
                                               launcher.ps2_info(self._cfg, g))
                st = next((b for b in bundles if b.kind == "states"), None)
                if st is not None:
                    st.collect()
                    states = sum(1 for _p, arc in st.files if not arc.endswith(".png"))
                else:
                    meta = metadata.ensure_local(self._cfg, g)
                    learned = [r["prefix"] for r in library.db().execute(
                        "SELECT prefix FROM states WHERE game_id=? AND family=?", (g["id"], ad.family))]
                    states = len(ingame.list_states(ad, g, meta, learned))
                res = library.get_resume(self._profile, g["id"])
                if res and res["path"] and Path(res["path"]).is_file() and res["family"] == ad.family:
                    states += 1
                states = min(states, api_mod.KEEP_LIST)       # jak lista „Wczytaj zapis”
            except Exception:
                log.exception("stany gry (opcje gry)")
            else:
                if bundles:
                    try:   # sloty zapisów (EmuStart 0.50) — z plików na tym komputerze, bez synchronizacji
                        from emustart import saveslots, syncclient
                        slots = saveslots.summary(self._profile, *syncclient.game_ids(g), bundles)
                    except Exception:
                        log.exception("sloty zapisów (opcje gry)")
        sc = (self._cfg.get("systems") or {}).get(g["es"]) or {}
        return ({"id": g["id"], "title": g["title"], "emulator": emu, "options": opts, "es": g["es"],
                 "system": systems.info(g["es"])["display"],
                 "retroarch": bool(emu["exe"]) and ingame.adapter_for(emu["exe"]).family == "retroarch",
                 "shader_off": bool(sc.get("shader_off")), "sync": self._sync_kind(g, emu), "slots": slots}, states)

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
               "sync": self._sync_kind(g, emu)}           # zapisy gry na serwerze (syncclient)
        if not emu["exe"] or not Path(emu["exe"]).is_file():
            steps = installer.plan_for(g["es"], self._cfg.get("emu_root", ""))
            out["missing"].append({"kind": "emulator", "es": g["es"], "system": info["display"],
                                   "installable": bool(steps),
                                   "steps": installer.describe(steps) if steps else []})
        return out

    def lumen_conflicts_clear(self) -> None:
        with self._conflicts_lock:
            self._conflicts = []

    # ── kontrolery (lumen_pads): rejestr urządzeń obok trybu kolejności EmuStart ──
    def pads_set(self, mode: str, manual: list | None = None) -> dict:
        # EmuStart zapisuje `pad_order` od nowa (tryb + sloty) — wpisy Lumen (rejestr) zostają
        keep = {k: v for k, v in (self._cfg.get("pad_order") or {}).items() if k not in ("mode", "manual")}
        st = super().pads_set(mode, manual)
        if keep:
            self._cfg["pad_order"].update(keep)
            config.save(self._cfg)
        return st

    def lumen_controllers(self) -> dict:
        """Podłączone kontrolery gier (także nie-XInput) z etykietą i slotem XInput."""
        devs = lumen_pads.current(self._cfg, save=config.save)
        present = {d["key"] for d in devs}
        return {"devices": [lumen_pads.public(d) for d in devs],
                "missing": [{"key": k, "short": lumen_pads.short_id(k), "label": e.get("label", ""),
                             "bus": e.get("bus", ""), "bus_label": lumen_pads.BUS_LABEL.get(e.get("bus", ""), "")}
                            for k, e in lumen_pads.registry(self._cfg).items() if k not in present],
                "profiles": sorted(lumen_pads.profiles(self._cfg))}

    def lumen_controller_label(self, key: str, label: str) -> dict:
        if lumen_pads.set_label(self._cfg, str(key), str(label)):
            config.save(self._cfg)
        return self.lumen_controllers()

    def lumen_controller_profile(self, key: str) -> dict:
        """Profil `game:<id>` / `emu:<rodzina>` / `default` i ten, który faktycznie obowiązuje
        (gra → emulator → default), z kontrolerami do edytora kolejności."""
        game_id, family = None, ""
        if str(key).startswith("steam:"):
            family = "steam"
        elif str(key).startswith("game:"):
            g = library.game(int(str(key)[5:]))
            game_id = g["id"] if g else None
            emu = self._effective_emu(g) if g else {}
            if emu.get("exe"):
                from emustart import ingame
                family = ingame.adapter_for(emu["exe"]).family
        elif str(key).startswith("emu:"):
            family = str(key)[4:]
        own = (lumen_pads.profiles(self._cfg)).get(str(key))
        eff_key, eff = lumen_pads.profile_for(self._cfg, game_id, family,
                                              str(key) if family == "steam" else None)
        return {"key": str(key), "family": family, "family_label": lumen_pads.FAMILY_LABEL.get(family, family),
                "profile": lumen_pads.clean_profile(own) if isinstance(own, dict) else None,
                "effective": eff_key, "effective_profile": eff, **self.lumen_controllers()}

    def lumen_controller_profile_set(self, key: str, profile: dict | None) -> dict:
        """Zapis od razu (edytor nie ma przycisku „Zapisz”); `None` = reset (profil usunięty)."""
        if not lumen_pads.set_profile(self._cfg, str(key), profile if isinstance(profile, dict) else None):
            return {"ok": False, "reason": "Nieznany profil kontrolerów."}
        config.save(self._cfg)
        return dict(self.lumen_controller_profile(str(key)), ok=True)

    # ── ukrywanie kontrolerów: wyłączenie w Windows na czas gry (lumen_hide.py) ──

    def _controllers_restore(self) -> None:
        try:
            lumen_hide.restore_pending(paths.APP)
        except Exception:
            log.exception("kontrolery: przywracanie po awarii")

    def lumen_hide_status(self) -> dict:
        return lumen_hide.status(paths.APP)

    def lumen_hide_setup(self) -> dict:
        """Jedno pytanie administratora: zadanie Harmonogramu, które wyłącza i włącza kontrolery."""
        return lumen_hide.setup(paths.APP)

    def lumen_hide_remove(self) -> dict:
        return lumen_hide.remove(paths.APP)

    def lumen_steam_begin(self, appid: int) -> dict:
        """Przed startem gry Steam: urządzenia ukryte w jej profilu (albo domyślnym) — wyłączone."""
        self.lumen_steam_end()
        devs = lumen_pads.to_hide(self._cfg, family="steam", game_key=f"steam:{int(appid)}")
        h = lumen_pads.hide_devices(devs)
        self._steam_hidden = h["nodes"]
        return {"ok": not h["note"], "hidden": [d.get("label", "") for d in devs if d["node"] in h["nodes"]],
                "note": h["note"]}

    def lumen_steam_end(self) -> dict:
        """Gra Steam zakończona (albo nie wystartowała): urządzenia wracają."""
        nodes, self._steam_hidden = list(getattr(self, "_steam_hidden", []) or []), []
        lumen_pads.unhide(nodes)
        return {"ok": True, "restored": len(nodes)}


def engine_title() -> str:
    return os.environ.get("LUMEN_WINDOW_TITLE", "Lumen")
