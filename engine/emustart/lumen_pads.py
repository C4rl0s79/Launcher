"""lumen_pads — stabilny rejestr kontrolerów Lumen i profile kontrolerów per gra/emulator.

EmuStart rozpoznaje pady po slocie XInput (0–3), który Windows nadaje w kolejności
podłączenia, i widzi tylko pady XInput. Tu Lumen buduje własny rejestr wszystkich
kontrolerów gier (pady, kierownice, sticki — także DirectInput/HID i Bluetooth):

- urządzenia z listy HID systemu (SetupAPI), tylko kolekcje „gra” (Usage Page 1:
  joystick / gamepad / multi-axis) — filtr po identyfikatorach sprzętu, bez otwierania;
  otwierane są tylko kontrolery, żeby odczytać nazwę i numer seryjny (bez dostępu do
  odczytu/zapisu, tylko zapytania HidD_*; nic nie jest inicjalizowane),
- stabilny klucz: VID:PID + numer seryjny; bez numeru — dla Bluetooth adres MAC,
  w pozostałych przypadkach ścieżka HID (ta zależy od portu USB, więc przy ponownym
  wykryciu działa dopasowanie: jedyne nowe urządzenie o tym samym VID:PID przejmuje
  wpis zarejestrowanego urządzenia, którego teraz nie ma — z etykietą),
- etykieta użytkownika (domyślnie nazwa produktu),
- slot XInput urządzenia (XInputGetCapabilitiesEx podaje VID/PID padu w slocie),
- przewidywany indeks „SDL-n” DuckStation/PCSX2 — tylko w diagnostyce (`--diag-controllers`),
  przez bibliotekę SDL3 samego emulatora, w osobnym procesie diagnostyki.

Rejestr leży w `cfg["pad_order"]["devices"]` — obok trybu kolejności EmuStart (`mode`,
`manual`), który zostaje bez zmian; `LumenApi.pads_set` zachowuje wpisy Lumen. Profile
(kolejność graczy, ukryte urządzenia, polityka dla obcych) i ich użycie przy starcie gry —
sekcja „profile per gra / emulator” niżej.
"""

from __future__ import annotations

import ctypes
import hashlib
import logging
import os
import re
import threading
import time
from ctypes import wintypes
from pathlib import Path

log = logging.getLogger("emustart.lumen")

# adaptery Xbox Wireless (pady za nimi nie są ani USB, ani Bluetooth)
_XBOX_ADAPTERS = re.compile(r"VID_045E&PID_(02E6|02FE)", re.I)
_GAME_USAGES = ("U:0004", "U:0005", "U:0008")      # joystick, gamepad, multi-axis
BUS_LABEL = {"usb": "USB", "bt": "Bluetooth", "xbox_wireless": "Xbox Wireless", "other": "inne"}


# ── część niezależna od Windows (testowana na udawanych danych) ──

def parse_ids(instance_id: str, ancestors: list) -> dict:
    """VID/PID, rodzaj połączenia i adres MAC z identyfikatorów urządzenia i jego przodków."""
    vid = pid = ""
    for s in [instance_id] + list(ancestors):
        m = re.search(r"VID[_&]([0-9A-F]{4,8})", s, re.I)
        p = re.search(r"PID[_&]([0-9A-F]{4})", s, re.I)
        if m and p:
            vid, pid = m.group(1)[-4:].lower(), p.group(1).lower()
            break
    chain = [instance_id] + list(ancestors)
    up = [s.upper() for s in chain]
    mac = ""
    if any(s.startswith(("BTHENUM\\", "BTHLEDEVICE\\", "BTHLE\\")) for s in up):
        bus = "bt"
        for s in up:
            if not s.startswith(("BTHENUM\\", "BTHLEDEVICE\\", "BTHLE\\", "HID\\{")):
                continue
            # BTHENUM\…\8&2A3B&0&A4AE12345678_C00000000, BTHLEDEVICE\…_REV&0509_A4AE12345678\…
            m = re.search(r"[&_]([0-9A-F]{12})(?=_C[0-9A-F]{8}$|&|\\|$)", s)
            if m:
                h = m.group(1).lower()
                mac = ":".join(h[i:i + 2] for i in range(0, 12, 2))
                break
    elif any(_XBOX_ADAPTERS.search(s) for s in up):
        bus = "xbox_wireless"
    elif any(s.startswith("USB\\") for s in up[1:]) or up[0].startswith("USB\\"):
        bus = "usb"
    else:
        bus = "other"
    return {"vid": vid, "pid": pid, "bus": bus, "mac": mac,
            "xinput": "&IG_" in up[0]}


def _clean_serial(s: str) -> str:
    s = (s or "").strip().strip("\x00")
    if len(s) < 4 or not s.strip("0") or not s.isprintable():
        return ""
    return s


def stable_key(d: dict) -> str:
    base = f"{d['vid'] or '0000'}:{d['pid'] or '0000'}"
    if d.get("serial"):
        return f"{base}:sn:{d['serial'].lower()}"
    if d.get("mac"):
        return f"{base}:bt:{d['mac']}"
    return f"{base}:hid:{hashlib.sha1(d['path'].lower().encode()).hexdigest()[:12]}"


def short_id(key: str) -> str:
    """Krótki ID do interfejsu: VID:PID i 4 ostatnie znaki części rozróżniającej."""
    parts = key.split(":", 3)
    tail = re.sub(r"[^0-9a-z]", "", parts[3].lower())[-4:] if len(parts) > 3 else ""
    return f"{parts[0]}:{parts[1]}" + (f"·{tail}" if tail else "")


def assign_keys(devs: list) -> list:
    """Klucze dla jednego odczytu. Ten sam numer seryjny u dwóch urządzeń (tanie klony)
    nie rozróżnia ich — wtedy obu zostaje ścieżka HID."""
    for d in devs:
        d["key"] = stable_key(d)
    for drop in ("serial", "mac"):
        seen: dict = {}
        for d in devs:
            seen.setdefault(d["key"], []).append(d)
        for same in seen.values():
            if len(same) > 1:
                for d in same:
                    if d.get(drop):
                        d[drop + "_dup"] = d.pop(drop)
                    d["key"] = stable_key(d)
    return devs


def merge(reg: dict, devs: list, now: int | None = None) -> bool:
    """Łączy odczyt z rejestrem `reg` ({klucz: wpis}); uzupełnia `label`/`known` w `devs`.
    Zwraca True, gdy rejestr się zmienił (trzeba go zapisać)."""
    now = int(now if now is not None else time.time())
    changed = False
    present = {d["key"] for d in devs}
    for d in devs:
        if d["key"] in reg:
            continue
        # urządzenie bez numeru seryjnego / MAC po zmianie portu: jedyny zarejestrowany wpis
        # „hid” o tym samym VID:PID, którego teraz nie ma, i jedyne takie nowe urządzenie
        if ":hid:" not in d["key"]:
            continue
        vp = d["key"].rsplit(":hid:", 1)[0] + ":hid:"
        old = [k for k in reg if k.startswith(vp) and k not in present]
        new = [x for x in devs if x["key"].startswith(vp) and x["key"] not in reg]
        if len(old) == 1 and len(new) == 1:
            reg[d["key"]] = reg.pop(old[0])
            log.info("kontroler %s: nowa ścieżka HID (inny port), wpis %s przeniesiony", d["key"], old[0])
            changed = True
    for d in devs:
        e = reg.get(d["key"])
        if e is None:
            e = reg[d["key"]] = {"label": d.get("name") or short_id(d["key"])}
            d["known"] = False
            changed = True
        else:
            d["known"] = True
        upd = {"name": d.get("name", ""), "vid": d["vid"], "pid": d["pid"], "bus": d["bus"],
               "mac": d.get("mac", ""), "path": d["path"]}
        if any(e.get(k) != v for k, v in upd.items()):
            e.update(upd)
            changed = True
        if now - int(e.get("last_seen", 0)) > 3600:     # bez zapisu konfiguracji przy każdym odczycie
            e["last_seen"] = now
            changed = True
        d["label"] = e.get("label") or d.get("name") or short_id(d["key"])
    return changed


def map_xinput(devs: list, slots: dict) -> None:
    """`slots` = {slot: (vid, pid)} z XInput. Slot dostaje urządzenie XInput o tym samym
    VID:PID, gdy jest jedno; przy identycznych padach — lista kandydatów (`xinput_maybe`)."""
    xs = [d for d in devs if d.get("xinput")]
    for slot, (vid, pid) in sorted(slots.items()):
        cand = [d for d in xs if d["vid"] == vid and d["pid"] == pid]
        same_slots = [s for s, vp in slots.items() if vp == (vid, pid)]
        if len(cand) == 1 and len(same_slots) == 1:
            cand[0]["xinput_slot"] = slot
        else:
            for d in cand:
                d.setdefault("xinput_maybe", []).append(slot)


def sdl_player_ids(joys: list) -> list:
    """Indeks „SDL-n”, jak nadają go DuckStation/PCSX2: indeks gracza SDL, a gdy go brak
    albo jest zajęty — najniższy wolny (w kolejności wykrycia)."""
    used: set = set()
    out = []
    for j in joys:
        pi = j.get("player", -1)
        if pi < 0 or pi in used:
            pi = next(i for i in range(len(joys) + 8) if i not in used)
        used.add(pi)
        out.append(dict(j, sdl=pi))
    return out


def map_sdl(devs: list, joys: list) -> list:
    """Indeks SDL przy urządzeniu: po ścieżce HID, potem po slocie XInput („XInput#N”),
    na końcu po jedynym urządzeniu o tym VID:PID, które nie ma jeszcze indeksu.
    Zwraca urządzenia SDL bez pary — np. dodatkowe interfejsy HID tego samego pada
    (klawisze multimedialne, interfejs producenta), które emulator też widzi jako SDL-n."""
    rest = []
    for j in sorted(joys, key=lambda j: (not (j.get("path") or "").lower().startswith("xinput#"), j["sdl"])):
        path = (j.get("path") or "").lower()
        free = [d for d in devs if d.get("sdl") is None]
        hit = next((d for d in free if d["path"].lower() == path), None) if path else None
        if hit is None:
            m = re.match(r"xinput#(\d+)", path)
            if m:
                hit = next((d for d in free if d.get("xinput_slot") == int(m.group(1))), None)
        if hit is None and not path:
            same = [d for d in devs if (d["vid"], d["pid"]) == (j.get("vid"), j.get("pid"))]
            if len(same) == 1 and same[0].get("sdl") is None:
                hit = same[0]
        if hit is None:
            rest.append(j)
            continue
        hit["sdl"] = j["sdl"]
        hit["sdl_name"] = j.get("name", "")
    return sorted(rest, key=lambda j: j["sdl"])


# ── Windows: odczyt urządzeń ──

class _GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8)]


class _IfData(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("InterfaceClassGuid", _GUID), ("Flags", wintypes.DWORD),
                ("Reserved", ctypes.c_void_p)]


class _DevInfo(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("ClassGuid", _GUID), ("DevInst", wintypes.DWORD),
                ("Reserved", ctypes.c_void_p)]


class _HidAttr(ctypes.Structure):
    _fields_ = [("Size", wintypes.ULONG), ("VendorID", wintypes.USHORT), ("ProductID", wintypes.USHORT),
                ("VersionNumber", wintypes.USHORT)]


_DIGCF_PRESENT, _DIGCF_DEVICEINTERFACE = 0x2, 0x10
_SPDRP_HARDWAREID = 0x1
_INVALID = ctypes.c_void_p(-1).value


def _win():
    sa = ctypes.WinDLL("setupapi", use_last_error=True)
    cm = ctypes.WinDLL("cfgmgr32")
    hid = ctypes.WinDLL("hid")
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    sa.SetupDiGetClassDevsW.restype = ctypes.c_void_p
    sa.SetupDiGetClassDevsW.argtypes = [ctypes.POINTER(_GUID), wintypes.LPCWSTR, wintypes.HWND, wintypes.DWORD]
    sa.SetupDiEnumDeviceInterfaces.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.POINTER(_GUID),
                                               wintypes.DWORD, ctypes.POINTER(_IfData)]
    sa.SetupDiGetDeviceInterfaceDetailW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_IfData), ctypes.c_void_p,
                                                    wintypes.DWORD, ctypes.POINTER(wintypes.DWORD),
                                                    ctypes.POINTER(_DevInfo)]
    sa.SetupDiGetDeviceRegistryPropertyW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_DevInfo), wintypes.DWORD,
                                                     ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD,
                                                     ctypes.POINTER(wintypes.DWORD)]
    sa.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    for f in ("HidD_GetAttributes", "HidD_GetProductString", "HidD_GetSerialNumberString"):
        getattr(hid, f).argtypes = [wintypes.HANDLE, ctypes.c_void_p] + ([wintypes.ULONG] if "String" in f else [])
    return sa, cm, hid, k32


def _dev_id(cm, inst: int) -> str:
    buf = ctypes.create_unicode_buffer(512)
    return buf.value if cm.CM_Get_Device_IDW(wintypes.DWORD(inst), buf, 512, 0) == 0 else ""


def _ancestors(cm, inst: int, limit: int = 8) -> list:
    out = []
    cur = wintypes.DWORD(inst)
    for _ in range(limit):
        parent = wintypes.DWORD()
        if cm.CM_Get_Parent(ctypes.byref(parent), cur, 0) != 0:
            break
        s = _dev_id(cm, parent.value)
        if not s or s.upper().startswith("HTREE\\ROOT"):
            break
        out.append(s)
        cur = parent
    return out


def _hw_ids(sa, h, info) -> list:
    buf = ctypes.create_unicode_buffer(2048)
    if not sa.SetupDiGetDeviceRegistryPropertyW(h, ctypes.byref(info), _SPDRP_HARDWAREID, None,
                                                buf, ctypes.sizeof(buf), None):
        return []
    raw = ctypes.wstring_at(ctypes.addressof(buf), 2048)
    return [s for s in raw.split("\x00") if s][:16]


def _hid_strings(hid, k32, path: str) -> dict:
    # dostęp 0: tylko zapytania o atrybuty — bez odczytu raportów i bez wyłączności
    h = k32.CreateFileW(path, 0, 3, None, 3, 0, None)
    if not h or h == _INVALID:
        return {}
    out = {}
    try:
        a = _HidAttr(ctypes.sizeof(_HidAttr))
        if hid.HidD_GetAttributes(h, ctypes.byref(a)):
            out["vid"], out["pid"] = f"{a.VendorID:04x}", f"{a.ProductID:04x}"
        buf = ctypes.create_unicode_buffer(128)
        if hid.HidD_GetProductString(h, buf, ctypes.sizeof(buf)):
            out["name"] = buf.value.strip()
        buf = ctypes.create_unicode_buffer(128)
        if hid.HidD_GetSerialNumberString(h, buf, ctypes.sizeof(buf)):
            out["serial"] = _clean_serial(buf.value)
    finally:
        k32.CloseHandle(h)
    return out


def scan() -> list:
    """Podłączone kontrolery gier (HID). Poza Windows — pusta lista."""
    if os.name != "nt":
        return []
    sa, cm, hid, k32 = _win()
    guid = _GUID()
    hid.HidD_GetHidGuid(ctypes.byref(guid))
    h = sa.SetupDiGetClassDevsW(ctypes.byref(guid), None, None, _DIGCF_PRESENT | _DIGCF_DEVICEINTERFACE)
    if not h or h == _INVALID:
        return []
    devs = []
    try:
        i = 0
        while True:
            ifd = _IfData(ctypes.sizeof(_IfData))
            if not sa.SetupDiEnumDeviceInterfaces(h, None, ctypes.byref(guid), i, ctypes.byref(ifd)):
                break
            i += 1
            need = wintypes.DWORD()
            info = _DevInfo(ctypes.sizeof(_DevInfo))
            sa.SetupDiGetDeviceInterfaceDetailW(h, ctypes.byref(ifd), None, 0, ctypes.byref(need), None)
            if not need.value:
                continue
            buf = ctypes.create_string_buffer(need.value)
            # cbSize = rozmiar nagłówka struktury: 8 w procesie 64-bitowym, 6 w 32-bitowym
            ctypes.cast(buf, ctypes.POINTER(wintypes.DWORD))[0] = 8 if ctypes.sizeof(ctypes.c_void_p) == 8 else 6
            if not sa.SetupDiGetDeviceInterfaceDetailW(h, ctypes.byref(ifd), buf, need, None, ctypes.byref(info)):
                continue
            path = ctypes.wstring_at(ctypes.addressof(buf) + 4)
            hw = " ".join(_hw_ids(sa, h, info)).upper()
            if "HID_DEVICE_UP:0001" not in hw or not any(u in hw for u in _GAME_USAGES):
                continue
            inst = _dev_id(cm, info.DevInst)
            d = {"path": path, "instance": inst, "name": "", "serial": ""}
            d.update(parse_ids(inst, _ancestors(cm, info.DevInst)))
            try:
                d.update({k: v for k, v in _hid_strings(hid, k32, path).items() if v})
            except Exception:
                log.exception("kontroler %s: atrybuty HID", inst)
            devs.append(d)
    finally:
        sa.SetupDiDestroyDeviceInfoList(h)
    return assign_keys(devs)


class _CapsEx(ctypes.Structure):
    _fields_ = [("Type", ctypes.c_ubyte), ("SubType", ctypes.c_ubyte), ("Flags", wintypes.WORD),
                ("Gamepad", ctypes.c_ubyte * 12), ("LeftMotor", wintypes.WORD), ("RightMotor", wintypes.WORD),
                ("VendorId", wintypes.WORD), ("ProductId", wintypes.WORD), ("ProductVersion", wintypes.WORD),
                ("unk1", wintypes.WORD), ("unk2", wintypes.DWORD)]


def xinput_slots() -> dict:
    """{slot: (vid, pid)} zajętych slotów XInput (XInputGetCapabilitiesEx, xinput1_4 — bez niej pusto)."""
    from emustart import xinput
    dll = xinput._dll
    if not dll:
        return {}
    try:
        fn = dll[108]          # XInputGetCapabilitiesEx — eksport tylko po numerze
    except (AttributeError, OSError):
        return {}
    fn.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(_CapsEx)]
    fn.restype = wintypes.DWORD
    out = {}
    for slot in range(4):
        c = _CapsEx()
        if fn(1, slot, 0, ctypes.byref(c)) == 0:
            out[slot] = (f"{c.VendorId:04x}", f"{c.ProductId:04x}")
    return out


# ── SDL (tylko diagnostyka — osobny proces) ──

def find_sdl(cfg: dict) -> Path | None:
    """SDL3.dll emulatora (DuckStation, potem PCSX2) — ta sama wersja SDL, która nada numery."""
    env = os.environ.get("LUMEN_SDL3_DLL", "").strip()
    if env and Path(env).is_file():
        return Path(env)
    exes = [str((e or {}).get("exe", "")) for e in (cfg.get("systems") or {}).values() if isinstance(e, dict)]
    exes += [str((e or {}).get("exe", "")) for e in (cfg.get("emulators") or {}).values() if isinstance(e, dict)]
    dirs = [Path(x).parent for x in exes if x]
    root = cfg.get("emu_root") or ""
    if root and Path(root).is_dir():
        try:
            dirs += [p for p in Path(root).iterdir() if p.is_dir()]
        except OSError:
            pass
    for want in ("duckstation", "pcsx2", ""):
        for d in dirs:
            if want in str(d).lower() and (d / "SDL3.dll").is_file():
                return d / "SDL3.dll"
    return None


def sdl_joysticks(dll_path: Path, wait: float = 0.6) -> list:
    """[{id, name, path, vid, pid, player}] z SDL3. Uruchamia podsystem joysticków SDL —
    wolno tylko w procesie diagnostyki (SDL otwiera część urządzeń HID, jak emulator)."""
    sdl = ctypes.CDLL(str(dll_path))
    sdl.SDL_Init.restype = ctypes.c_bool
    sdl.SDL_Init.argtypes = [ctypes.c_uint32]
    sdl.SDL_GetJoysticks.restype = ctypes.POINTER(ctypes.c_uint32)
    sdl.SDL_GetJoysticks.argtypes = [ctypes.POINTER(ctypes.c_int)]
    for f, r in (("SDL_GetJoystickNameForID", ctypes.c_char_p), ("SDL_GetJoystickPathForID", ctypes.c_char_p),
                 ("SDL_GetJoystickPlayerIndexForID", ctypes.c_int), ("SDL_GetJoystickVendorForID", ctypes.c_uint16),
                 ("SDL_GetJoystickProductForID", ctypes.c_uint16)):
        getattr(sdl, f).restype = r
        getattr(sdl, f).argtypes = [ctypes.c_uint32]
    sdl.SDL_free.argtypes = [ctypes.c_void_p]
    sdl.SDL_GetError.restype = ctypes.c_char_p
    if not sdl.SDL_Init(0x200 | 0x2000):          # SDL_INIT_JOYSTICK | SDL_INIT_GAMEPAD
        raise RuntimeError((sdl.SDL_GetError() or b"").decode("utf-8", "replace"))
    try:
        end = time.time() + wait
        while time.time() < end:                 # wykrywanie części urządzeń jest asynchroniczne
            sdl.SDL_PumpEvents()
            time.sleep(0.05)
        n = ctypes.c_int()
        ids = sdl.SDL_GetJoysticks(ctypes.byref(n))
        out = []
        for i in range(n.value):
            jid = ids[i]
            dec = (lambda b: (b or b"").decode("utf-8", "replace"))
            out.append({"id": int(jid), "name": dec(sdl.SDL_GetJoystickNameForID(jid)),
                        "path": dec(sdl.SDL_GetJoystickPathForID(jid)),
                        "vid": f"{sdl.SDL_GetJoystickVendorForID(jid):04x}",
                        "pid": f"{sdl.SDL_GetJoystickProductForID(jid):04x}",
                        "player": int(sdl.SDL_GetJoystickPlayerIndexForID(jid))})
        if ids:
            sdl.SDL_free(ids)
        return out
    finally:
        sdl.SDL_Quit()


# ── rejestr w konfiguracji ──

def registry(cfg: dict) -> dict:
    po = cfg.get("pad_order")
    if not isinstance(po, dict):
        po = cfg["pad_order"] = {}
    if not isinstance(po.get("devices"), dict):
        po["devices"] = {}
    return po["devices"]


def current(cfg: dict, save=None) -> list:
    """Odczyt + rejestr: podłączone kontrolery z etykietą i slotem XInput; `save(cfg)` przy zmianie."""
    devs = scan()
    map_xinput(devs, xinput_slots())
    if merge(registry(cfg), devs) and save:
        save(cfg)
    return devs


def set_label(cfg: dict, key: str, label: str) -> bool:
    reg = registry(cfg)
    if key not in reg:
        return False
    label = " ".join(str(label or "").split())[:40]
    reg[key]["label"] = label or reg[key].get("name") or short_id(key)
    return True


def public(d: dict) -> dict:
    """Wpis dla interfejsu (bez pełnej ścieżki urządzenia)."""
    return {"key": d["key"], "short": short_id(d["key"]), "label": d.get("label", ""),
            "name": d.get("name", ""), "bus": d["bus"], "bus_label": BUS_LABEL.get(d["bus"], d["bus"]),
            "mac": d.get("mac", ""), "xinput_slot": d.get("xinput_slot"), "known": d.get("known", True)}


# ── diagnostyka ──

def diag(cfg: dict, with_sdl: bool = True, profile_key: str | None = None) -> dict:
    from emustart import pads
    devs = current(cfg)
    out: dict = {"devices": devs, "sdl_dll": "", "sdl_error": "", "sdl_unmatched": [], "missing": []}
    out["sdl_skipped"] = not with_sdl
    if with_sdl:
        dll = find_sdl(cfg)
        out["sdl_dll"] = str(dll or "")
        if dll:
            try:
                out["sdl_unmatched"] = map_sdl(devs, sdl_player_ids(sdl_joysticks(dll)))
            except Exception as ex:
                out["sdl_error"] = f"{type(ex).__name__}: {ex}"
    # Gracz: z profilu (--profile=game:<id> / emu:<rodzina> / default), bez profilu — tryb EmuStart
    key = profile_key or ("default" if isinstance(((cfg.get("pad_order") or {}).get("profiles") or {}).get("default"), dict) else None)
    prof = (((cfg.get("pad_order") or {}).get("profiles") or {}).get(key)) if key else None
    for d in devs:
        d["player"], d["visibility"] = None, "widoczne"
    if isinstance(prof, dict):
        prof = clean_profile(prof)
        r = resolve(prof, devs)
        for i, d in enumerate(r["players"]):
            d["player"] = i + 1
        for d in r["hidden"]:
            d["visibility"] = "widoczne, ukryte w profilu"
        for d in r["outside"]:
            d["visibility"] = "widoczne, spoza profilu (" + prof["unknown"] + ")"
        out["profile"] = key
    else:
        order = pads.order(cfg, [{"slot": s, "wireless": False} for s in sorted(
            d["xinput_slot"] for d in devs if d.get("xinput_slot") is not None)])
        for d in devs:
            s_ = d.get("xinput_slot")
            d["player"] = order.index(s_) + 1 if s_ in order else None
        out["profile"] = "" if not profile_key else profile_key + " (brak)"
    present = {d["key"] for d in devs}
    out["missing"] = [{"key": k, "label": e.get("label", ""), "bus": e.get("bus", "")}
                      for k, e in registry(cfg).items() if k not in present]
    out["mode"] = (cfg.get("pad_order") or {}).get("mode", "windows")
    return out


def format_diag(r: dict) -> str:
    rows = [("Etykieta", "Połączenie", "Krótki ID", "XInput", "SDL", "Widoczność", "Gracz", "Klucz")]
    for d in r["devices"]:
        xi = str(d["xinput_slot"]) if d.get("xinput_slot") is not None else (
            "?" + "/".join(map(str, d["xinput_maybe"])) if d.get("xinput_maybe") else "—")
        rows.append((d.get("label", "")[:28], BUS_LABEL.get(d["bus"], d["bus"]) + (f" {d['mac']}" if d.get("mac") else ""),
                     short_id(d["key"]), xi, f"SDL-{d['sdl']}" if d.get("sdl") is not None else "—",
                     d.get("visibility", "widoczne"), str(d["player"]) if d.get("player") else "—", d["key"]))
    w = [max(len(r_[i]) for r_ in rows) for i in range(len(rows[0]))]
    lines = ["  ".join(c.ljust(w[i]) for i, c in enumerate(r_)).rstrip() for r_ in rows]
    lines.insert(1, "  ".join("-" * x for x in w))
    if not r["devices"]:
        lines.append("(brak podłączonych kontrolerów gier)")
    lines.append("")
    lines.append(f"Gracz wg profilu: {r['profile']}" if r.get("profile") and "(brak)" not in r["profile"] else
                 f"Gracz wg trybu kolejności EmuStart: {r['mode']}" + (f" — profil {r['profile']}" if r.get("profile") else ""))
    if r.get("sdl_skipped"):
        lines.append("SDL: pominięty (--no-sdl)")
    elif r["sdl_dll"]:
        lines.append(f"SDL: {r['sdl_dll']}" + (f" — błąd: {r['sdl_error']}" if r["sdl_error"] else
                                               " (indeks SDL-n przewidywany jak w DuckStation/PCSX2)"))
    else:
        lines.append("SDL: nie znaleziono SDL3.dll emulatora (LUMEN_SDL3_DLL=ścieżka) — kolumna SDL pusta")
    for j in r.get("sdl_unmatched") or []:
        lines.append(f"SDL-{j['sdl']}: {j.get('name', '')} [{j.get('vid', '')}:{j.get('pid', '')}] — bez pary w rejestrze "
                     f"(np. dodatkowy interfejs HID urządzenia); emulator też go numeruje")
    lines.append("Widoczność: HidHide jeszcze nieobsługiwany — wszystkie urządzenia widoczne")
    for m in r["missing"]:
        lines.append(f"Zarejestrowany, niepodłączony: {m['label']} [{short_id(m['key'])}] {m['key']}")
    return "\n".join(lines)


# ── profile per gra / emulator (etap 2) ──
#
# cfg["pad_order"]["profiles"] = {"game:<id>" | "emu:<rodzina>" | "default": {
#     "order": [klucze],            # Gracz 1, 2… (niepodłączone są pomijane, reszta przesuwa się w górę)
#     "hidden": [klucze],           # nie dostają gracza w tej grze
#     "unknown": "passthrough" | "ignore" | "hide"}}   # urządzenia spoza `order`:
#         passthrough — kolejni gracze po urządzeniach z profilu (w kolejności Windows),
#         ignore      — bez gracza,
#         hide        — bez gracza i ukryte przed grą (HidHide; bez niego jak ignore + komunikat).
# Pierwszeństwo: gra → emulator → default; bez żadnego — tryb kolejności EmuStart bez zmian.
#
# Start gry: Lumen opakowuje `launcher.Session._play` (kontekst gry w wątku sesji), `pads.order`
# (sloty XInput wg profilu) i `remap_pads` DuckStation/PCSX2 (indeksy SDL-n / XInput-n osobno,
# z przywracaniem po grze i po awarii przez mechanizm EmuStart `pad_restore.json`).

UNKNOWN = ("passthrough", "ignore", "hide")
SDL_FAMILIES = ("duckstation", "pcsx2")         # [PadN] … = SDL-n/… albo XInput-n/…
XINPUT_FAMILIES = ("retroarch", "dolphin")      # indeks pada = slot XInput
FAMILY_LABEL = {"duckstation": "DuckStation", "pcsx2": "PCSX2", "retroarch": "RetroArch", "dolphin": "Dolphin",
                "ppsspp": "PPSSPP", "rpcs3": "RPCS3"}
_PROFILE_KEY = re.compile(r"default|emu:[a-z0-9_]+|game:\d+")


def profiles(cfg: dict) -> dict:
    registry(cfg)
    po = cfg["pad_order"]
    if not isinstance(po.get("profiles"), dict):
        po["profiles"] = {}
    return po["profiles"]


def clean_profile(p: dict) -> dict:
    order = list(dict.fromkeys(str(k) for k in (p.get("order") or []) if str(k)))
    hidden = [k for k in dict.fromkeys(str(k) for k in (p.get("hidden") or [])) if k and k not in order]
    unknown = p.get("unknown") if p.get("unknown") in UNKNOWN else "passthrough"
    return {"order": order, "hidden": hidden, "unknown": unknown}


def set_profile(cfg: dict, key: str, profile: dict | None) -> bool:
    """Zapisuje (albo usuwa przy `None` — reset) profil; False przy złym kluczu."""
    if not _PROFILE_KEY.fullmatch(str(key)):
        return False
    profs = profiles(cfg)
    if profile is None:
        profs.pop(key, None)
    else:
        profs[key] = clean_profile(profile)
    return True


def profile_for(cfg: dict, game_id=None, family: str = "") -> tuple:
    profs = (cfg.get("pad_order") or {}).get("profiles") or {}
    keys = ([f"game:{int(game_id)}"] if game_id is not None else []) + ([f"emu:{family}"] if family else [])
    for k in keys + ["default"]:
        if isinstance(profs.get(k), dict):
            return k, clean_profile(profs[k])
    return None, None


def windows_order(devs: list) -> list:
    """Kolejność „jak w Windows”: najpierw sloty XInput, potem pozostałe (SDL-n, kolejność wykrycia)."""
    return [d for _i, d in sorted(enumerate(devs), key=lambda t: (
        t[1].get("xinput_slot") is None, t[1].get("xinput_slot") or 0,
        t[1].get("sdl") if t[1].get("sdl") is not None else 99, t[0]))]


def resolve(profile: dict, devs: list) -> dict:
    """Gracze (podłączone urządzenia w kolejności profilu) i urządzenia bez gracza."""
    byk = {d["key"]: d for d in devs}
    hidden = set(profile["hidden"])
    players = [byk[k] for k in profile["order"] if k in byk]
    outside = [d for d in windows_order(devs) if d["key"] not in profile["order"] and d["key"] not in hidden]
    if profile["unknown"] == "passthrough":
        players += outside
        outside = []
    return {"players": players, "hidden": [d for d in devs if d["key"] in hidden], "outside": outside}


def plan(cfg: dict, game_id, family: str, devs: list) -> dict | None:
    """Co Lumen ustawi przy starcie gry: gracze z indeksami dla emulatora i komunikaty
    dla gracza (urządzenia, których emulatorowi nie da się przypiąć — tryb informacyjny)."""
    key, prof = profile_for(cfg, game_id, family)
    if not prof:
        return None
    r = resolve(prof, devs)
    name = FAMILY_LABEL.get(family, family or "ta gra")
    notes = []
    if family in SDL_FAMILIES:
        usable = [d for d in r["players"] if d.get("sdl") is not None or d.get("xinput_slot") is not None]
    elif family in XINPUT_FAMILIES:
        usable = [d for d in r["players"] if d.get("xinput_slot") is not None]
    else:
        usable = []
        if r["players"]:
            notes.append(f"{name}: Lumen nie ustawia tu kolejności kontrolerów — kontroler 1 "
                         f"({r['players'][0].get('label', '')}) wybierz w ustawieniach emulatora.")
    dropped = [d for d in r["players"] if d not in usable]
    if dropped and family in SDL_FAMILIES + XINPUT_FAMILIES:
        notes.append(f"{name}: bez przypisania — " + ", ".join(d.get("label", "") for d in dropped) +
                     (" (tylko pady XInput)." if family in XINPUT_FAMILIES else " (brak indeksu SDL)."))
    if r["hidden"] or (prof["unknown"] == "hide" and r["outside"]):
        notes.append("Ukrywanie urządzeń przed grą wymaga HidHide — ukryte urządzenia nie dostają "
                     "gracza, ale gra nadal je widzi.")
    return {"profile": key, "family": family, "players": usable,
            "xinput": [d["xinput_slot"] for d in usable if d.get("xinput_slot") is not None], "notes": notes}


def remap_ini(ingame, path: Path, section_fmt: str, players: list, max_players: int = 4):
    """[PadN] DuckStation/PCSX2 wg graczy z profilu: SDL-n → indeks SDL urządzenia, XInput-n → jego
    slot XInput (każde źródło osobno — w EmuStart oba dostają slot XInput). Przywracanie jak
    w EmuStart: wraca tylko numer urządzenia, zmiany przypisań w trakcie gry zostają."""
    pat = re.compile(r"\b(SDL|XInput)-(\d+)/")
    changes = {}
    for p, d in enumerate(players[:max_players]):
        sec = section_fmt.format(p + 1)
        idx = {"SDL": d.get("sdl"), "XInput": d.get("xinput_slot")}
        for k, v in ingame.ini_section(path, sec).items():
            nv = pat.sub(lambda m: m.group(0) if idx[m.group(1)] is None else f"{m.group(1)}-{idx[m.group(1)]}/", v)
            if nv != v:
                changes[(sec, k)] = nv
    if not changes:
        return None
    old = ingame.ini_edit(path, changes)
    if not old:
        return None
    ingame._remember_restore(path, old)

    def restore():
        back = {}
        for (sec, key), was in old.items():
            cur = ingame.ini_section(path, sec).get(key)
            if cur is None or cur == changes[(sec, key)]:
                back[(sec, key)] = was
                continue
            # przypisanie zmienione w trakcie gry: wracają tylko numery urządzeń sprzed gry
            nums = iter(pat.findall(was))
            back[(sec, key)] = pat.sub(lambda m: f"{m.group(1)}-{next(nums, (None, m.group(2)))[1]}/", cur)
        ingame.ini_edit(path, back)
        ingame._restore_file().unlink(missing_ok=True)
    return restore


def sdl_probe(sdl_dll: Path, timeout: float = 8.0) -> dict | None:
    """{klucz: SDL-n} z osobnego procesu diagnostyki (SDL3 emulatora nie wchodzi do procesu silnika).
    None przy błędzie albo po czasie — start gry nie czeka dłużej niż `timeout`."""
    import json
    import subprocess
    import sys
    from emustart import paths
    cmd = [sys.executable] if getattr(sys, "frozen", False) else [
        sys.executable, str(Path(__file__).resolve().parent.parent / "engine_main.py")]
    cmd += ["--diag-controllers", "--json"]
    env = dict(os.environ, LUMEN_SDL3_DLL=str(sdl_dll), EMUSTART_HOME=str(paths.APP))
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout, env=env,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out = r.stdout.decode("utf-8", "replace")
        data = json.loads(out[out.index("{"):])
    except Exception as ex:
        log.warning("kontrolery: indeksy SDL niedostępne (%s)", ex)
        return None
    if data.get("sdl_error"):
        log.warning("kontrolery: SDL — %s", data["sdl_error"])
        return None
    return {d["key"]: d["sdl"] for d in data.get("devices", []) if d.get("sdl") is not None}


def launch_plan(cfg: dict, game_id, exe: str, family: str) -> dict | None:
    """Plan dla startu gry na prawdziwych urządzeniach (bez zapisu konfiguracji z wątku sesji)."""
    key, _prof = profile_for(cfg, game_id, family)
    if not key:
        return None
    devs = current(cfg)
    if family in SDL_FAMILIES:
        dll = Path(exe).parent / "SDL3.dll"
        sdl = sdl_probe(dll) if dll.is_file() else None
        for d in devs:
            if sdl is not None:
                if d["key"] in sdl:
                    d["sdl"] = sdl[d["key"]]
            elif d.get("xinput_slot") is not None:
                d["sdl"] = d["xinput_slot"]      # bez SDL emulatora: jak w EmuStart (SDL-n = slot XInput)
    p = plan(cfg, game_id, family, devs)
    if p:
        log.info("kontrolery: profil %s (%s) — gracze: %s", p["profile"], family,
                 ", ".join(f"{d.get('label')} [SDL-{d.get('sdl')}/XInput-{d.get('xinput_slot')}]"
                           for d in p["players"]) or "brak")
    return p


_ctx = threading.local()


def install(launcher_mod, pads_mod, ingame_mod) -> None:
    """Profile Lumen w starcie gry EmuStart (bez zmian w plikach EmuStart)."""
    if getattr(pads_mod, "_lumen_profiles", False):
        return
    pads_mod._lumen_profiles = True
    orig_order, orig_identity = pads_mod.order, pads_mod.is_identity
    orig_play = launcher_mod.Session._play

    def order(cfg, pads=None):
        launch = getattr(_ctx, "launch", None)
        if launch:
            if "plan" not in launch:
                launch["plan"] = None
                try:
                    launch["plan"] = launch_plan(cfg, launch["game_id"], launch["exe"], launch["family"])
                except Exception:
                    log.exception("kontrolery: profil gry")
                p = launch["plan"]
                if p and p["notes"] and not getattr(launch["session"], "notice", ""):
                    launch["session"].notice = " ".join(p["notes"])
            if launch["plan"]:
                return list(launch["plan"]["xinput"])
        return orig_order(cfg, pads)

    def is_identity(o):
        launch = getattr(_ctx, "launch", None)
        if launch and launch.get("plan") and launch["family"] in SDL_FAMILIES:
            return False            # indeksy SDL mogą się zmienić także przy tej samej kolejności XInput
        return orig_identity(o)

    def _play(self, g, exe, args, rom):
        try:
            family = ingame_mod.adapter_for(exe).family
        except Exception:
            family = ""
        _ctx.launch = {"session": self, "game_id": g.get("id"), "exe": exe, "family": family}
        try:
            return orig_play(self, g, exe, args, rom)
        finally:
            _ctx.launch = None

    pads_mod.order, pads_mod.is_identity = order, is_identity
    launcher_mod.Session._play = _play
    for cls in (ingame_mod.DuckStation, ingame_mod.PCSX2):
        def remap_pads(self, order_, _orig=cls.remap_pads):
            launch = getattr(_ctx, "launch", None)
            p = launch.get("plan") if launch else None
            if p and p["family"] == self.family:
                return remap_ini(ingame_mod, self._ini(), "Pad{}", p["players"])
            return _orig(self, order_)
        cls.remap_pads = remap_pads
