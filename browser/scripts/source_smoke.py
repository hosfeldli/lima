#!/usr/bin/env python3
"""Exercise a built Lima.app and its runtime through an isolated macOS profile.

A source build must also carry no Zen executable or identifier. A repack
(Contents/MacOS/zen present) skips those compiled-identity checks.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time


def read_packet(stream):
    prefix = bytearray()
    while byte := stream.read(1):
        if byte == b":":
            return json.loads(stream.read(int(prefix)))
        prefix.extend(byte)
    raise EOFError("Marionette closed its connection")


def chrome(socket_handle, script):
    stream = socket_handle.makefile("rb")
    read_packet(stream)
    methods = [
        ("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}}),
        ("Marionette:SetContext", {"value": "chrome"}),
        ("WebDriver:ExecuteAsyncScript", {"script": script, "args": [], "newSandbox": True, "sandbox": "system"}),
    ]
    for request, (method, params) in enumerate(methods, 1):
        data = json.dumps([0, request, method, params]).encode()
        socket_handle.sendall(str(len(data)).encode() + b":" + data)
        _, _, error, response = read_packet(stream)
        if error:
            raise RuntimeError(error["message"])
    return response["value"]


CHECK = """
const done = arguments[arguments.length - 1];
const compiled = COMPILED;
(async () => {
  for (let attempt = 0; attempt < 120 && !document.getElementById("lima-assistant-toggle"); attempt++) {
    await new Promise(resolve => window.setTimeout(resolve, 250));
  }
  const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
  const hello = await LimaBridge.request("host.hello");
  const note = await LimaBridge.request("notes.create", { title: "Source smoke", markdown: "Verified" });
  const persisted = await LimaBridge.request("notes.get", { id: note.id });
  const { SessionStore } = ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs");
  await SessionStore.promiseInitialized;
  await gZenStartup.promiseInitialized;
  const checks = {
    branding: Services.appinfo.name === "Lima" && Services.appinfo.vendor === "Lima",
    profileIdentity: !compiled || (AppConstants.MOZ_APP_NAME === "lima" && AppConstants.MOZ_MACBUNDLE_ID === "dev.lima.browser"),
    noZenServices: !Services.prefs.getStringPref("zen.share.base-url", "") && !/zen-browser\\.app/.test(Services.prefs.getStringPref("zen.injections.match-urls", "")),
    brandStrings: (await new Localization(["branding/brand.ftl", "browser/aboutDialog.ftl"]).formatValue("update-noUpdatesFound")) === "Lima is up to date",
    noZenStrings: !/\bZen\b/.test(await new Localization(["browser/zen-general.ftl"]).formatValue("zen-window-sync-migration-dialog-message")),
    noAutoConfig: !compiled || !Services.prefs.getStringPref("general.config.filename", ""),
    noZenWelcome: Services.prefs.prefIsLocked("zen.welcome-screen.always-show") &&
      !Services.prefs.getBoolPref("zen.welcome-screen.always-show"),
    companion: !!document.getElementById("lima-assistant-toggle"),
    runtime: typeof hello.hostVersion === "string" && hello.pid > 1,
    note: persisted.markdown === "Verified"
  };
  await LimaBridge.request("host.shutdown");
  return checks;
})().then(done, error => done({error: String(error)}));
"""


def check_bundle(app):
    """The packaged bundle carries no Zen executable, helper or identifier."""
    import plistlib
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    problems = []
    if info.get("CFBundleIdentifier") != "dev.lima.browser" or info.get("CFBundleExecutable") != "lima":
        problems.append("Info.plist identity")
    for path in app.rglob("*"):
        if "zen" in path.name.lower() and path.suffix in ("", ".app", ".dylib"):
            problems.append(str(path.relative_to(app)))
    if problems:
        raise RuntimeError("Zen identity remains in the bundle: " + ", ".join(problems[:20]))


def main(app):
    compiled = not (app / "Contents/MacOS/zen").exists()
    if compiled:
        check_bundle(app)
    with tempfile.TemporaryDirectory(prefix="lima-source-qa-", dir="/tmp") as temp:
        root = Path(temp)
        profile = root / "profile"
        profile.mkdir()
        key = root / "key"
        key.write_bytes(os.urandom(32))
        key.chmod(0o600)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        (profile / "user.js").write_text(f'user_pref("marionette.port", {port});\n')
        environment = dict(os.environ, MOZ_HEADLESS="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1",
                           LIMA_DATA_DIR=str(root / "runtime"), LIMA_KEY_FILE=str(key),
                           LIMA_WORKSPACES_ROOT=str(root / "workspaces"))
        with (root / "browser.log").open("w+b") as log:
            process = subprocess.Popen([app / "Contents/MacOS/lima", "-profile", profile, "-no-remote",
                                        "-headless", "--marionette"], env=environment, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        raise RuntimeError("Lima exited before the smoke test")
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                        break
                    except OSError:
                        time.sleep(.25)
                else:
                    raise RuntimeError("Marionette did not start")
                with connection:
                    connection.settimeout(45)
                    result = chrome(connection, CHECK.replace("COMPILED", "true" if compiled else "false"))
                print(json.dumps(result, indent=2))
                if not result or not all(value is True for value in result.values()):
                    raise RuntimeError("Compiled browser smoke check failed")
            except Exception:
                log.seek(0)
                sys.stderr.write(log.read().decode(errors="replace")[-8000:])
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
