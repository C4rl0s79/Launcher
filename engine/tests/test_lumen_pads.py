"""Rejestr kontrolerów Lumen (emustart/lumen_pads.py) — urządzenia udawane, bez sprzętu."""

from __future__ import annotations

from emustart import config, lumen, lumen_pads as lp

USB_PAD = ("HID\\VID_045E&PID_02FF&IG_00\\8&1A2B3C4D&0&0000", ["USB\\VID_045E&PID_028E\\7&AA&0&2"])
WHEEL = ("HID\\VID_046D&PID_C266\\7&2F00&0&0000", ["USB\\VID_046D&PID_C266\\5&123&0&4"])
DS4_BT = ("HID\\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002054C_PID&09CC\\9&3C&0&0000",
          ["BTHENUM\\{00001124-0000-1000-8000-00805F9B34FB}_VID&0002054C_PID&09CC\\8&2A3B4C5D&0&A4AE12345678_C00000000"])
XBOX_BLE = ("HID\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&02045E_PID&0B13_REV&0509_C83F26AABBCC&COL01\\9&1&0&0000",
            ["BTHLEDEVICE\\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&02045E_PID&0B13_REV&0509_C83F26AABBCC\\8&9&0&0016"])
XBOX_ADAPTER = ("HID\\VID_045E&PID_02FF&IG_00\\9&77&0&0000",
                ["XBOXGIP\\GIP_GAMEPAD\\8&5&0&1", "USB\\VID_045E&PID_02FE\\6&9&0&3"])


def _dev(ids, path, **kw):
    d = {"path": path, "instance": ids[0], "name": kw.pop("name", ""), "serial": kw.pop("serial", "")}
    d.update(lp.parse_ids(*ids))
    d.update(kw)
    return d


def test_parse_bus_vid_pid_mac():
    assert lp.parse_ids(*USB_PAD) == {"vid": "045e", "pid": "02ff", "bus": "usb", "mac": "", "xinput": True}
    assert lp.parse_ids(*WHEEL)["bus"] == "usb"
    bt = lp.parse_ids(*DS4_BT)
    assert (bt["vid"], bt["pid"], bt["bus"], bt["mac"]) == ("054c", "09cc", "bt", "a4:ae:12:34:56:78")
    ble = lp.parse_ids(*XBOX_BLE)
    assert (ble["vid"], ble["pid"], ble["bus"], ble["mac"]) == ("045e", "0b13", "bt", "c8:3f:26:aa:bb:cc")
    assert lp.parse_ids(*XBOX_ADAPTER)["bus"] == "xbox_wireless"


def test_keys_serial_mac_path():
    devs = lp.assign_keys([_dev(WHEEL, "p1", serial="ABC123"), _dev(DS4_BT, "p2"), _dev(USB_PAD, "p3")])
    assert devs[0]["key"] == "046d:c266:sn:abc123"
    assert devs[1]["key"] == "054c:09cc:bt:a4:ae:12:34:56:78"
    assert devs[2]["key"].startswith("045e:02ff:hid:")
    assert lp.short_id(devs[0]["key"]) == "046d:c266·c123"


def test_bt_key_survives_repairing():
    # ponowne parowanie: inne identyfikatory instancji, ten sam adres MAC
    again = (DS4_BT[0].replace("9&3C", "9&77"), [DS4_BT[1][0].replace("8&2A3B4C5D", "8&11")])
    a = lp.assign_keys([_dev(DS4_BT, "\\\\?\\hid#a")])[0]["key"]
    b = lp.assign_keys([_dev(again, "\\\\?\\hid#b")])[0]["key"]
    assert a == b


def test_duplicate_serial_falls_back_to_path():
    devs = lp.assign_keys([_dev(WHEEL, "p1", serial="000123"), _dev(WHEEL, "p2", serial="000123")])
    assert devs[0]["key"] != devs[1]["key"]
    assert all(":hid:" in d["key"] for d in devs)


def test_merge_labels_and_port_change():
    reg: dict = {}
    first = lp.assign_keys([_dev(USB_PAD, "\\\\?\\hid#port1", name="Controller (Xbox)")])
    assert lp.merge(reg, first, now=100)
    assert first[0]["known"] is False and first[0]["label"] == "Controller (Xbox)"
    key1 = first[0]["key"]
    assert lp.set_label({"pad_order": {"devices": reg}}, key1, "  Pad   salon ")
    assert reg[key1]["label"] == "Pad salon"
    # ten sam pad w innym porcie USB: nowa ścieżka HID, wpis (z etykietą) przechodzi na nowy klucz
    moved = lp.assign_keys([_dev(USB_PAD, "\\\\?\\hid#port2", name="Controller (Xbox)")])
    assert lp.merge(reg, moved, now=200)
    assert key1 not in reg and moved[0]["key"] in reg
    assert moved[0]["known"] is True and moved[0]["label"] == "Pad salon"


def test_merge_no_move_when_ambiguous():
    reg: dict = {}
    lp.merge(reg, lp.assign_keys([_dev(USB_PAD, "a"), _dev(USB_PAD, "b")]), now=1)
    # oba zarejestrowane pady nieobecne, dwa nowe — nie wiadomo, który jest który
    new = lp.assign_keys([_dev(USB_PAD, "c"), _dev(USB_PAD, "d")])
    lp.merge(reg, new, now=2)
    assert len(reg) == 4 and not any(d["known"] for d in new)


def test_merge_unchanged_does_not_save():
    reg: dict = {}
    devs = lp.assign_keys([_dev(WHEEL, "p", serial="S1234")])
    assert lp.merge(reg, devs, now=1000)
    assert not lp.merge(reg, lp.assign_keys([_dev(WHEEL, "p", serial="S1234")]), now=1100)


def test_xinput_slots_unique_and_ambiguous():
    pad, wheel = _dev(USB_PAD, "a"), _dev(WHEEL, "b")
    lp.map_xinput([pad, wheel], {2: ("045e", "02ff")})
    assert pad["xinput_slot"] == 2 and "xinput_slot" not in wheel
    p1, p2 = _dev(USB_PAD, "a"), _dev(XBOX_ADAPTER, "b")
    lp.map_xinput([p1, p2], {0: ("045e", "02ff"), 1: ("045e", "02ff")})
    assert "xinput_slot" not in p1 and p1["xinput_maybe"] == [0, 1] == p2["xinput_maybe"]


def test_sdl_player_ids_like_duckstation():
    out = lp.sdl_player_ids([{"player": 1}, {"player": -1}, {"player": 1}, {"player": 0}])
    # 1 zostaje; brak → najniższy wolny (0); zajęty 1 → 2; 0 zajęty → 3
    assert [j["sdl"] for j in out] == [1, 0, 2, 3]


def test_map_sdl_by_path_xinput_and_vidpid():
    pad = dict(_dev(USB_PAD, "\\\\?\\HID#VID_045E&PID_02FF&IG_00#x"), xinput_slot=1)
    wheel = _dev(WHEEL, "\\\\?\\hid#wheel")
    ds4 = _dev(DS4_BT, "\\\\?\\hid#ds4")
    lp.map_sdl([pad, wheel, ds4], [
        {"sdl": 0, "path": "XInput#1", "vid": "045e", "pid": "02ff"},
        {"sdl": 1, "path": "\\\\?\\HID#WHEEL", "vid": "046d", "pid": "c266"},
        {"sdl": 2, "path": "", "vid": "054c", "pid": "09cc"}])
    assert (pad["sdl"], wheel["sdl"], ds4["sdl"]) == (0, 1, 2)


def test_map_sdl_extra_interfaces_of_one_pad():
    # pad 3537:1098 (prawdziwy odczyt): XInput#0 + dwa interfejsy HID producenta, które SDL też liczy
    pad = dict(_dev(USB_PAD, r"\\?\hid#vid_3537&pid_1098&ig_01#x", vid="3537", pid="1098"), xinput_slot=0)
    rest = lp.map_sdl([pad], [
        {"sdl": 0, "path": "XInput#0", "vid": "3537", "pid": "1098"},
        {"sdl": 1, "path": r"\\?\HID#VID_3537&PID_1098&MI_01&COL02#y", "vid": "3537", "pid": "1098"},
        {"sdl": 2, "path": r"\\?\HID#VID_3537&PID_1098&MI_02#z", "vid": "3537", "pid": "1098"}])
    assert pad["sdl"] == 0 and [j["sdl"] for j in rest] == [1, 2]


def test_registry_tolerates_missing_pad_order():
    cfg: dict = {"pad_order": None}
    assert lp.registry(cfg) == {} and cfg["pad_order"] == {"devices": {}}


def test_pads_set_keeps_registry(monkeypatch):
    saved = []
    monkeypatch.setattr(config, "save", lambda c: saved.append(True))
    api = lumen.LumenApi.__new__(lumen.LumenApi)
    api._cfg = {"pad_order": {"mode": "windows", "manual": [], "devices": {"k": {"label": "Kierownica"}}}}
    monkeypatch.setattr(lumen.api_mod.Api, "pads_set",
                        lambda self, mode, manual=None: (self._cfg.update(pad_order={"mode": mode, "manual": manual or []}),
                                                         {"mode": mode})[1])
    api.pads_set("manual", [1, 0])
    assert api._cfg["pad_order"] == {"mode": "manual", "manual": [1, 0], "devices": {"k": {"label": "Kierownica"}}}
    assert saved


def test_format_diag_lists_missing():
    d = lp.assign_keys([_dev(WHEEL, "p", serial="S1234", name="G29")])[0]
    d.update(label="Kierownica", xinput_slot=None, sdl=1, player=None)
    txt = lp.format_diag({"devices": [d], "sdl_dll": "", "sdl_error": "", "mode": "windows",
                          "missing": [{"key": "054c:09cc:bt:a4:ae:12:34:56:78", "label": "DS4", "bus": "bt"}]})
    assert "Kierownica" in txt and "SDL-1" in txt and "046d:c266:sn:s1234" in txt
    assert "niepodłączony: DS4" in txt


# ── etap 2: profile per gra / emulator ──

def _devs():
    wheel = dict(_dev(WHEEL, "w", serial="G29SN1"), label="Kierownica", sdl=2)
    pad_bt = dict(_dev(DS4_BT, "b"), label="Pad BT", sdl=1)
    xbox = dict(_dev(USB_PAD, "x"), label="Xbox", xinput_slot=0, sdl=0)
    return lp.assign_keys([xbox, pad_bt, wheel])


def test_profile_precedence_game_emu_default():
    cfg = {"pad_order": {"profiles": {"default": {"order": ["d"]}, "emu:duckstation": {"order": ["e"]},
                                      "game:7": {"order": ["g"]}}}}
    assert lp.profile_for(cfg, 7, "duckstation")[0] == "game:7"
    assert lp.profile_for(cfg, 8, "duckstation")[0] == "emu:duckstation"
    assert lp.profile_for(cfg, 8, "pcsx2")[0] == "default"
    assert lp.profile_for({"pad_order": {"mode": "manual"}}, 8, "pcsx2") == (None, None)


def test_set_profile_validates_and_cleans():
    cfg: dict = {}
    assert not lp.set_profile(cfg, "steam:../x", {"order": []})
    assert lp.set_profile(cfg, "game:3", {"order": ["a", "a", "b"], "hidden": ["b", "c"], "unknown": "zly"})
    assert cfg["pad_order"]["profiles"]["game:3"] == {"order": ["a", "b"], "hidden": ["c"], "unknown": "passthrough"}
    assert lp.set_profile(cfg, "game:3", None) and "game:3" not in cfg["pad_order"]["profiles"]


def test_resolve_order_hidden_and_policies():
    xbox, pad_bt, wheel = _devs()
    base = {"order": [wheel["key"], "brak:podlaczenia"], "hidden": [pad_bt["key"]]}
    r = lp.resolve(lp.clean_profile(dict(base, unknown="passthrough")), [xbox, pad_bt, wheel])
    # niepodłączone urządzenie z profilu pominięte; obce (xbox) dochodzi za profilem; ukryte — bez gracza
    assert [d["label"] for d in r["players"]] == ["Kierownica", "Xbox"]
    assert [d["label"] for d in r["hidden"]] == ["Pad BT"]
    r = lp.resolve(lp.clean_profile(dict(base, unknown="ignore")), [xbox, pad_bt, wheel])
    assert [d["label"] for d in r["players"]] == ["Kierownica"] and [d["label"] for d in r["outside"]] == ["Xbox"]


def test_acceptance_wheel_in_game_a_bt_pad_in_game_b():
    xbox, pad_bt, wheel = _devs()
    cfg = {"pad_order": {"profiles": {"game:1": {"order": [wheel["key"]]}, "game:2": {"order": [pad_bt["key"]]}}}}
    a = lp.plan(cfg, 1, "duckstation", [xbox, pad_bt, wheel])
    b = lp.plan(cfg, 2, "duckstation", [xbox, pad_bt, wheel])
    assert a["players"][0]["label"] == "Kierownica" and b["players"][0]["label"] == "Pad BT"
    assert not a["notes"] and not b["notes"]


def test_plan_xinput_family_drops_non_xinput_with_note():
    xbox, pad_bt, wheel = _devs()
    cfg = {"pad_order": {"profiles": {"emu:retroarch": {"order": [wheel["key"], xbox["key"]], "unknown": "ignore"}}}}
    p = lp.plan(cfg, 5, "retroarch", [xbox, pad_bt, wheel])
    assert p["xinput"] == [0] and [d["label"] for d in p["players"]] == ["Xbox"]
    assert "Kierownica" in p["notes"][0] and "XInput" in p["notes"][0]


def test_plan_other_emulator_is_informational():
    xbox, pad_bt, wheel = _devs()
    cfg = {"pad_order": {"profiles": {"default": {"order": [pad_bt["key"]], "unknown": "hide"}}}}
    p = lp.plan(cfg, 5, "ppsspp", [xbox, pad_bt, wheel])
    assert p["players"] == [] and p["xinput"] == []
    assert "Pad BT" in p["notes"][0] and "HidHide" in p["notes"][-1]


INI = """[Main]
SettingsVersion = 3
[Pad1]
Type = AnalogController
Cross = SDL-0/FaceSouth
Circle = SDL-0/FaceEast
[Pad2]
Type = AnalogController
Cross = XInput-1/A
"""


def test_remap_ini_sdl_and_xinput_separately_and_restore(tmp_path):
    from emustart import ingame
    xbox, pad_bt, wheel = _devs()
    ini = tmp_path / "settings.ini"
    ini.write_text(INI, encoding="utf-8")
    restore = lp.remap_ini(ingame, ini, "Pad{}", [wheel, xbox])
    assert ingame.ini_section(ini, "Pad1")["Cross"] == "SDL-2/FaceSouth"
    assert ingame.ini_section(ini, "Pad2")["Cross"] == "XInput-0/A"
    assert ingame._restore_file().is_file()          # po awarii: restore_pending przy następnym starcie
    # gracz zmienił przypisanie w trakcie gry: zostaje, wraca tylko numer urządzenia
    ingame.ini_edit(ini, {("Pad1", "Circle"): "SDL-2/FaceNorth"})
    restore()
    assert ingame.ini_section(ini, "Pad1") == {"Type": "AnalogController", "Cross": "SDL-0/FaceSouth",
                                               "Circle": "SDL-0/FaceNorth"}
    assert ingame.ini_section(ini, "Pad2")["Cross"] == "XInput-1/A"
    assert not ingame._restore_file().is_file()


def test_remap_ini_crash_restore(tmp_path):
    from emustart import ingame
    _xbox, _pad_bt, wheel = _devs()
    ini = tmp_path / "settings.ini"
    ini.write_text(INI, encoding="utf-8")
    lp.remap_ini(ingame, ini, "Pad{}", [wheel])
    ingame.restore_pending()                          # Lumen padł w trakcie gry
    assert ini.read_text(encoding="utf-8") == INI


def test_install_wraps_launch_without_touching_other_paths():
    import types
    calls = {}

    class Ad:
        family = "duckstation"

        def _ini(self):
            return "ini"

        def remap_pads(self, order):
            calls["orig_remap"] = order

    class PCSX2(Ad):
        family = "pcsx2"

    class Session:
        notice = ""

        def _play(self, g, exe, args, rom):
            order = pads_mod.order({}, None)
            calls["order"], calls["identity"] = order, pads_mod.is_identity(order)
            Ad().remap_pads(order)

    pads_mod = types.SimpleNamespace(order=lambda cfg, pads=None: ["emustart"], is_identity=lambda o: True)
    ingame_mod = types.SimpleNamespace(DuckStation=Ad, PCSX2=PCSX2, adapter_for=lambda exe: Ad())
    launcher_mod = types.SimpleNamespace(Session=Session)
    plan_ = {"family": "duckstation", "players": ["kierownica"], "xinput": [], "notes": ["uwaga"]}
    orig_launch_plan, orig_remap_ini = lp.launch_plan, lp.remap_ini
    lp.launch_plan = lambda cfg, gid, exe, fam: dict(plan_, gid=gid)
    lp.remap_ini = lambda ingame, path, fmt, players: calls.setdefault("remap_ini", (path, fmt, players))
    try:
        lp.install(launcher_mod, pads_mod, ingame_mod)
        s = Session()
        s._play({"id": 9}, "duck.exe", "", "rom")
        assert calls["order"] == [] and calls["identity"] is False
        assert calls["remap_ini"] == ("ini", "Pad{}", ["kierownica"]) and "orig_remap" not in calls
        assert s.notice == "uwaga"
        # poza startem gry (np. ekran „Kolejność padów”) — EmuStart bez zmian
        assert pads_mod.order({}) == ["emustart"] and pads_mod.is_identity([0]) is True
        lp.launch_plan = lambda *a: None             # gra bez profilu: zachowanie EmuStart
        calls.clear()
        Session()._play({"id": 10}, "duck.exe", "", "rom")
        assert calls == {"order": ["emustart"], "identity": True, "orig_remap": ["emustart"]}
    finally:
        lp.launch_plan, lp.remap_ini = orig_launch_plan, orig_remap_ini


def test_api_profile_set_saves_at_once(monkeypatch):
    saved = []
    monkeypatch.setattr(config, "save", lambda c: saved.append(True))
    api = lumen.LumenApi.__new__(lumen.LumenApi)
    api._cfg = {"pad_order": {"mode": "windows"}}
    monkeypatch.setattr(lumen.LumenApi, "lumen_controllers", lambda self: {"devices": [], "missing": []})
    r = api.lumen_controller_profile_set("emu:pcsx2", {"order": ["k1"], "unknown": "ignore"})
    assert r["ok"] and r["profile"]["order"] == ["k1"] and r["effective"] == "emu:pcsx2" and saved
    r = api.lumen_controller_profile_set("emu:pcsx2", None)          # reset
    assert r["ok"] and r["profile"] is None and r["effective"] is None
    assert not api.lumen_controller_profile_set("zly", {})["ok"]


def test_api_controllers_lists_saved_profiles(monkeypatch):
    api = lumen.LumenApi.__new__(lumen.LumenApi)
    api._cfg = {"pad_order": {"mode": "windows", "profiles": {"game:4": {"order": []}, "default": {"order": []}}}}
    monkeypatch.setattr(lp, "current", lambda cfg, save=None: [])
    r = api.lumen_controllers()
    assert r["profiles"] == ["default", "game:4"] and r["devices"] == []
