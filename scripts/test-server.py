"""Disposable EmuStart Server for Lumen integration tests — loopback only, one dummy game file.

    py -3 scripts/test-server.py <work dir> [port]

Uses the EmuStart code in engine/. Everything lives in <work dir> (use .lumen-test/, ignored by
git): server data, a dummy NES file (an iNES header and zeros — not a real game), logs.
Writes <work>/login.txt (one-time login link, as "Add device" in the server panel) and
<work>/ready.txt once the library is scanned. Binds 127.0.0.1 only. Stop with Ctrl+C.
"""
import json
import os
import sys
import time
from pathlib import Path

engine = Path(__file__).resolve().parent.parent / "engine"
work = Path(sys.argv[1]).resolve()
port = int(sys.argv[2]) if len(sys.argv) > 2 else 47740
os.environ["EMUSTART_HOME"] = str(work / "srv")
sys.path.insert(0, str(engine))

roms = work / "roms" / "nes"
roms.mkdir(parents=True, exist_ok=True)
game = roms / "Lumen Test Cart (World).nes"
if not game.exists():
    game.write_bytes(b"NES\x1a\x02\x01" + bytes(10) + bytes(2 * 16384 + 8192))
srv = work / "srv" / "server"
srv.mkdir(parents=True, exist_ok=True)
cfgp = srv / "config.json"
if not cfgp.exists():
    cfgp.write_text(json.dumps({"rom_roots": [str(work / "roms")], "server_port": port}), encoding="utf-8")

from emustart import boot, config, paths, remote, server, srvadmin, srvapi, tls  # noqa: E402

boot.setup_logging("emustart.log", 0, work / "srvlogs")
paths.use_server_layout(migrate=False)
server.ROUTES["/media/"] = paths.MEDIA
config.load()
api = srvapi.ServerApi()
remote.API = api
remote.ensure_token(api._cfg)
remote.init_nas(api._cfg)
srvadmin.ENABLED = True
srvadmin._addresses = lambda: ["127.0.0.1"]          # advertise loopback only
server.start(port, dev_api=api, bind="127.0.0.1")
remote.PORT = port
cert, key, fp = tls.ensure(paths.SERVER)
tport = server.start_tls(port + 1, tls.server_context(cert, key), bind="127.0.0.1")
remote.TLS = {"port": tport, "fp": fp}

api.rescan()
while api.scan_status().get("running"):
    time.sleep(0.3)
print("scan:", api.scan_status().get("result"), flush=True)
(work / "login.txt").write_text(srvadmin.login_code(api).get("uri", ""), encoding="utf-8")
(work / "ready.txt").write_text("ok", encoding="utf-8")
print("ready", flush=True)
while True:
    time.sleep(3600)
