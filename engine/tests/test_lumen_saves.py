"""lumen_saves: zapisy wszystkich znanych gier — wysyłka przed wylogowaniem, pobranie po zalogowaniu."""

import json

import pytest

from emustart import library, lumen_saves, paths, savebundles, syncclient


@pytest.fixture()
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(paths, "DATA", tmp_path / "data")
    monkeypatch.setattr(paths, "DB_PATH", tmp_path / "data" / "lib.sqlite")
    library._local.con = None
    yield tmp_path
    library._local.con = None


def _bundle(folder, stem, text):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{stem}.srm").write_text(text)
    return savebundles.from_spec({"emu": "retroarch", "core": "bsnes", "kind": "saves",
                                  "folder": str(folder), "stem": stem, "names": [stem]})


def _remember(b, game, revision, content, dirty=False):
    syncclient._remember(1, "snes", game, b, revision, content, dirty)


class FakeClient:
    manifests: dict = {}

    def __init__(self, cfg, pid):
        if cfg.get("offline"):
            raise syncclient.Offline("brak sieci")

    def json(self, method, path, d=None):
        game = path.split("/")[4]
        rev = self.manifests.get(game, 0)
        return {"emulators": {"retroarch": {"cores": {"bsnes": {"bundles": {"saves": {"revision": rev}}}}}}}


def test_pull_all_downloads_only_unchanged_and_skips_busy(db, monkeypatch):
    a = _bundle(db / "a", "A", "a1")                     # serwer nowszy, tu bez zmian → pobranie
    b = _bundle(db / "b", "B", "b1")                     # serwer nowszy, tu zmiana → decyzja przy grze
    c = _bundle(db / "c", "C", "c1")                     # gra trwa → pominięta
    d = _bundle(db / "d", "D", "d1")                     # serwer bez zmian → nic
    _remember(a, "ga", 1, savebundles.content_hash(a.files))
    _remember(b, "gb", 1, "inna-zawartość")
    _remember(c, "gc", 1, savebundles.content_hash(c.files))
    _remember(d, "gd", 2, savebundles.content_hash(d.files))
    FakeClient.manifests = {"ga": 2, "gb": 3, "gc": 5, "gd": 2}
    got = []
    monkeypatch.setattr(syncclient, "_Client", FakeClient)
    monkeypatch.setattr(syncclient, "_download", lambda cl, pid, plat, gid, bb, srv: got.append((gid, srv["revision"])))
    r = lumen_saves.pull_all({}, busy={("snes", "gc")})
    assert got == [("ga", 2)]
    assert r["downloaded"] == 1 and r["conflicts"] == 1 and r["offline"] == ""


def test_pull_all_offline_stops(db, monkeypatch):
    a = _bundle(db / "a", "A", "a1")
    _remember(a, "ga", 1, savebundles.content_hash(a.files))
    monkeypatch.setattr(syncclient, "_Client", FakeClient)
    r = lumen_saves.pull_all({"offline": True})
    assert r["offline"] and r["downloaded"] == 0


def test_unsent_and_flush(db, monkeypatch):
    a = _bundle(db / "a", "A", "zmiana offline")
    b = _bundle(db / "b", "B", "b1")
    _remember(a, "ga", 1, "stara", dirty=True)
    _remember(b, "gb", 1, savebundles.content_hash(b.files), dirty=True)   # już wysłane — nie liczy się
    assert lumen_saves.unsent() == [("snes", "ga", "retroarch", "bsnes", "saves")]
    monkeypatch.setattr(syncclient, "retry", lambda cfg: 0)                # serwer nieosiągalny
    assert len(lumen_saves.flush({})) == 1

    def sent(cfg):
        _remember(a, "ga", 2, savebundles.content_hash(a.files))
        return 1
    monkeypatch.setattr(syncclient, "retry", sent)
    assert lumen_saves.flush({}) == []
