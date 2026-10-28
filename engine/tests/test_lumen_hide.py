"""Ukrywanie kontrolerów (emustart/lumen_hide.py) — bez Harmonogramu zadań i bez pnputil."""

from __future__ import annotations

import base64
import json
import re
import subprocess
import threading

from emustart import lumen_hide as lh, lumen_pads as lp


def test_node_is_whole_device():
    # USB: urządzenie złożone (bez &MI_), nie interfejs i nie hub nad nim
    assert lh.node_of(r"HID\VID_046D&PID_C266&MI_00\8&1&0&0000",
                      [r"USB\VID_046D&PID_C266&MI_00\7&2&0&0000", r"USB\VID_046D&PID_C266\SN1",
                       r"USB\VID_05E3&PID_0610\6&3&0&1", r"USB\ROOT_HUB30\5&4&0&0"]) == r"USB\VID_046D&PID_C266\SN1"
    bt = r"BTHENUM\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002054C_PID&09CC\8&2A&0&A4AE12345678_C00000000"
    assert lh.node_of(r"HID\{00001124}_VID&0002054C_PID&09CC\9&3C&0&0000", [bt]) == bt
    gip = r"XBOXGIP\GIP_GAMEPAD\8&5&0&1"
    assert lh.node_of(r"HID\VID_045E&PID_02FF&IG_00\9&77&0&0000", [gip, r"USB\VID_045E&PID_02FE\6&9&0&3"]) == gip
    assert lh.node_of(r"HID\VID_1234&PID_0001\1", [r"ACPI\X"]) == ""


def test_task_xml_runs_hidden_as_admin_for_this_user_only(tmp_path):
    xml = lh.task_xml(tmp_path, "S-1-5-21-1-2-3-1001")
    assert "<LogonType>S4U</LogonType>" in xml and "<RunLevel>HighestAvailable</RunLevel>" in xml
    assert "(A;;GRGX;;;S-1-5-21-1-2-3-1001)" in xml and lh.MARK in xml and str(tmp_path) in xml
    enc = re.search(r"-EncodedCommand (\S+)</Arguments>", xml).group(1)
    ps = base64.b64decode(enc).decode("utf-16-le")
    assert str(tmp_path) in ps and "pnputil.exe /disable-device" in ps and "HID_DEVICE_UP:0001_U:000[458]" in ps
    # wyrażenie PowerShell: ukośnik po prefiksie (w regex PowerShell zapisany podwójnie)
    assert r"$pre='^(USB|BTHENUM|BTHLEDEVICE|XBOXGIP)\\'" in ps


def _fake_task(monkeypatch, tmp_path, fail: frozenset = frozenset()):
    """Zadanie udawane: czyta request.json i pisze result.json (z BOM) jak skrypt PowerShell."""
    runs = []

    def schtasks(*args, timeout=15):
        if args[0] == "/Run":
            d = lh.folder(tmp_path)
            q = json.loads((d / "request.json").read_text(encoding="utf-8"))
            runs.append(q)
            ids = q["enable"] + q["disable"]

            def answer():
                (d / "result.json").write_text("﻿" + json.dumps(
                    {"seq": q["seq"], "done": [i for i in ids if i not in fail],
                     "errors": [f"{i} : błąd" for i in ids if i in fail]}), encoding="utf-8")
            threading.Timer(0.05, answer).start()
            return subprocess.CompletedProcess(args, 0, b"", b"")
        return subprocess.CompletedProcess(args, 1, b"", b"")
    monkeypatch.setattr(lh, "_schtasks", schtasks)
    return runs


def test_apply_disable_then_enable_keeps_state(monkeypatch, tmp_path):
    runs = _fake_task(monkeypatch, tmp_path, fail=frozenset({r"USB\B"}))
    r = lh.apply(tmp_path, disable=[r"USB\A", r"USB\B"])
    assert r["done"] == [r"USB\A"] and not r["ok"] and lh.disabled(tmp_path) == [r"USB\A"]
    r = lh.apply(tmp_path, enable=[r"USB\A"])
    assert r["ok"] and lh.disabled(tmp_path) == [] and len(runs) == 2


def test_restore_pending_enables_after_crash(monkeypatch, tmp_path):
    runs = _fake_task(monkeypatch, tmp_path)
    lh.apply(tmp_path, disable=[r"BTHENUM\X"])                     # gra wystartowała, Lumen padł
    lh._mine.clear()                                               # nowy proces silnika
    monkeypatch.setattr(lh, "status", lambda app: {"ready": True, "reason": ""})
    lh.restore_pending(tmp_path)
    assert runs[-1]["enable"] == [r"BTHENUM\X"] and lh.disabled(tmp_path) == []


def test_restore_pending_keeps_devices_of_running_game(monkeypatch, tmp_path):
    runs = _fake_task(monkeypatch, tmp_path)
    lh._save_state(tmp_path, [r"USB\OLD", r"USB\W"])              # przed awarią
    lh._mine.clear()
    lh.apply(tmp_path, disable=[r"USB\W"])                         # nowa gra ukryła to samo urządzenie
    monkeypatch.setattr(lh, "status", lambda app: {"ready": True, "reason": ""})
    lh.restore_pending(tmp_path)
    assert runs[-1]["enable"] == [r"USB\OLD"] and lh.disabled(tmp_path) == [r"USB\W"]
    lh.apply(tmp_path, enable=[r"USB\W"])
    assert r"USB\W" not in lh._mine


def test_vidpid_without_ids_is_not_hidden_from_sdl():
    assert lp.vidpid({"vid": "", "pid": ""}) == ""
    assert lp.sdl_ignore([], [{"vid": "", "pid": ""}, {"vid": "046d", "pid": "c266"}]) == ["0x046d/0xc266"]


def test_apply_without_task_reports_and_keeps_going(monkeypatch, tmp_path):
    monkeypatch.setattr(lh, "_schtasks", lambda *a, **k: subprocess.CompletedProcess(a, 1, b"", b""))
    r = lh.apply(tmp_path, disable=[r"USB\A"], timeout=0.5)
    assert not r["ok"] and r["errors"] and lh.disabled(tmp_path) == []


def test_steam_profile_and_to_hide(monkeypatch):
    wheel = dict(lp.parse_ids(r"HID\VID_046D&PID_C266\1", [r"USB\VID_046D&PID_C266\SN"]), key="w", label="Kierownica")
    pad = dict(lp.parse_ids(r"HID\VID_045E&PID_02FF&IG_00\1", [r"USB\VID_045E&PID_028E\2"]), key="p", label="Pad",
               xinput_slot=0)
    monkeypatch.setattr(lp, "current", lambda cfg, save=None: [pad, wheel])
    cfg = {"pad_order": {"profiles": {"steam:440": {"order": ["p"], "hidden": ["w"]},
                                      "emu:retroarch": {"order": [], "hidden": ["p"]}}}}
    assert lp.set_profile(cfg, "steam:570", {"order": []})
    assert [d["label"] for d in lp.to_hide(cfg, family="steam", game_key="steam:440")] == ["Kierownica"]
    # gra Steam bez własnego profilu: profil emulatora nie obowiązuje, domyślnego brak
    assert lp.to_hide(cfg, family="steam", game_key="steam:1") == []


def test_api_steam_begin_end(monkeypatch):
    from emustart import lumen
    calls = []
    dev = {"node": "USB-W", "label": "Kierownica"}
    monkeypatch.setattr(lp, "to_hide", lambda cfg, game_id=None, family="", game_key=None: calls.append(game_key) or [dev])
    monkeypatch.setattr(lp, "hide_devices", lambda devs: {"nodes": [d["node"] for d in devs], "note": ""})
    monkeypatch.setattr(lp, "unhide", lambda nodes: calls.append(("unhide", list(nodes))))
    api = lumen.LumenApi.__new__(lumen.LumenApi)
    api._cfg = {}
    r = api.lumen_steam_begin(440)
    assert r == {"ok": True, "hidden": ["Kierownica"], "note": ""} and "steam:440" in calls
    api.lumen_steam_end()
    assert calls[-1] == ("unhide", ["USB-W"])
    api.lumen_steam_end()                                   # drugi raz: nic do włączenia
    assert calls[-1] == ("unhide", [])
