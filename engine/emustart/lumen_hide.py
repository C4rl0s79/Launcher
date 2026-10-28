"""Lumen: ukrywanie kontrolerów przed grą — urządzenie wyłączone w Windows na czas gry.

Bez sterowników i bez programów z zewnątrz (Lumen jest samodzielny): wbudowane `pnputil
/disable-device` / `/enable-device`. Wyłączenie urządzenia wymaga administratora, więc raz,
przy konfiguracji (jedno pytanie UAC), Lumen zakłada zadanie Harmonogramu zadań z najwyższymi
uprawnieniami. Zadanie działa w tle (S4U — bez okna), a uruchomić je może tylko to konto.

Skrypt zadania jest zapisany w samym zadaniu (chronionym przez Windows), nie w pliku obok Lumena.
Lumen przekazuje mu tylko żądanie (`request.json` w danych Lumena): które urządzenia wyłączyć,
które włączyć. Skrypt wyłącza wyłącznie urządzenia, które są kontrolerem gier albo jego
przodkiem (USB / Bluetooth / GIP), a włącza tylko urządzenia USB / Bluetooth / GIP.

Stan (`state.json`): urządzenia wyłączone przez Lumen — po grze wracają; po awarii (Lumen padł
w trakcie gry) przy następnym starcie silnika.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import logging
import os
import subprocess
import threading
import time
from pathlib import Path
from xml.sax.saxutils import escape

log = logging.getLogger("emustart.lumen")

VERSION = 1
MARK = f"LumenControllerHide/{VERSION}"
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_lock = threading.RLock()
_mine: set = set()                  # węzły wyłączone przez ten proces (gra trwa)

# węzły, które wolno włączyć (i wyłączyć, gdy są przodkiem kontrolera gier)
NODE_PREFIXES = ("USB\\", "BTHENUM\\", "BTHLEDEVICE\\", "XBOXGIP\\")


def node_of(instance_id: str, ancestors: list) -> str:
    """Węzeł do wyłączenia: całe urządzenie (wszystkie interfejsy — HID i XInput).
    USB: pierwszy przodek USB\\ bez &MI_ (urządzenie złożone, nie hub nad nim);
    Bluetooth: węzeł BTHENUM / BTHLEDEVICE; bezprzewodowy Xbox: węzeł GIP pada (nie adapter)."""
    for s in [instance_id] + list(ancestors):
        u = s.upper()
        if u.startswith(("BTHENUM\\", "BTHLEDEVICE\\", "XBOXGIP\\")):
            return s
        if u.startswith("USB\\") and "&MI_" not in u and "ROOT_HUB" not in u:
            return s
    return ""


def folder(app: Path) -> Path:
    return Path(app) / "controller_hide"


def task_name(app: Path) -> str:
    h = hashlib.sha1(str(Path(app).resolve()).lower().encode("utf-8")).hexdigest()[:8]
    return f"\\Lumen\\Ukrywanie kontrolerow {h}"


# ── skrypt zadania (PowerShell, uruchamiany jako administrator) ──

def script(dir_: Path) -> str:
    d = str(dir_).replace("'", "''")
    return f"""$ErrorActionPreference='Continue'
$d='{d}'
$q=Get-Content -Raw -LiteralPath (Join-Path $d 'request.json') | ConvertFrom-Json
$ok=@{{}}
Get-PnpDevice -PresentOnly -Class HIDClass | Where-Object {{ ($_.HardwareID -join ' ') -match 'HID_DEVICE_UP:0001_U:000[458]' }} | ForEach-Object {{
 $id=$_.InstanceId; for($i=0;$i -lt 8 -and $id;$i++){{ $ok[$id.ToUpper()]=1; $id=(Get-PnpDeviceProperty -InstanceId $id -KeyName DEVPKEY_Device_Parent -EA SilentlyContinue).Data }} }}
$pre='^(USB|BTHENUM|BTHLEDEVICE|XBOXGIP)\\\\'
$done=@(); $err=@()
foreach($id in @($q.enable)){{ if($id -match $pre){{ $o=& pnputil.exe /enable-device "$id" 2>&1; if($LASTEXITCODE -in 0,3010){{$done+=$id}}else{{$err+="$id : $o"}} }} else {{ $err+="$id : niedozwolone" }} }}
foreach($id in @($q.disable)){{ if($id -match $pre -and $ok[$id.ToUpper()]){{ $o=& pnputil.exe /disable-device "$id" 2>&1; if($LASTEXITCODE -in 0,3010){{$done+=$id}}else{{$err+="$id : $o"}} }} else {{ $err+="$id : to nie kontroler gier" }} }}
@{{seq=$q.seq; done=$done; errors=$err; mark='{MARK}'}} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $d 'result.json')
"""


def task_xml(dir_: Path, user_sid: str) -> str:
    enc = base64.b64encode(script(dir_).encode("utf-16-le")).decode("ascii")
    args = f"-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand {enc}"
    # administratorzy i SYSTEM — pełny dostęp; to konto — odczyt i uruchamianie
    sddl = f"D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;{user_sid})"
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Lumen</Author>
    <Description>{escape(MARK)} — Lumen wyłącza wybrane kontrolery gier na czas gry (pnputil) i włącza je po grze. {escape(str(dir_))}</Description>
    <SecurityDescriptor>{sddl}</SecurityDescriptor>
  </RegistrationInfo>
  <Principals>
    <Principal id="Author">
      <UserId>{escape(user_sid)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Queue</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>{args}</Arguments>
    </Exec>
  </Actions>
</Task>
"""


# ── Windows ──

def _user_sid() -> str:
    r = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"], capture_output=True, timeout=10,
                       creationflags=_NO_WINDOW)
    return r.stdout.decode("utf-8", "replace").strip().rsplit(",", 1)[-1].strip('"')


def _schtasks(*args, timeout: float = 15) -> subprocess.CompletedProcess:
    return subprocess.run(["schtasks.exe", *args], capture_output=True, timeout=timeout, creationflags=_NO_WINDOW)


def status(app: Path) -> dict:
    """Czy zadanie istnieje i jest aktualne (ta wersja skryptu, ten folder danych)."""
    if os.name != "nt":
        return {"ready": False, "reason": "Tylko Windows."}
    try:
        r = _schtasks("/Query", "/TN", task_name(app), "/XML")
    except Exception as ex:
        return {"ready": False, "reason": f"Harmonogram zadań: {ex}"}
    if r.returncode != 0:
        return {"ready": False, "reason": "Nieskonfigurowane."}
    raw = r.stdout
    xml = raw.decode("utf-16", "replace") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") or b"\x00" in raw[:64] else \
        raw.decode("utf-8", "replace")
    if MARK not in xml or str(folder(app)) not in xml:
        return {"ready": False, "reason": "Konfiguracja z innej wersji Lumena — skonfiguruj ponownie."}
    return {"ready": True, "reason": ""}


class _ShellExecuteInfo(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_ulong), ("fMask", ctypes.c_ulong), ("hwnd", ctypes.c_void_p),
                ("lpVerb", ctypes.c_wchar_p), ("lpFile", ctypes.c_wchar_p), ("lpParameters", ctypes.c_wchar_p),
                ("lpDirectory", ctypes.c_wchar_p), ("nShow", ctypes.c_int), ("hInstApp", ctypes.c_void_p),
                ("lpIDList", ctypes.c_void_p), ("lpClass", ctypes.c_wchar_p), ("hkeyClass", ctypes.c_void_p),
                ("dwHotKey", ctypes.c_ulong), ("hIcon", ctypes.c_void_p), ("hProcess", ctypes.c_void_p)]


def _run_elevated(exe: str, params: str, timeout: float = 120) -> int:
    """Jedno pytanie UAC; kod wyjścia programu (-1 — odmowa albo błąd)."""
    sei = _ShellExecuteInfo(cbSize=ctypes.sizeof(_ShellExecuteInfo), fMask=0x40,   # SEE_MASK_NOCLOSEPROCESS
                            lpVerb="runas", lpFile=exe, lpParameters=params, nShow=0)
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(sei)) or not sei.hProcess:
        return -1
    k32 = ctypes.windll.kernel32
    try:
        k32.WaitForSingleObject(ctypes.c_void_p(sei.hProcess), int(timeout * 1000))
        code = ctypes.c_ulong()
        k32.GetExitCodeProcess(ctypes.c_void_p(sei.hProcess), ctypes.byref(code))
        return int(code.value)
    finally:
        k32.CloseHandle(ctypes.c_void_p(sei.hProcess))


def setup(app: Path) -> dict:
    """Zakłada (albo odświeża) zadanie — jedno pytanie administratora."""
    if os.name != "nt":
        return {"ok": False, "reason": "Tylko Windows."}
    d = folder(app)
    d.mkdir(parents=True, exist_ok=True)
    xml_path = d / "task.xml"
    xml_path.write_text(task_xml(d, _user_sid()), encoding="utf-16")
    code = _run_elevated("schtasks.exe", f'/Create /TN "{task_name(app)}" /XML "{xml_path}" /F')
    xml_path.unlink(missing_ok=True)
    if code != 0:
        return {"ok": False, "reason": "Nie skonfigurowano — brak zgody administratora." if code == -1 else
                f"Harmonogram zadań: błąd {code}."}
    st = status(app)
    return {"ok": st["ready"], "reason": st["reason"]}


def remove(app: Path) -> dict:
    code = _run_elevated("schtasks.exe", f'/Delete /TN "{task_name(app)}" /F')
    return {"ok": code == 0, "reason": "" if code == 0 else "Nie usunięto zadania."}


# ── wyłączanie / włączanie ──

def _state_file(app: Path) -> Path:
    return folder(app) / "state.json"


def disabled(app: Path) -> list:
    try:
        return list(json.loads(_state_file(app).read_text(encoding="utf-8")).get("disabled") or [])
    except Exception:
        return []


def _save_state(app: Path, nodes: list) -> None:
    f = _state_file(app)
    if nodes:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"disabled": nodes}, ensure_ascii=False), encoding="utf-8")
    else:
        f.unlink(missing_ok=True)


def apply(app: Path, disable: list = (), enable: list = (), timeout: float = 20) -> dict:
    """Żądanie do zadania i czekanie na wynik (gra nie czeka dłużej niż `timeout`)."""
    disable, enable = [n for n in disable if n], [n for n in enable if n]
    if not disable and not enable:
        return {"ok": True, "done": [], "errors": []}
    with _lock:
        d = folder(app)
        d.mkdir(parents=True, exist_ok=True)
        seq = time.time_ns() // 1000 % 10 ** 12
        res_f = d / "result.json"
        res_f.unlink(missing_ok=True)
        (d / "request.json").write_text(json.dumps({"seq": seq, "disable": disable, "enable": enable}),
                                        encoding="utf-8")
        try:
            r = _schtasks("/Run", "/TN", task_name(app))
        except Exception as ex:
            return {"ok": False, "done": [], "errors": [str(ex)]}
        if r.returncode != 0:
            return {"ok": False, "done": [], "errors": ["Ukrywanie kontrolerów nieskonfigurowane."]}
        end = time.monotonic() + timeout
        res = None
        while time.monotonic() < end:
            try:
                res = json.loads(res_f.read_text(encoding="utf-8-sig"))
                if res.get("seq") == seq:
                    break
            except Exception:
                pass
            res = None
            time.sleep(0.2)
        if res is None:
            return {"ok": False, "done": [], "errors": ["Zadanie nie odpowiedziało na czas."]}
        done = [x for x in (res.get("done") or []) if isinstance(x, str)]
        errors = [str(x) for x in (res.get("errors") or [])]
        now = [n for n in disabled(app) if n not in enable or n not in done]
        _save_state(app, list(dict.fromkeys(now + [n for n in disable if n in done])))
        _mine.update(n for n in disable if n in done)
        _mine.difference_update(n for n in enable if n in done)
        if errors:
            log.warning("kontrolery: ukrywanie — %s", "; ".join(errors))
        return {"ok": not errors, "done": done, "errors": errors}


def restore_pending(app: Path) -> None:
    """Urządzenia wyłączone przed awarią — włączane przy starcie silnika (w tle)."""
    if not disabled(app) or not status(app)["ready"]:
        return
    with _lock:   # gra uruchomiona w międzyczasie: jej urządzenia zostają wyłączone
        nodes = [n for n in disabled(app) if n not in _mine]
        if nodes:
            log.info("kontrolery: włączam urządzenia wyłączone przed awarią: %s", nodes)
            apply(app, enable=nodes)
