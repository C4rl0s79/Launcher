"""lumen_discs — gry wielopłytowe jako jedna gra w Lumen, bez zmian na serwerze EmuStart.

Serwer EmuStart łączy płyty tylko, gdy nazwy różnią się samym numerem („(Disc 1)”, „(Disc 2)”).
Inne komplety — płyty z literą („(Disc A)”), z podtytułem po numerze („(Disc 1) (GDI)”), płyty
`.iso` obok gier-katalogów (Xbox 360) — przychodzą z serwera jako osobne gry. Lumen łączy je
w swojej kopii biblioteki, po każdej synchronizacji z serwerem:

- pierwsza płyta (wg ścieżki) zostaje grą: dostaje pliki wszystkich płyt i `multidisc=1`
  (EmuStart pobiera wtedy cały komplet i daje emulatorowi playlistę .m3u),
- pozostałe płyty dostają `hidden=1` (nie znikają — ich numery, pobrane pliki i historia zostają;
  synchronizacja z serwera i tak nadpisuje je co raz, więc łączenie powtarza się po każdej),
- nazwa gry (`name`) zostaje nazwą pierwszej płyty: te same grafiki, opisy i identyfikator zapisów
  co na innych urządzeniach z EmuStart; zmienia się tylko tytuł i oznaczenia do wyświetlania.

Pliki do pobrania: serwer zna każdą płytę jako osobną grę, więc płyty, których nie zwrócił dla
pierwszej, są szukane osobno (`find`).
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import PurePosixPath

log = logging.getLogger("emustart.lumen")

# „(Disc 1)”, „(Disc 2 of 3)”, „(Disk 1)”, „(CD 2)”, „(Disc A)” — ale nie „(CD32)” (Amiga CD32),
# „(CDTV)”, „(Disk Writer)” (FDS), „(Side A)” — to oznaczenia platformy/wydania, nie płyty
_DISC_RE = re.compile(r"\s*\((?:disc|disk)\s*(?:\d{1,2}|[a-h])\b[^)]*\)|\s*\(cd\s*(?!32\b)\d{1,2}\b[^)]*\)", re.I)
_TAG_SPLIT = re.compile(r"\s+(?=[(\[])")
# pliki ścieżek płyty .cue / .ccd — nie są płytami w playliście .m3u
TRACK_EXTS = (".bin", ".raw", ".wav", ".sub", ".ogg")


def disc_split(stem: str) -> tuple | None:
    """'C&C (USA) (Disc 1) (GDI)' → ('C&C (USA)', '(Disc 1)', '(GDI)'); bez oznaczenia płyty → None."""
    m = _DISC_RE.search(stem)
    if not m:
        return None
    return stem[:m.start()].strip(), m.group(0).strip(), stem[m.end():].strip()


def _stem(rel: str) -> str:
    return PurePosixPath(rel.replace("\\", "/")).stem


def _files(v) -> list:
    try:
        return json.loads(v) if isinstance(v, str) else list(v or [])
    except ValueError:
        return []


def disc_sets(rows: list) -> list:
    """Wiersze gier jednego systemu → komplety płyt do połączenia: [[wiersz, …]] (≥ 2 płyty,
    ten sam folder i ta sama nazwa do oznaczenia płyty), posortowane wg ścieżki."""
    groups: dict = {}
    for r in rows:
        if r["multidisc"] or r["is_dir"]:
            continue
        sp = disc_split(r["name"])
        if not sp:
            continue
        key = (os.path.dirname(r["rel"].replace("\\", "/")).lower(), sp[0].lower())
        groups.setdefault(key, []).append(r)
    out = []
    for g in groups.values():
        labels = {disc_split(r["name"])[1].lower() for r in g}
        if len(g) > 1 and len(labels) == len(g):        # różne płyty, nie kopie tej samej
            out.append(sorted(g, key=lambda r: r["rel"].lower()))
    return out


def merge(con, es: str | None = None) -> int:
    """Łączy komplety płyt w bazie (wszystkie systemy albo jeden). Zwraca liczbę połączonych gier."""
    q = "SELECT id, es, rel, name, title, tags, files, size, is_dir, multidisc, hidden FROM games"
    rows = [dict(r) for r in con.execute(q + (" WHERE es=?" if es else ""), (es,) if es else ())]
    by_es: dict = {}
    for r in rows:
        by_es.setdefault(r["es"], []).append(r)
    merged = 0
    with con:
        for es_rows in by_es.values():
            for s in disc_sets(es_rows):
                first, rest = s[0], s[1:]
                files, size = [], 0
                for r in s:
                    files += _files(r["files"])
                    size += int(r["size"] or 0)
                base = disc_split(first["name"])[0]
                tags = _TAG_SPLIT.split(base, maxsplit=1)
                con.execute("UPDATE games SET files=?, size=?, multidisc=1, tags=? WHERE id=?",
                            (json.dumps(files), size, tags[1].strip() if len(tags) > 1 else "", first["id"]))
                con.executemany("UPDATE games SET hidden=1 WHERE id=?", [(r["id"],) for r in rest])
                merged += 1
    if merged:
        log.info("gry wielopłytowe połączone w Lumen: %d", merged)
    return merged


def install(netsrc, libsync, library) -> None:
    """Łączenie po każdej synchronizacji z serwerem + szukanie brakujących płyt na serwerze."""
    if getattr(libsync, "_lumen_discs", False):
        return
    libsync._lumen_discs = True
    sync_orig = libsync.sync

    def sync(*a, **k):
        res = sync_orig(*a, **k)
        try:
            merge(library.db())
        except Exception:
            log.exception("łączenie płyt")
        return res

    libsync.sync = sync
    find_orig = netsrc.find

    def find(cfg: dict, g: dict):
        out, deps = find_orig(cfg, g)
        if not g.get("multidisc") or not out:
            return out, deps
        # płyty z innych gier na serwerze (połączone w Lumen) — każda szukana osobno
        for rel, _size, _mt in g["files"]:
            if rel in out or rel.lower().endswith(TRACK_EXTS) or not disc_split(_stem(rel)):
                continue
            more, _d = find_orig(cfg, dict(g, rel=rel))
            out.update({k: v for k, v in more.items() if k not in out})
        return out, deps

    netsrc.find = find


def playlist_files(files: list) -> list:
    """Pliki do playlisty .m3u: płyty, bez ścieżek .bin/.wav obok .cue."""
    return [rel for rel, _s, _m in files if not rel.lower().endswith(TRACK_EXTS)]
