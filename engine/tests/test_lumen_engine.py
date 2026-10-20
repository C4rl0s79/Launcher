"""EmuStart jako silnik Lumen (engine_main.py, emustart/lumen.py) — dane wyłącznie testowe."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request

from emustart import lumen, paths, savesync, server


def test_data_home_from_env(monkeypatch, tmp_path):
    monkeypatch.setenv("EMUSTART_HOME", str(tmp_path))
    assert paths.data_home() == tmp_path.resolve()
    monkeypatch.delenv("EMUSTART_HOME")
    assert paths.data_home() == paths.app_dir()


class _Api:
    def ping(self):
        return {"pong": True}


def _post(url: str, headers: dict) -> int:
    req = urllib.request.Request(url, data=b"[]", method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as ex:
        return ex.code


def test_api_needs_session_token(monkeypatch):
    monkeypatch.setattr(server, "ENGINE_TOKEN", "sekret-testowy")
    base = server.start(0, dev_api=_Api())
    assert _post(base + "/api/ping", {"X-EmuStart": "1"}) == 403
    assert _post(base + "/api/ping", {"X-EmuStart": "1", "X-Lumen-Token": "zly"}) == 403
    assert _post(base + "/api/ping", {"X-EmuStart": "1", "X-Lumen-Token": "sekret-testowy"}) == 200


def test_without_engine_token_api_works_as_before(monkeypatch):
    monkeypatch.setattr(server, "ENGINE_TOKEN", "")
    base = server.start(0, dev_api=_Api())
    assert _post(base + "/api/ping", {"X-EmuStart": "1"}) == 200


def _bare_api() -> lumen.LumenApi:
    api = object.__new__(lumen.LumenApi)
    api._cfg = {"emu_root": "D:/emu"}
    api._profile = 1
    api._conflicts = []
    api._conflicts_lock = threading.Lock()
    api._lib_version = 3
    return api


def test_library_has_stable_ids_and_no_secrets(monkeypatch):
    api = _bare_api()
    monkeypatch.setattr(lumen.LumenApi, "list_systems", lambda self: [{"es": "snes", "display": "Super Nintendo"}])
    monkeypatch.setattr(lumen.LumenApi, "_server_state", lambda self: {"ok": True})
    monkeypatch.setattr(lumen.catalog, "list_games", lambda cfg, es, prof: [
        {"id": 12, "name": "Test Quest (Europe)", "title": "Test Quest", "tags": "(Europe)", "size": 10,
         "cached": 1, "pinned": 0, "last": 0, "seconds": 0, "favorite": 0, "box": "/media/x"}])
    monkeypatch.setattr(lumen.profiles, "get", lambda pid: {"id": 1, "name": "Gracz", "pin_hash": "h", "pin_token": "t"})
    lib = api.lumen_library()
    g = lib["games"][0]
    assert g["sid"] == savesync.game_id("snes", "Test Quest (Europe)")
    assert g["cached"] is True and g["es"] == "snes" and g["box"] == "/media/x"
    assert lib["profile"] == {"id": 1, "name": "Gracz"}
    assert "pin_hash" not in json.dumps(lib) and "pin_token" not in json.dumps(lib)


def test_conflicts_reach_both_interfaces():
    api = _bare_api()
    api._keep_conflicts([{"profile": "Gracz", "file": "a.srm"}])
    api._keep_conflicts([])
    assert [c["file"] for c in api._conflicts] == ["a.srm"]
    api.lumen_conflicts_clear()
    assert api._conflicts == []


def test_quit_is_left_to_lumen(capsys):
    _bare_api().quit()
    out = capsys.readouterr().out.strip()
    assert json.loads(out) == {"lumen_event": {"type": "quit"}}


def test_disc_counts(tmp_path, monkeypatch):
    """Liczba płyt gry wielopłytowej (ikona w obu interfejsach) — z plików gry w bazie."""
    import json as _json
    from emustart import library
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(paths, "DB_PATH", tmp_path / "data" / "lib.sqlite")
    library._local.con = None
    con = library.db()
    def add(gid, rel, files, multidisc):
        con.execute("INSERT INTO games(id, es, rel, name, title, tags, files, size, multidisc) VALUES (?,?,?,?,?,?,?,?,?)",
                    (gid, "psx", rel, rel, rel, "", _json.dumps([[f, 1, 1.0] for f in files]), 1, multidisc))
    add(1, "Diner (Disc A).chd", ["Diner (Disc A).chd", "Diner (Disc B).chd", "Diner (Disc C).chd"], 1)
    add(2, "FF7 (USA).m3u", ["FF7 (USA).m3u", "FF7 (USA) (Disc 1).cue", "FF7 (USA) (Disc 1).bin", "FF7 (USA) (Disc 2).cue",
                              "FF7 (USA) (Disc 2).bin"], 0)
    add(3, "Single (USA).chd", ["Single (USA).chd"], 0)
    con.commit()
    assert lumen.disc_counts() == {1: 3, 2: 2}
    assert lumen.disc_counts("snes") == {}
    library._local.con = None


def test_launchbox_ids(tmp_path, monkeypatch):
    """Id LaunchBox z metadanych serwera — Lumen łączy po nim wydania jednej gry."""
    import json as _json
    from emustart import library
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(paths, "DB_PATH", tmp_path / "data" / "lib.sqlite")
    library._local.con = None
    con = library.db()
    for gid, data in ((1, {"lb_id": 4879}), (2, {"lb_id": 4879}), (3, {}), (4, {"lb_id": "x"})):
        con.execute("INSERT INTO game_meta(game_id, data, edits, online, updated) VALUES(?,?,?,?,?)",
                    (gid, _json.dumps(data), "{}", 1, 0))
    con.execute("INSERT INTO game_meta(game_id, data, edits, online, updated) VALUES(5, 'zepsute', '{}', 1, 0)")
    con.commit()
    assert lumen.launchbox_ids() == {1: 4879, 2: 4879}
    library._local.con = None
