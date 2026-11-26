#!/usr/bin/env python3
"""Measure cold and restored-workspace startup, plus headless browser idle CPU.

Run on macOS against development builds. Each app uses its own disposable
profile, encrypted runtime data and workspace directory.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from source_smoke import marionette, run_script


READY = r"""
const [count, seed] = arguments;
const done = arguments[arguments.length - 1];
(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
  for (let tries = 0; tries < 150 && !document.getElementById("lima-assistant-toggle"); tries++) await sleep(100);
  await LimaBridge.request("host.hello");
  const ready = Date.now();
  if (seed) {
    for (let i = 0; i < count; i++) {
      await LimaBridge.request("workspace.create", { name: `Sidebar benchmark ${i + 1}`, provider: "claude" });
    }
  }
  const found = () => document.querySelectorAll("zen-folder[lima-workspace]:not([lima-agent])").length;
  for (let tries = 0; tries < 150 && found() < count; tries++) await sleep(100);
  if (found() !== count) throw new Error(`Expected ${count} workspace rows, found ${found()}.`);
  window.gZenCompactModeManager.preference = false;
  Services.prefs.setBoolPref("lima.welcome.finished", true);
  const start = Date.now() - performance.now();
  done({ browserReadyMs: Math.round(ready - start), rowsReadyMs: Math.round(Date.now() - start) });
})().catch(error => done({ error: String(error) }));
"""


def cpu_seconds(pid):
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,time="], text=True).splitlines()
    processes = {int(p): (int(parent), duration) for p, parent, duration in (row.split() for row in rows)}
    own = {pid}
    while True:
        expanded = own | {p for p, (parent, _) in processes.items() if parent in own}
        if expanded == own:
            break
        own = expanded
    return sum(sum(float(part) * 60 ** i for i, part in enumerate(reversed(processes[p][1].split(":"))))
               for p in own if p in processes)


def launch(app, root, count, seed, idle_interval):
    profile = root / "profile"
    profile.mkdir(exist_ok=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    (profile / "user.js").write_text(f'user_pref("marionette.port", {port});\n')
    env = dict(os.environ, MOZ_HEADLESS="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1",
               LIMA_DATA_DIR=str(root / "runtime"), LIMA_KEY_FILE=str(root / "key"),
               LIMA_WORKSPACES_ROOT=str(root / "workspaces"))
    with (root / "browser.log").open("wb") as log:
        first = time.monotonic()
        process = subprocess.Popen([app / "Contents/MacOS/lima", "-profile", profile, "-headless", "-no-remote",
                                    "--marionette"], env=env, stdout=log, stderr=log)
        try:
            while time.monotonic() - first < 30 and process.poll() is None:
                try:
                    conn = socket.create_connection(("127.0.0.1", port), timeout=1)
                    break
                except OSError:
                    time.sleep(0.15)
            else:
                raise RuntimeError("Lima did not begin listening.")
            with conn:
                conn.settimeout(50)
                send = marionette(conn)
                result = run_script(send, "chrome", READY, [count, seed])
                if "error" in result:
                    raise RuntimeError(result["error"])
                if not seed:
                    time.sleep(3)
                    started = time.monotonic()
                    before = cpu_seconds(process.pid)
                    time.sleep(idle_interval)
                    result["idleCPUPercent"] = round((cpu_seconds(process.pid) - before) * 100 / (time.monotonic() - started), 2)
                run_script(send, "chrome", """
                    const done = arguments[arguments.length - 1];
                    const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
                    LimaBridge.request("host.shutdown").then(() => done(true), () => done(false));
                """)
                try:
                    send("Marionette:Quit", {"flags": ["eAttemptQuit"]})
                except (EOFError, OSError):
                    pass
                return result
        finally:
            if process.poll() is None:
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apps", nargs="+", type=Path)
    parser.add_argument("--workspaces", type=int, default=24)
    parser.add_argument("--idle-seconds", type=int, default=15)
    args = parser.parse_args()
    if not 1 <= args.workspaces <= 60 or not 5 <= args.idle_seconds <= 60:
        parser.error("Choose 1 to 60 workspaces and 5 to 60 idle seconds.")
    for app in args.apps:
        with tempfile.TemporaryDirectory(dir="/tmp", prefix="lima-perf-") as temp:
            root = Path(temp)
            cold = launch(app.resolve(), root, args.workspaces, seed=True, idle_interval=args.idle_seconds)
            warm = launch(app.resolve(), root, args.workspaces, seed=False, idle_interval=args.idle_seconds)
            print(json.dumps({"app": str(app), "workspaces": args.workspaces, "coldReadyMs": cold["browserReadyMs"],
                              "restored": warm}), flush=True)


if __name__ == "__main__":
    main()
