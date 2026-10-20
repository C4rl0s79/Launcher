"""lumen_saves — zapisy wszystkich gier przy logowaniu, starcie i wylogowaniu (tylko Lumen).

EmuStart synchronizuje paczki zapisów gry przy jej uruchomieniu i zamknięciu (syncclient.before /
after) — jak Steam Cloud. Lumen dokłada dwie rzeczy z tych samych klocków (kod EmuStart bez zmian):

- **przed wylogowaniem** — wysłanie wszystkich niewysłanych paczek (gra bez połączenia,
  `syncclient.retry`); gdy coś zostaje (serwer nieosiągalny), wylogowanie czeka na decyzję gracza —
  inaczej zapisy zostałyby na komputerze bez urządzenia, które może je wysłać;
- **po zalogowaniu i przy starcie** — pobranie nowszych wersji paczek, które ten komputer już zna
  (`save_sync`: gry synchronizowane tu wcześniej), jeśli tutaj nic się w nich nie zmieniło. Gra
  offline rusza wtedy na najnowszych zapisach z innych urządzeń. Konfliktów (zmiany tu i tam) nie
  rozstrzygamy — zostają do decyzji gracza przy uruchomieniu gry. Gra, która właśnie działa albo
  kończy wysyłanie, jest pomijana.

Gry nigdy nieuruchamiane na tym komputerze nie mają jeszcze ustalonych folderów zapisów (zależą od
emulatora i jego ustawień) — ich zapisy pobierają się przy pierwszym uruchomieniu, jak dotąd.
"""

from __future__ import annotations

import json
import logging
import zipfile

from emustart import savebundles, syncclient

log = logging.getLogger("emustart.lumen")


def _rows(where: str = "1=1") -> list:
    return [dict(r) for r in syncclient._db().execute(f"SELECT * FROM save_sync WHERE {where}")]


def unsent() -> list:
    """Paczki ze zmianami, które jeszcze nie poszły na serwer: [(platforma, gra, emulator, rdzeń, rodzaj)]."""
    out = []
    for r in _rows("dirty=1"):
        try:
            b = savebundles.from_spec(json.loads(r["spec"]))
        except (ValueError, KeyError, OSError):
            continue
        local = savebundles.content_hash(b.files)
        if local and local != r["content"]:
            out.append((r["platform"], r["game"], r["emu"], r["core"], r["kind"]))
    return out


def flush(cfg: dict) -> list:
    """Wysyła niewysłane paczki; zwraca te, które zostały (serwer nieosiągalny, konflikt)."""
    try:
        n = syncclient.retry(cfg)
        if n:
            log.info("zapisy → serwer przed wylogowaniem / przy starcie: %d paczek", n)
    except Exception:
        log.exception("wysyłanie zaległych zapisów")
    return unsent()


def pull_all(cfg: dict, busy: set | None = None) -> dict:
    """Nowsze wersje znanych paczek z serwera (tylko gdy tu bez zmian). busy — gry (platforma, gra)
    do pominięcia (trwa sesja albo wysyłanie po grze)."""
    busy = busy or set()
    groups: dict = {}
    for r in _rows():
        groups.setdefault((r["profile_id"], r["platform"], r["game"]), []).append(r)
    out = {"games": 0, "downloaded": 0, "conflicts": 0, "offline": ""}
    for (pid, plat, gid), rows in groups.items():
        if (plat, gid) in busy:
            continue
        try:
            cl = syncclient._Client(cfg, pid)
            man = cl.json("GET", f"/v1/savesync/{plat}/{gid}/manifest")
        except syncclient.Offline as ex:
            out["offline"] = str(ex)
            break                                # serwer nieosiągalny — reszta też nie przejdzie
        except Exception:
            log.exception("zapisy %s/%s: manifest", plat, gid)
            continue
        out["games"] += 1
        with syncclient._lock:
            for r in rows:
                try:
                    b = savebundles.from_spec(json.loads(r["spec"]))
                    srv = syncclient._server_bundle(man, b)
                    rev_s = int(srv.get("revision") or 0)
                    if not rev_s or rev_s == r["revision"]:
                        continue                 # nic nowego na serwerze
                    if savebundles.content_hash(b.files) != r["content"]:
                        out["conflicts"] += 1    # zmiany tu i tam — decyzja przy uruchomieniu gry
                        continue
                    syncclient._download(cl, pid, plat, gid, b, srv)
                    out["downloaded"] += 1
                except syncclient.Offline as ex:
                    out["offline"] = str(ex)
                except (OSError, ValueError, KeyError, zipfile.BadZipFile):
                    log.exception("zapisy %s/%s %s/%s/%s", plat, gid, r["emu"], r["core"], r["kind"])
    if out["downloaded"] or out["conflicts"]:
        log.info("zapisy ← serwer (wszystkie gry): %d paczek z %d gier, %d do decyzji przy uruchomieniu",
                 out["downloaded"], out["games"], out["conflicts"])
    return out
