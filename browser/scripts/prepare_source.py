#!/usr/bin/env python3
"""Apply Lima build inputs to an isolated checkout of the pinned Zen source."""
import argparse
import json
import re
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BROWSER = ROOT / "browser"
LOCK = json.loads((BROWSER / "lima.lock.json").read_text())


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected one source anchor: {old!r}")
    return text.replace(old, new, 1)


def edit(path, function):
    path.write_text(function(path.read_text()))


def render_logos(directory):
    with tempfile.TemporaryDirectory() as temp:
        png = Path(temp) / "logo.png"
        subprocess.run(["sips", "-s", "format", "png", str(BROWSER / "branding/lima-app-icon.svg"),
                        "--out", str(png)], check=True, stdout=subprocess.DEVNULL)
        for target in sorted(directory.glob("logo*.png")):
            pixels = subprocess.check_output(["sips", "-g", "pixelWidth", str(target)], text=True)
            width = re.search(r"pixelWidth: (\d+)", pixels)[1]
            subprocess.run(["sips", "-z", width, width, str(png), "--out", str(target)],
                           check=True, stdout=subprocess.DEVNULL)


LIMA_REPO = "https://github.com/hosfeldli/lima"
LIMA_SITE = "https://lima.liamhosfeld.com"
ZEN_WORD = re.compile(r"\bZen\b")

# Upstream inputs that would otherwise compile Zen's identity, links or
# services into Lima. Each anchor must still exist, so a Zen bump that moves
# one fails loudly instead of silently shipping the old value.
SOURCE_EDITS = [
    ("src/toolkit/moz-configure.patch", [
        ('+    default="Zen Team",', '+    default="Lima",'),
        ('+    default="zen",\n', '+    default="Lima Browser",\n'),
        ('+    default="app.zen-browser",', '+    default="dev.lima",'),
        ('+        return "zen"', '+        return "lima"'),
    ]),
    ("src/build/moz-build.patch", [
        ('"updates.zen-browser.app"', '"lima.liamhosfeld.com"'),
    ]),
    ("src/docshell/base/nsAboutRedirector-cpp.patch", [
        ('"https://zen-browser.app/about/"', f'"{LIMA_REPO}"'),
    ]),
    ("src/zen/about/zen-about.inc.xhtml", [
        ('href="https://github.com/zen-browser/desktop"/>', f'href="{LIMA_REPO}"/>'),
        ('          <html:a id="zen-about-donate" href="https://www.zen-browser.app/donate" data-l10n-id="zen-about-donate"/>\n', ""),
        ('href="https://github.com/zen-browser/desktop/issues"', f'href="{LIMA_REPO}/issues"'),
        ('          <html:a href="https://www.zen-browser.app/privacy-policy/" data-l10n-id="zen-about-privacy"/>\n', ""),
    ]),
    ("src/zen/settings/sidebar.inc.xhtml", [
        ('        <html:button class="zen-settings-category" data-action="open-donate">\n'
         '          <html:img src="chrome://browser/skin/zen-icons/heart.svg" alt=""/>\n'
         '          <html:span data-l10n-id="zen-settings-window-link-donate"/>\n'
         '        </html:button>\n', ""),
    ]),
    ("src/zen/settings/ZenSettingsWindow.mjs", [
        ('const kDonateURL = "https://www.zen-browser.app/donate";', f'const kDonateURL = "{LIMA_SITE}";'),
    ]),
    ("src/zen/library/ZenLibrary.mjs", [
        ('      {\n        image: "chrome://browser/skin/zen-icons/heart-circle-fill.svg",\n'
         '        l10nId: "library-footer-donate-button",\n        command: () => {\n'
         '          window.openTrustedLinkIn("https://www.zen-browser.app/donate", "tab");\n'
         '          ZenLibrary.animateProgress(0);\n        },\n      },\n', ""),
    ]),
    ("src/zen/common/modules/ZenUpdates.mjs", [
        ('"https://www.zen-browser.app/donate"', f'"{LIMA_SITE}"'),
    ]),
    ("src/browser/components/preferences/zen-settings.js", [
        ('"Export Zen Mods"', '"Export Lima Mods"'),
        ('fp.defaultString = "zen-mods-export";', 'fp.defaultString = "lima-mods-export";'),
    ]),
    # Zen's share server would receive Lima users' tabs; Lima has none.
    ("prefs/zen/share.yaml", [
        ('value: "https://share.zen-browser.app"', 'value: ""'),
    ]),
    ("prefs/zen/mods.yaml", [
        ('value: "https://zen-browser.app/*"', 'value: ""'),
    ]),
]


def substitute(checkout, relative, pairs):
    path = checkout / relative
    text = path.read_text()
    for old, new in pairs:
        if old in text:
            text = text.replace(old, new, 1)
        elif not new or new not in text:
            raise ValueError(f"{relative}: expected source anchor {old!r}")
    path.write_text(text)


def rebrand_text(text):
    """Name Lima, not Zen, in every non-comment line of a Fluent or properties file."""
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("#"):
            line = line.replace("Zen Browser", "Lima").replace("Zen OSS Team", "Lima")
            lines[index] = ZEN_WORD.sub("Lima", line)
    return "".join(lines)


def rebrand_strings(checkout):
    files = [*checkout.glob("locales/*/browser/**/*.ftl"), *checkout.glob("src/**/*.ftl")]
    for path in files:
        text = path.read_text()
        if (changed := rebrand_text(text)) != text:
            path.write_text(changed)


WORDMARK = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 56">'
            '<text x="0" y="46" fill="context-fill #fff" font-family="-apple-system, system-ui, sans-serif" '
            'font-size="50" font-weight="700">Lima</text></svg>\n')


def render_svg(source, target, width):
    subprocess.run(["sips", "-s", "format", "png", "-z", str(width), str(width), str(source),
                    "--out", str(target)], check=True, stdout=subprocess.DEVNULL)


def rebrand_assets(branding):
    icon = BROWSER / "branding/lima-app-icon.svg"
    render_logos(branding)
    content = branding / "content"
    for name in ("about-logo", "about-logo-private"):
        (content / f"{name}.svg").write_text(icon.read_text())
        render_svg(icon, content / f"{name}.png", 192)
        render_svg(icon, content / f"{name}@2x.png", 384)
    for name in ("about-wordmark.svg", "firefox-wordmark.svg"):
        (content / name).write_text(WORDMARK)
    with tempfile.TemporaryDirectory() as temp:
        iconset = Path(temp) / "lima.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            render_svg(icon, iconset / f"icon_{size}x{size}.png", size)
            render_svg(icon, iconset / f"icon_{size}x{size}@2x.png", size * 2)
        for name in ("firefox.icns", "document.icns", "document_pdf.icns"):
            if (branding / name).exists() or name == "firefox.icns":
                subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(branding / name)], check=True)


def zen(checkout):
    config_path = checkout / "surfer.json"
    config = json.loads(config_path.read_text())
    version = LOCK["zen"]["firefoxVersion"]
    if version != config["version"]["version"]:
        raise ValueError(f"Zen’s Firefox pin {config['version']['version']} differs from {version}")
    lima = LOCK["lima"]
    distribution, bundle = lima["bundleIdentifier"].rsplit(".", 1)
    # Gecko compiles CFBundleIdentifier as <distribution-id>.<appId>.
    config.update(name=lima["displayName"], vendor=lima["displayName"], appId=bundle,
                  binaryName=lima["remotingName"], updateHostname="lima.liamhosfeld.com")
    for brand in config["brands"].values():
        brand.update(brandShorterName="Lima", brandShortName="Lima", brandFullName="Lima")
        brand.get("release", {}).get("github", {})["repo"] = "hosfeldli/lima"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    substitute(checkout, "configs/common/mozconfig", [
        ("ac_add_options --with-app-basename=Zen", "ac_add_options --with-app-basename=Lima"),
        # Vendor and profile are project defaults, set in moz-configure.patch.
        ("export MOZ_APP_BASENAME=Zen\n",
         f'export MOZ_APP_BASENAME=Lima\nexport MOZ_APP_REMOTINGNAME={lima["remotingName"]}\n'),
        ("ac_add_options --with-distribution-id=app.zen-browser",
         f"ac_add_options --with-distribution-id={distribution}"),
        ("export MOZ_SOURCE_REPO=https://github.com/zen-browser/desktop", f"export MOZ_SOURCE_REPO={LIMA_REPO}"),
    ])
    for relative, pairs in SOURCE_EDITS:
        substitute(checkout, relative, pairs)
    rebrand_strings(checkout)
    rebrand_assets(checkout / "configs/branding/release")


def engine(checkout, release):
    tree = checkout / "engine"
    # Surfer writes the branding confvars at import; keep the bundle ID exact
    # even for a tree imported before the appId changed.
    bundle = LOCK["lima"]["bundleIdentifier"].rsplit(".", 1)[1]
    confvars = tree / "browser/branding/release/configure.sh"
    edit(confvars, lambda text: re.sub(r'^MOZ_MACBUNDLE_ID=".*"$', f'MOZ_MACBUNDLE_ID="{bundle}"', text, flags=re.M))
    if f'MOZ_MACBUNDLE_ID="{bundle}"' not in confvars.read_text():
        raise ValueError("The branding confvars have no MOZ_MACBUNDLE_ID.")
    components = tree / "browser/components"
    build = components / "moz.build"
    glue = components / "BrowserGlue.sys.mjs"
    marker = "LimaSourceBootstrap.sys.mjs"
    if marker not in build.read_text():
        with build.open("a") as handle:
            handle.write('\nEXTRA_JS_MODULES += ["LimaSourceBootstrap.sys.mjs"]\n')
    if marker not in glue.read_text():
        edit(glue, lambda text: replace_once(
            text, '      case "final-ui-startup":\n',
            '      case "final-ui-startup":\n'
            '        ChromeUtils.importESModule("resource:///modules/LimaSourceBootstrap.sys.mjs").startLima();\n',
        ))
    # The repack and the compiled browser share the bootstrap/prefs. Compiled
    # builds call them from BrowserGlue, with no AutoConfig pack or pref hook.
    source = (BROWSER / "overlay/lima.cfg").read_text()
    prefix = (BROWSER / "source/bootstrap-prefix.js").read_text()
    if release:
        source += (BROWSER / "source/hardened.js").read_text()
    (components / marker).write_text(prefix + source + "\n}\n")

    startup = tree / "zen/common/modules/ZenStartup.mjs"
    text = startup.read_text()
    if "Lima manages onboarding and updates." not in text:
        begin = text.index("  #checkForWelcomePage() {")
        end = text.index("  /**", begin)
        text = text[:begin] + "  #checkForWelcomePage() {\n    // Lima manages onboarding and updates.\n  }\n\n" + text[end:]
        text = replace_once(
            text,
            'import checkForZenUpdates, {\n  createWindowUpdateAnimation,\n  playWindowSweepAnimation,\n} from "chrome://browser/content/ZenUpdates.mjs";',
            'import { playWindowSweepAnimation } from "chrome://browser/content/ZenUpdates.mjs";',
        )
        startup.write_text(text)

    # Set early defaults for calls that precede BrowserGlue, including Gecko’s
    # command-line handler. The compiled bootstrap locks these on startup.
    defaults = tree / "browser/app/profile/firefox.js"
    tag = "// Lima early startup defaults"
    if tag not in defaults.read_text():
        prefs = (BROWSER / "source/early-prefs.js").read_text()
        with defaults.open("a") as handle:
            handle.write("\n" + tag + "\n" + prefs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("zen", "engine"))
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--release", action="store_true")
    args = parser.parse_args()
    if args.phase == "zen":
        zen(args.checkout)
    else:
        engine(args.checkout, args.release)


if __name__ == "__main__":
    main()
