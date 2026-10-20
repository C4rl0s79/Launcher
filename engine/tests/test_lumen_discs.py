"""Lumen: gry wielopłytowe łączone w kopii biblioteki klienta (emustart/lumen_discs.py), serwer bez zmian."""

from __future__ import annotations

import json
import types

import pytest

from emustart import library, lumen_discs, paths


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(paths, "DB_PATH", tmp_path / "data" / "lib.sqlite")
    library._local.con = None
    yield library.db()
    library._local.con = None


def add(con, es, rel, files=None, multidisc=0, title=None):
    name = rel.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    files = files or [rel]
    con.execute("""INSERT INTO games(es, rel, name, title, tags, files, size, multidisc)
                   VALUES(?,?,?,?,?,?,?,?)
                   ON CONFLICT(es, rel) DO UPDATE SET files=excluded.files, size=excluded.size,
                     multidisc=excluded.multidisc, hidden=0, tags=excluded.tags""",
                (es, rel, name, title or name.split(" (")[0], name[len(name.split(" (")[0]):].strip(),
                 json.dumps([[f, 100, 1.0] for f in files]), 100 * len(files), multidisc))
    con.commit()


def rows(con, es):
    return {r["rel"]: dict(r) for r in con.execute("SELECT * FROM games WHERE es=?", (es,))}


def test_disc_split():
    assert lumen_discs.disc_split("D's Diner (Japan) (Disc B)") == ("D's Diner (Japan)", "(Disc B)", "")
    assert lumen_discs.disc_split("C&C (USA) (Disc 2) (NOD)") == ("C&C (USA)", "(Disc 2)", "(NOD)")
    for name in ("Akira (v1.3) (CD32)", "Battle Chess (CDTV)", "Dracula (Japan) (Disk Writer)", "A.E. (USA) (Side A)"):
        assert lumen_discs.disc_split(name) is None, name


def test_sets_from_the_server_become_one_game(db):
    for x in "ABC":
        add(db, "3do", f"D's Diner (Japan) (Disc {x}).chd")
    add(db, "psx", "C&C (USA) (Disc 1) (GDI).chd")
    add(db, "psx", "C&C (USA) (Disc 2) (NOD).chd")
    add(db, "psx", "Supreme (Japan) (Disc 1).chd")
    add(db, "psx", "Supreme (USA) (Disc 1).chd")               # inny region — osobno
    add(db, "psx", "Done (USA) (Disc 1).chd", ["Done (USA) (Disc 1).chd", "Done (USA) (Disc 2).chd"], 1)  # serwer już połączył
    assert lumen_discs.merge(db) == 2
    d = rows(db, "3do")
    first = d["D's Diner (Japan) (Disc A).chd"]
    assert first["multidisc"] == 1 and first["hidden"] == 0 and first["size"] == 300
    assert [f[0] for f in json.loads(first["files"])] == [f"D's Diner (Japan) (Disc {x}).chd" for x in "ABC"]
    assert first["tags"] == "(Japan)"
    assert first["name"] == "D's Diner (Japan) (Disc A)"         # grafiki, opisy, identyfikator zapisów jak dotąd
    assert d["D's Diner (Japan) (Disc B).chd"]["hidden"] == 1 and d["D's Diner (Japan) (Disc C).chd"]["hidden"] == 1
    p = rows(db, "psx")
    assert p["C&C (USA) (Disc 1) (GDI).chd"]["multidisc"] == 1 and p["C&C (USA) (Disc 2) (NOD).chd"]["hidden"] == 1
    assert p["Supreme (Japan) (Disc 1).chd"]["hidden"] == 0 and p["Supreme (USA) (Disc 1).chd"]["hidden"] == 0
    # lista gier (EmuStart i Lumen) widzi jedną grę
    assert [r["title"] for r in library.list_games("3do", 1, False)] == ["D's Diner"]


def test_merge_is_repeated_after_each_sync_and_keeps_ids(db):
    for x in "AB":
        add(db, "3do", f"Game (Disc {x}).chd")
    lumen_discs.merge(db)
    ids = {r["rel"]: r["id"] for r in rows(db, "3do").values()}
    for x in "AB":                                             # synchronizacja z serwera nadpisuje wiersze
        add(db, "3do", f"Game (Disc {x}).chd")
    assert rows(db, "3do")["Game (Disc B).chd"]["hidden"] == 0
    lumen_discs.merge(db)
    after = rows(db, "3do")
    assert after["Game (Disc A).chd"]["multidisc"] == 1 and after["Game (Disc B).chd"]["hidden"] == 1
    assert {r["rel"]: r["id"] for r in after.values()} == ids


def test_install_merges_after_sync_and_finds_other_discs_on_the_server(db):
    calls = []

    def find(cfg, g):
        calls.append(g["rel"])
        return ({g["rel"]: f"remote:{g['rel']}"}, [])            # serwer zna każdą płytę osobno

    netsrc = types.SimpleNamespace(find=find)
    libsync = types.SimpleNamespace(sync=lambda *a, **k: {"ok": True})
    lumen_discs.install(netsrc, libsync, library)
    for x in "AB":
        add(db, "3do", f"Game (Disc {x}).chd")
    assert libsync.sync({})["ok"]
    assert rows(db, "3do")["Game (Disc A).chd"]["multidisc"] == 1
    g = library.game(rows(db, "3do")["Game (Disc A).chd"]["id"])
    out, _deps = netsrc.find({}, g)
    assert set(out) == {"Game (Disc A).chd", "Game (Disc B).chd"}
    assert calls == ["Game (Disc A).chd", "Game (Disc B).chd"]
    # gra jednopłytowa — jedno zapytanie jak dotąd
    calls.clear()
    netsrc.find({}, {"rel": "x.chd", "files": [["x.chd", 1, 1]], "multidisc": 0})
    assert calls == ["x.chd"]


def test_playlist_lists_discs_not_tracks():
    files = [["G (Disc 1).cue", 1, 1], ["G (Disc 1) (Track 1).bin", 1, 1], ["G (Disc 2).cue", 1, 1],
             ["G (Disc 2) (Track 1).bin", 1, 1]]
    assert lumen_discs.playlist_files(files) == ["G (Disc 1).cue", "G (Disc 2).cue"]
