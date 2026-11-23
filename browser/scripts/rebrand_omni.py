#!/usr/bin/env python3
"""Rebrand the omni.ja archives of a repacked Zen engine as Lima.

Zen compiles its name into Fluent strings, branding images, About links and
default prefs that ship inside Contents/Resources{,/browser}/omni.ja. This
rewrites those entries in place. Gecko reads a standard zip, and the repack
writes a new BuildID, so the startup cache never serves the old entries.

Only brand.ftl is required. Every other edit warns when its anchor is gone, so
a Zen layout change never blocks a security update. The repack prints warnings,
and CI copies them into the job summary.
"""
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from prepare_source import (  # noqa: E402
    BROWSER, LIMA_MIGRATION_START, LIMA_REPO, LIMA_SITE, MIGRATION_START, WORDMARK,
    rebrand_text, render_svg,
)

ICON = BROWSER / "branding/lima-app-icon.svg"
BRANDING = "chrome/browser/content/branding"

# (archive member, old, new). Lima owns onboarding and updates, and Zen's
# share server and page injections would trust Zen's servers inside Lima.
EDITS = [
    ("moz-src/browser/components/migration/MigrationUtils.sys.mjs", MIGRATION_START, LIMA_MIGRATION_START),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/whatsnew?v=%VERSION%"', '""'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/welcome/"', '""'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/privacy-policy/"', '""'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/download/"', f'"{LIMA_SITE}"'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/release-notes/latest/"', f'"{LIMA_REPO}/releases"'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/whatsnew/"', f'"{LIMA_REPO}/releases"'),
    ("defaults/preferences/firefox-branding.js", '"https://www.zen-browser.app/release-notes/%VERSION%/"', f'"{LIMA_REPO}/releases"'),
    ("defaults/preferences/firefox-branding.js", '"https://zen-browser.app/release-notes/%VERSION%/"', f'"{LIMA_REPO}/releases"'),
    ("defaults/preferences/firefox.js", 'pref("zen.injections.match-urls", "https://zen-browser.app/*", locked);',
     # Zen parses this as a match pattern, so it needs a valid one that can
     # never match (.invalid is reserved and never resolves).
     'pref("zen.injections.match-urls", "https://zen-injections.invalid/*", locked);'),
    ("defaults/preferences/firefox.js", 'pref("zen.share.base-url", "https://share.zen-browser.app");',
     'pref("zen.share.base-url", "");'),
    ("chrome/browser/content/browser/zen-components/windows/zen-about.xhtml",
     '<html:a id="zen-about-donate" href="https://www.zen-browser.app/donate" data-l10n-id="zen-about-donate"/>', ""),
    ("chrome/browser/content/browser/zen-components/windows/zen-about.xhtml",
     '<html:a href="https://www.zen-browser.app/privacy-policy/" data-l10n-id="zen-about-privacy"/>', ""),
    ("chrome/browser/content/browser/zen-components/windows/zen-about.xhtml",
     'href="https://github.com/zen-browser/desktop/issues"', f'href="{LIMA_REPO}/issues"'),
    ("chrome/browser/content/browser/zen-components/windows/zen-about.xhtml",
     'href="https://github.com/zen-browser/desktop"', f'href="{LIMA_REPO}"'),
    ("chrome/browser/content/browser/ZenUpdates.mjs", '"https://www.zen-browser.app/donate"', f'"{LIMA_SITE}"'),
]


def warn(message):
    print(f"    warning: {message}", file=sys.stderr)


def extract(archive, directory):
    # Zen ships optimized jars (index first). unzip reads them and exits 1 or 2
    # for that layout, so compare the extracted count with the listing.
    names = subprocess.run(["unzip", "-Z1", str(archive)], capture_output=True, text=True).stdout.split()
    result = subprocess.run(["unzip", "-qo", str(archive), "-d", str(directory)], capture_output=True, text=True)
    if result.returncode > 2:
        sys.exit(f"error: cannot extract {archive}: {result.stderr.strip()}")
    files = [name for name in names if not name.endswith("/")]
    missing = [name for name in files if not (directory / name).exists()]
    if not files or missing:
        sys.exit(f"error: {archive} extracted incompletely ({len(missing)} entries missing)")


def rebrand_tree(root):
    changed = 0
    for path in [*root.glob("localization/**/*.ftl"), *root.glob("chrome/*/locale/**/*.properties")]:
        text = path.read_text(encoding="utf-8")
        if (new := rebrand_text(text)) != text:
            path.write_text(new, encoding="utf-8")
            changed += 1
    for member, old, new in EDITS:
        path = root / member
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if old in text:
            path.write_text(text.replace(old, new), encoding="utf-8")
        elif not (new and new in text):

            warn(f"{member}: Zen anchor not found: {old[:70]}")
    branding = root / BRANDING
    if branding.is_dir():
        for image in branding.glob("*.png"):
            width = subprocess.check_output(["sips", "-g", "pixelWidth", str(image)], text=True)
            render_svg(ICON, image, int(re.search(r"pixelWidth: (\d+)", width)[1]))
        for name in ("about-logo.svg", "about-logo-private.svg"):
            if (branding / name).exists():
                (branding / name).write_text(ICON.read_text())
        for name in ("about-wordmark.svg", "firefox-wordmark.svg"):
            if (branding / name).exists():
                (branding / name).write_text(WORDMARK)
    return changed


def repack(archive):
    with tempfile.TemporaryDirectory(prefix="lima-omni-") as temp:
        root = Path(temp) / "tree"
        root.mkdir()
        extract(archive, root)
        changed = rebrand_tree(root)
        output = Path(temp) / "omni.ja"
        # Stored, like Zen's jars: Gecko maps entries without inflating them.
        subprocess.run(["zip", "-qrX0", str(output), "."], cwd=root, check=True)
        output.replace(archive)
        return changed


def verify(resources):
    brand = subprocess.run(["unzip", "-p", str(resources / "browser/omni.ja"), "localization/en-US/branding/brand.ftl"],
                           capture_output=True, text=True).stdout
    if "-brand-short-name = Lima" not in brand or re.search(r"^[^#]*\bZen\b", brand, re.M):
        sys.exit("error: brand.ftl still names Zen after rebranding")


def main(app):
    resources = app / "Contents/Resources"
    total = sum(repack(archive) for archive in (resources / "omni.ja", resources / "browser/omni.ja"))
    verify(resources)
    print(f"    rebranded {total} localization files and the Lima branding assets")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
