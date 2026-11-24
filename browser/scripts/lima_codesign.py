#!/usr/bin/env python3
"""Sign and verify Lima.app with the hardened runtime.

    lima_codesign.py capture <Zen.app> <entitlements.json>
    lima_codesign.py sign    <Lima.app> <entitlements.json> --identity ID [--keychain PATH] [--secure-timestamp]
    lima_codesign.py verify  <Lima.app> <entitlements.json> [--certificate-sha256 HEX]

`capture` records the entitlements of every Mach-O in the pinned, notarized
Zen release, so a Zen bump carries Zen's own entitlement changes forward
instead of relying on a hand-kept copy. `sign` applies Lima's policy on top
and signs innermost code first (never `--deep`, which gives every binary the
same entitlements). `verify` re-derives the policy and checks every binary.
"""

import argparse
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile

# Entitlements only Zen's Apple-issued provisioning profile can grant.
RESTRICTED_PREFIXES = ("com.apple.application-identifier", "com.apple.developer.", "keychain-access-groups")
# Never shipped: these let other processes inject into or debug Lima.
FORBIDDEN = (
    "com.apple.security.get-task-allow",
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.disable-executable-page-protection",
)
DISABLE_LIBRARY_VALIDATION = "com.apple.security.cs.disable-library-validation"

# Lima's own executables (relative to Lima.app).
LIMA_ENTITLEMENTS = {
    "Contents/MacOS/lima": {},
    "Contents/MacOS/lima-host": {
        "com.apple.security.device.audio-input": True,          # dictation
        "com.apple.security.automation.apple-events": True,     # music controls
        "com.apple.security.personal-information.calendars": True,  # meetings, reminders
    },
    "Contents/Resources/Whisper/runtime/whisper-cli": {},
}
# The engine is the responsible process for permission prompts raised by its children.
ENGINE_EXTRAS = {
    "com.apple.security.automation.apple-events": True,
    "com.apple.security.personal-information.calendars": True,
}

ENGINE_PATHS = ("Contents/MacOS/zen", "Contents/MacOS/lima")

# Zen code Lima does not ship: its updater and privileged install helpers.
REMOVED = (
    "Contents/MacOS/updater.app",
    "Contents/Library/LaunchServices",
)


def run(*args, check=True, capture=True):
    result = subprocess.run(args, check=False, capture_output=capture, text=True)
    if check and result.returncode != 0:
        sys.exit(f"error: {' '.join(args)}\n{result.stderr.strip()}")
    return result


def is_macho(path):
    if os.path.islink(path) or not os.path.isfile(path):
        return False
    with open(path, "rb") as handle:
        magic = handle.read(4)
    return magic in (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca")


def is_executable_image(path):
    """True for MH_EXECUTE images; dylibs and bundles carry no entitlements."""
    import struct

    with open(path, "rb") as handle:
        header = handle.read(8)
        offset = 0
        if header[:4] == b"\xca\xfe\xba\xbe":  # fat: use the first slice
            handle.seek(8 + 8)
            offset = struct.unpack(">I", handle.read(4))[0]
        handle.seek(offset + 12)
        return struct.unpack("<I", handle.read(4))[0] == 2


def walk_machos(root):
    for directory, subdirectories, files in os.walk(root):
        subdirectories.sort()
        for name in sorted(files):
            path = os.path.join(directory, name)
            if is_macho(path):
                yield os.path.relpath(path, root)


def nested_bundles(root):
    found = []
    for directory, subdirectories, _ in os.walk(root):
        for name in subdirectories:
            if name.endswith((".app", ".framework", ".bundle", ".appex", ".xpc")):
                found.append(os.path.relpath(os.path.join(directory, name), root))
    return sorted(found, key=lambda path: (-path.count(os.sep), path))


def bundle_executable(root, bundle):
    info = os.path.join(root, bundle, "Contents", "Info.plist")
    if not os.path.exists(info):
        info = os.path.join(root, bundle, "Resources", "Info.plist")  # frameworks
    if not os.path.exists(info):
        return None
    with open(info, "rb") as handle:
        name = plistlib.load(handle).get("CFBundleExecutable")
    if not name:
        return None
    for candidate in (os.path.join(bundle, "Contents", "MacOS", name), os.path.join(bundle, name)):
        if os.path.exists(os.path.join(root, candidate)):
            return os.path.normpath(candidate)
    return None


def entitlements_of(path):
    result = run("codesign", "-d", "--entitlements", "-", "--xml", path, check=False)
    data = result.stdout.encode()
    start = data.find(b"<?xml")
    if result.returncode != 0 or start < 0:
        return {}
    return plistlib.loads(data[start:])


def policy(relative, upstream, executable, compiled=False):
    """The entitlements Lima ships for one binary.

    `compiled` marks a binary that came from the engine bundle. In a source
    build the Gecko executable itself is Contents/MacOS/lima; in a repack it
    is Contents/MacOS/zen and Contents/MacOS/lima is Lima's launcher.
    """
    if relative in LIMA_ENTITLEMENTS and not (compiled and relative in ENGINE_PATHS):
        return dict(LIMA_ENTITLEMENTS[relative])
    granted = {key: value for key, value in upstream.items()
               if not key.startswith(RESTRICTED_PREFIXES) and key not in FORBIDDEN}
    if executable:
        # Self-signed code has no Team ID, so library validation could never
        # match XUL and the other bundled libraries. They are sealed by the
        # app signature instead; DYLD_* injection stays blocked by the runtime.
        granted[DISABLE_LIBRARY_VALIDATION] = True
    if relative in ENGINE_PATHS:
        granted.update(ENGINE_EXTRAS)
    return granted


def capture(zen_app, output):
    records = {}
    for relative in walk_machos(zen_app):
        path = os.path.join(zen_app, relative)
        executable = is_executable_image(path)
        records[relative] = {"executable": executable, "entitlements": entitlements_of(path)}
    with open(output, "w") as handle:
        json.dump({"schemaVersion": 1, "binaries": records}, handle, indent=2, sort_keys=True, default=bool)
    print(f"captured entitlements for {len(records)} Zen binaries")


def load_capture(path):
    with open(path) as handle:
        data = json.load(handle)
    if data.get("schemaVersion") != 1:
        sys.exit("error: unsupported entitlement capture")
    return data["binaries"]


def expected(app, captured):
    """relative path → entitlements, for every Mach-O now in Lima.app."""
    plan = {}
    for relative in walk_machos(app):
        record = captured.get(relative)
        if record is None and relative not in LIMA_ENTITLEMENTS:
            sys.exit(f"error: {relative} is neither from Zen nor a known Lima binary; add it to LIMA_ENTITLEMENTS")
        upstream = record["entitlements"] if record else {}
        executable = record["executable"] if record else is_executable_image(os.path.join(app, relative))
        plan[relative] = policy(relative, upstream, executable, compiled=record is not None)
    return plan


def codesign(path, identity, keychain, entitlements, secure_timestamp=False):
    # Notarization needs Apple's secure timestamp; self-signed builds skip it.
    timestamp = "--timestamp" if secure_timestamp else "--timestamp=none"
    args = ["codesign", "--force", timestamp, "--options", "runtime", "--sign", identity]
    if keychain:
        args += ["--keychain", keychain]
    with tempfile.NamedTemporaryFile(suffix=".plist") as handle:
        if entitlements:
            handle.write(plistlib.dumps(entitlements))
            handle.flush()
            args += ["--entitlements", handle.name]
        run(*args, path)


def sign(app, capture_path, identity, keychain, secure_timestamp=False):
    import shutil

    for relative in REMOVED:
        target = os.path.join(app, relative)
        if os.path.lexists(target):
            shutil.rmtree(target) if os.path.isdir(target) else os.remove(target)
    run("xattr", "-cr", app)
    captured = load_capture(capture_path)
    plan = expected(app, captured)
    bundles = nested_bundles(app)
    main_executables = {bundle_executable(app, bundle) for bundle in bundles}

    # 1. Loose code, deepest first.
    loose = [path for path in plan if path not in main_executables and path != bundle_executable(app, ".")]
    for relative in sorted(loose, key=lambda path: (-path.count(os.sep), path)):
        codesign(os.path.join(app, relative), identity, keychain, plan[relative], secure_timestamp)
    # 2. Nested bundles, deepest first, with their main executable's entitlements.
    for bundle in bundles:
        executable = bundle_executable(app, bundle)
        codesign(os.path.join(app, bundle), identity, keychain, plan.get(executable, {}), secure_timestamp)
    # 3. The app itself (its main executable is the Lima launcher).
    codesign(app, identity, keychain, plan.get(bundle_executable(app, "."), {}), secure_timestamp)
    print(f"signed {len(plan)} binaries in {len(bundles)} nested bundles with {identity if identity != '-' else 'an ad-hoc signature'}")


def leaf_sha256(path):
    with tempfile.TemporaryDirectory() as directory:
        prefix = os.path.join(directory, "cert")
        run("codesign", "-d", f"--extract-certificates={prefix}", path)
        leaf = prefix + "0"
        if not os.path.exists(leaf):
            return None
        with open(leaf, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()


def verify(app, capture_path, certificate):
    failures = []
    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", app)
    for relative in REMOVED:
        if os.path.lexists(os.path.join(app, relative)):
            failures.append(f"{relative} must not ship")
    plan = expected(app, load_capture(capture_path))
    for relative, wanted in plan.items():
        path = os.path.join(app, relative)
        details = run("codesign", "-dvvv", path, check=False).stderr
        flags = re.search(r"flags=0x[0-9a-f]+\(([^)]*)\)", details)
        if not flags or "runtime" not in flags.group(1).split(","):
            failures.append(f"{relative}: hardened runtime is off")
        actual = entitlements_of(path)
        if actual != wanted:
            failures.append(f"{relative}: entitlements {sorted(actual)} != policy {sorted(wanted)}")
        if any(key in actual for key in FORBIDDEN) or any(key.startswith(RESTRICTED_PREFIXES) for key in actual):
            failures.append(f"{relative}: carries a forbidden entitlement")
        if certificate:
            fingerprint = leaf_sha256(path)
            if fingerprint != certificate.lower():
                failures.append(f"{relative}: signed by {fingerprint}, expected {certificate.lower()}")
    if failures:
        sys.exit("error: Lima.app failed verification:\n  " + "\n  ".join(failures))
    print(f"verified {len(plan)} binaries: hardened runtime, entitlement policy"
          + (", pinned certificate" if certificate else ""))


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    c = commands.add_parser("capture")
    c.add_argument("zen_app")
    c.add_argument("output")
    s = commands.add_parser("sign")
    s.add_argument("app")
    s.add_argument("capture")
    s.add_argument("--identity", default="-")
    s.add_argument("--keychain")
    s.add_argument("--secure-timestamp", action="store_true")
    # repack.sh passes the release policy's signing mode; Developer ID needs the secure timestamp.
    s.add_argument("--mode-developer-id", dest="secure_timestamp", action="store_true")
    s.add_argument("--mode-self-signed", action="store_true")
    v = commands.add_parser("verify")
    v.add_argument("app")
    v.add_argument("capture")
    v.add_argument("--certificate-sha256")
    args = parser.parse_args()
    if args.command == "capture":
        capture(args.zen_app, args.output)
    elif args.command == "sign":
        sign(args.app, args.capture, args.identity, args.keychain, args.secure_timestamp)
    else:
        verify(args.app, args.capture, args.certificate_sha256)


if __name__ == "__main__":
    main()
