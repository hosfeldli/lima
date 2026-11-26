#!/usr/bin/env python3
"""Prints each built policy page to site/public/legal/<slug>.pdf with Lima's
own engine (headless, over Marionette), so the PDF matches the page.

  python3 site/legal/build.py          # pages first
  python3 site/legal/print_pdfs.py     # then the PDFs (needs build/Lima.app)
  python3 site/legal/build.py          # again, to show each PDF's size
"""
import base64
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "site" / "public"
APP = ROOT / "build" / "Lima.app"
sys.path.insert(0, str(ROOT / "browser" / "scripts"))
from source_smoke import read_packet  # noqa: E402

SLUGS = ["terms", "privacy", "eula", "ai-usage", "acceptable-use", "commercial-data", "retention",
         "licenses", "security", "incident-response", "partner"]


class Pages(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    site_port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", site_port), functools.partial(Pages, directory=str(PUBLIC)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="lima-legal-", dir="/tmp") as temp:
        root = Path(temp)
        profile = root / "p"
        profile.mkdir()
        key = root / "key"
        key.write_bytes(os.urandom(32))
        key.chmod(0o600)
        port = free_port()
        (profile / "user.js").write_text("\n".join([
            f'user_pref("marionette.port", {port});', 'user_pref("lima.onboarding.done", true);',
            'user_pref("lima.welcome.finished", true);', 'user_pref("lima.welcome.created", true);',
            'user_pref("layout.css.prefers-color-scheme.content-override", 1);']) + "\n")
        env = dict(os.environ, MOZ_HEADLESS="1", LIMA_DATA_DIR=str(root / "rt"), LIMA_KEY_FILE=str(key), LIMA_WORKSPACES_ROOT=str(root / "ws"))
        log = open(root / "log", "w+b")
        proc = subprocess.Popen([APP / "Contents/MacOS/lima", "-profile", profile, "-no-remote", "-headless", "--marionette"],
                                env=env, stdout=log, stderr=log)
        try:
            for _ in range(160):
                try:
                    conn = socket.create_connection(("127.0.0.1", port), timeout=1)
                    break
                except OSError:
                    time.sleep(.25)
            conn.settimeout(120)
            stream = conn.makefile("rb")
            read_packet(stream)
            counter = [0]

            def send(method, params):
                counter[0] += 1
                data = json.dumps([0, counter[0], method, params]).encode()
                conn.sendall(str(len(data)).encode() + b":" + data)
                _, _, error, response = read_packet(stream)
                if error:
                    raise RuntimeError(error["message"])
                return response

            send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
            time.sleep(3)
            for slug in SLUGS:
                send("WebDriver:Navigate", {"url": f"http://127.0.0.1:{site_port}/legal/{slug}.html"})
                time.sleep(1.2)
                pdf = send("WebDriver:Print", {
                    "orientation": "portrait", "background": True, "shrinkToFit": True,
                    "page": {"width": 21.59, "height": 27.94},
                    "margin": {"top": 2, "bottom": 2.2, "left": 2.2, "right": 2.2},
                })["value"]
                out = PUBLIC / "legal" / f"{slug}.pdf"
                out.write_bytes(base64.b64decode(pdf))
                print(f"{slug}.pdf  {out.stat().st_size // 1024} KB")
        finally:
            proc.terminate()
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()
            server.shutdown()


if __name__ == "__main__":
    main()
