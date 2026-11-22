#!/usr/bin/env python3
"""Reject source candidates that disagree with the lock or package mode."""
import json
from pathlib import Path
import re
import sys
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[2]


def verify(app, manifest, release):
    lock = json.loads((ROOT / "browser/lima.lock.json").read_text())["zen"]
    expected = dict(zenCommit=lock["commit"], gecko=lock["firefoxVersion"],
                    sourceSha512=lock["firefoxSourceSha512"], hardened=release)
    if json.loads(manifest.read_text()) != expected:
        raise ValueError("Source build manifest does not match the lock and packaging mode.")
    resources = app / "Contents/Resources"
    if not (app / "Contents/MacOS/lima").is_file():
        raise ValueError("Compiled Gecko executable is missing.")
    if (app / "Contents/MacOS/zen").exists():
        raise ValueError("Compiled engine still carries Zen's executable name.")
    archives = (resources / "omni.ja", resources / "browser/omni.ja")
    marker = re.compile(r"lockPref\(\"lima\.release\.hardened\",\s*true\)")
    for archive in archives:
        with ZipFile(archive) as browser:
            for name in browser.namelist():
                if name.endswith("/LimaSourceBootstrap.sys.mjs"):
                    source = browser.read(name).decode("utf-8")
                    if bool(marker.search(source)) != release:
                        raise ValueError("Compiled bootstrap has the wrong hardening mode.")
                    return
    raise ValueError("Compiled Lima bootstrap is missing from the application.")


if __name__ == "__main__":
    try:
        verify(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "1")
    except (OSError, ValueError) as error:
        sys.exit(f"error: {error}")
