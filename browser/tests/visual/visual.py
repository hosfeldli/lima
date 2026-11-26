#!/usr/bin/env python3
"""Screenshot checks for Lima's own screens, in light and dark.

  python3 browser/tests/visual/visual.py build/Lima.app            # compare with the saved images
  python3 browser/tests/visual/visual.py build/Lima.app --update   # save new images after a deliberate change

Each scene sets up fixture content in a fresh headless profile, hides what
changes from run to run (Pip's seeded looks, dates, animation), and captures
the window. A scene fails when more than 0.4% of its pixels differ noticeably
from browser/tests/visual/golden/<scene>-<theme>.png; the differences are
written to build/visual-diff/ in red. Run it before a release (see
docs/RELEASING.md). Saved images belong to one macOS version and font set, so
update them on the Mac that releases.
"""
import base64, json, os, socket, struct, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GOLDEN = Path(__file__).resolve().parent / "golden"
DIFFS = ROOT / "build" / "visual-diff"
sys.path.insert(0, str(ROOT / "browser" / "scripts"))
from source_smoke import read_packet  # noqa: E402

TOLERANCE = 0.004      # share of pixels allowed to differ
PIXEL_DELTA = 48       # summed RGB difference that counts as a change

STEADY = """
*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }
.companion, .lima-sidebar-pip, time, .page-date, .note-date, .activity-time, .whats-new-confetti, .relative-time,
[data-relative-time], .update-checked, .workspace-meta code { visibility: hidden !important; }
"""

FIXTURE = r"""
const { LimaBridge } = ChromeUtils.importESModule("resource://lima/LimaBridge.sys.mjs");
const wait = ms => new Promise(r => win.setTimeout(r, ms));
win.gZenCompactModeManager.preference = false;
const ws = await LimaBridge.request("workspace.create", { name: "Trip planning", provider: "claude" });
for (const n of ["a", "b", "c"]) await LimaBridge.request("workspace.openTab", { id: ws.id, url: `https://${n}.example/`, title: `Page ${n.toUpperCase()}` });
await LimaBridge.request("workspace.arrange", { id: ws.id, tabs: [{ url: "https://a.example/", folder: "Hotels", icon: "star", label: "Best pick" }],
  folders: [{ path: "Hotels", icon: "globe" }, { path: "Later", collapsed: true }] });
const chat = await LimaBridge.request("chat.create", { provider: "claude", companion: true });
await LimaBridge.request("chat.record", { id: chat.id, role: "assistant", text: "Done.\n\n```lima-report\n" +
  JSON.stringify({ status: "completed", summary: "Saved a shortlist of three hotels.", verification: ["Compared prices on two sites"] }) + "\n```" });
const note = await LimaBridge.request("notes.create", { title: "Brunch", markdown:
  "Plan for {{guests := 6 in 1..12}} guests, vegan {{vegan := no}}, size {{size := medium in small=0.8, medium=1, large=1.3}}.\n\n" +
  "Budget {{budget := 180}}: {{each = budget / guests as $}} each.\n\n| Item | Cost |\n| --- | --- |\n| Flour | 4.50 |\n| Berries | 12.25 |\n\n" +
  "Total {{cost_sum as $}}.\n\n- [x] Buy flour\n- [ ] Prep batter\n\nProgress {{done / tasks * 100 as %}}." });
// What's New reads this release's notes; a fixed set stands in for them here.
const original = LimaBridge.request.bind(LimaBridge);
LimaBridge.request = async (method, params) => method === "update.status"
  ? { ...(await original(method, params)), currentVersion: "5.0.99", releaseNotes:
      "## Smaller updates\n\n- Updates download only what changed\n\n## Notes scripting\n\n- Sliders, switches and choices\n\n## Fix the sidebar gap" }
  : original(method, params);
for (const folder of win.document.querySelectorAll("zen-folder[lima-workspace]")) folder.collapsed = false;
win.__visual = { ws: ws.id, chat: chat.id, note: note.id };
await wait(1500);
return JSON.stringify(win.__visual);
"""

SCENES = {
    "note": "about:lima?note={note}",
    "chat": "about:lima?chat={chat}",
    "workspace": "about:lima?workspace={ws}",
    "whats-new": "about:lima?view=whats-new",
    "notes-help": "about:lima?view=notes-help",
    "settings-data": "about:lima?view=integrations&section=data",
    "settings-help": "about:lima?view=integrations&section=help",
}


def bmp_pixels(png: Path):
    """RGB rows of a PNG, read through sips' uncompressed BMP (no Python image library needed)."""
    bmp = png.with_suffix(".bmp")
    subprocess.run(["sips", "-s", "format", "bmp", str(png), "--out", str(bmp)], check=True, capture_output=True)
    data = bmp.read_bytes()
    bmp.unlink()
    offset, = struct.unpack_from("<I", data, 10)
    width, height = struct.unpack_from("<ii", data, 18)
    bits, = struct.unpack_from("<H", data, 28)
    step = bits // 8
    stride = (width * step + 3) & ~3
    return width, abs(height), step, stride, memoryview(data)[offset:]


def compare(actual: Path, golden: Path, diff_out: Path) -> float:
    w1, h1, s1, r1, a = bmp_pixels(actual)
    w2, h2, s2, r2, b = bmp_pixels(golden)
    if (w1, h1) != (w2, h2):
        return 1.0
    changed = 0
    marks = bytearray(w1 * h1 * 3)
    for y in range(h1):
        ra, rb = a[y * r1:y * r1 + w1 * s1], b[y * r2:y * r2 + w2 * s2]
        if ra == rb:
            continue
        for x in range(w1):
            i, j = x * s1, x * s2
            if abs(ra[i] - rb[j]) + abs(ra[i + 1] - rb[j + 1]) + abs(ra[i + 2] - rb[j + 2]) > PIXEL_DELTA:
                changed += 1
                k = ((h1 - 1 - y) * w1 + x) * 3
                marks[k:k + 3] = b"\xff\x00\x00"
    share = changed / (w1 * h1)
    if share > TOLERANCE:
        diff_out.parent.mkdir(parents=True, exist_ok=True)
        ppm = diff_out.with_suffix(".ppm")
        ppm.write_bytes(b"P6 %d %d 255\n" % (w1, h1) + bytes(marks))
        subprocess.run(["sips", "-s", "format", "png", str(ppm), "--out", str(diff_out)], capture_output=True)
        ppm.unlink()
    return share


def capture(app: Path, theme: str, out: Path):
    with tempfile.TemporaryDirectory(prefix="lima-visual-", dir="/tmp") as temp:
        root = Path(temp)
        profile = root / "p"
        profile.mkdir()
        key = root / "key"
        key.write_bytes(os.urandom(32))
        key.chmod(0o600)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        (profile / "user.js").write_text("\n".join([
            f'user_pref("marionette.port", {port});', 'user_pref("lima.onboarding.done", true);',
            'user_pref("lima.welcome.finished", true);', 'user_pref("ui.prefersReducedMotion", 1);',
            f'user_pref("lima.theme", "{theme}");', 'user_pref("lima.personality", "off");']) + "\n")
        env = dict(os.environ, MOZ_HEADLESS="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1", LIMA_DATA_DIR=str(root / "rt"),
                   LIMA_KEY_FILE=str(key), LIMA_WORKSPACES_ROOT=str(root / "ws"), TZ="UTC")
        log = open(root / "log", "w+b")
        proc = subprocess.Popen([app / "Contents/MacOS/lima", "-profile", profile, "-no-remote", "-headless", "--marionette"],
                                env=env, stdout=log, stderr=log)
        try:
            for _ in range(160):
                try:
                    conn = socket.create_connection(("127.0.0.1", port), timeout=1)
                    break
                except OSError:
                    time.sleep(0.25)
            conn.settimeout(120)
            stream = conn.makefile("rb")
            read_packet(stream)
            counter = [0]

            def send(method, params):
                counter[0] += 1
                payload = json.dumps([0, counter[0], method, params]).encode()
                conn.sendall(str(len(payload)).encode() + b":" + payload)
                _, _, error, response = read_packet(stream)
                if error:
                    raise RuntimeError(error["message"])
                return response

            def chrome(script):
                return send("WebDriver:ExecuteAsyncScript", {"script": "const done=arguments[arguments.length-1];"
                    "const win=Services.wm.getMostRecentWindow('navigator:browser');(async()=>{" + script + "})()"
                    ".then(v=>done(v??null),e=>done('ERR '+e));", "args": []})["value"]

            send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
            send("Marionette:SetContext", {"value": "chrome"})
            send("WebDriver:SetWindowRect", {"width": 1280, "height": 820})
            time.sleep(6)
            ids = json.loads(chrome(FIXTURE))
            steady = json.dumps(STEADY)
            for name, template in SCENES.items():
                url = template.format(**ids)
                chrome(f"""
                  const doc = win.document;
                  doc.getElementById("lima-search-input")?.dispatchEvent(new win.KeyboardEvent("keydown", {{ key: "Escape", bubbles: true }}));
                  const tab = win.gBrowser.addTrustedTab({json.dumps(url)});
                  win.gBrowser.selectedTab = tab;
                  await new Promise(r => win.setTimeout(r, 2600));
                  doc.getElementById("lima-search-input")?.dispatchEvent(new win.KeyboardEvent("keydown", {{ key: "Escape", bubbles: true }}));
                  const style = doc.createElement("style"); style.textContent = {steady}; doc.documentElement.append(style);
                  return 1;""")
                # Lima's pages run in their own process: steady them from inside.
                send("Marionette:SetContext", {"value": "content"})
                handles = send("WebDriver:GetWindowHandles", {})
                for handle in (handles.get("value", []) if isinstance(handles, dict) else handles):
                    send("WebDriver:SwitchToWindow", {"handle": handle})
                    if send("WebDriver:GetCurrentURL", {})["value"] == url:
                        send("WebDriver:ExecuteScript", {"script": "const s=document.createElement('style');s.textContent=arguments[0];"
                             "document.head.append(s);", "args": [STEADY], "newSandbox": True})
                        break
                send("Marionette:SetContext", {"value": "chrome"})
                time.sleep(0.5)
                shot = send("WebDriver:TakeScreenshot", {"full": False})["value"]
                (out / f"{name}-{theme}.png").write_bytes(base64.b64decode(shot))
        finally:
            proc.terminate()
            try:
                proc.wait(15)
            except subprocess.TimeoutExpired:
                proc.kill()


def main():
    args = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    update = "--update" in sys.argv
    app = Path(args[0] if args else ROOT / "build" / "Lima.app").resolve()
    out = Path(tempfile.mkdtemp(prefix="lima-visual-out-"))
    for theme in ("light", "dark"):
        capture(app, theme, out)
    failures = []
    GOLDEN.mkdir(parents=True, exist_ok=True)
    for shot in sorted(out.glob("*.png")):
        golden = GOLDEN / shot.name
        if update or not golden.exists():
            golden.write_bytes(shot.read_bytes())
            print(f"saved   {shot.name}")
            continue
        share = compare(shot, golden, DIFFS / shot.name)
        status = "ok     " if share <= TOLERANCE else "CHANGED"
        print(f"{status} {shot.name}  {share * 100:.2f}% of pixels differ")
        if share > TOLERANCE:
            failures.append(shot.name)
            (DIFFS / f"actual-{shot.name}").write_bytes(shot.read_bytes())
    if failures:
        print(f"\n{len(failures)} screen(s) changed; see {DIFFS}. If the change is intended, run with --update.")
        sys.exit(1)


if __name__ == "__main__":
    main()
