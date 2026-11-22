#!/usr/bin/env python3
"""Bundle the about:lima UI modules into one classic script.

about:lima pages have an about: origin, and module scripts must be
same-origin or CORS-enabled, which resource:// cannot be. Sources stay as
readable ES modules; this concatenates them in dependency order inside one
IIFE, dropping import lines and `export` keywords.
"""
import json
import re
import sys
from pathlib import Path

ORDER = ["icons.js", "rich-content.js", "lib.js", "studio-production.js", "composer.js", "companion.js", "tool-activity.sys.mjs", "components.js", "workspace-prompts.js", "notes.js", "terminal.js", "chat.js", "assistant.js", "workspace.js", "studio.js", "views.js", "home.js", "welcome.js", "image-studio.js", "app.js"]

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#383838" '
       'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="{d}"/></svg>\n')

def main(src: Path, out: Path) -> None:
    # One icon set: a JS map for pages, and SVG files (used as masks) for the
    # rail and address bar, which live outside the page.
    icons = json.loads((src / "icons.json").read_text())
    (src / "icons.js").write_text("// Generated from icons.json by bundle_ui.py\nexport const ICONS = " + json.dumps(icons, indent=1) + ";\n")
    icon_dir = out.parent / "icons"
    icon_dir.mkdir(parents=True, exist_ok=True)
    for name, d in icons.items():
        (icon_dir / f"{name}.svg").write_text(SVG.format(d=d))
    # Each module keeps its own scope: it becomes a closure returning its
    # exports, and `import { a } from "./x.js"` becomes destructuring.
    parts = []
    for name in ORDER:
        text = (src / name).read_text()
        var = "__" + re.sub(r"\W", "_", Path(name).stem)
        def rewrite_import(match):
            names = match.group(1)
            module = "__" + re.sub(r"\W", "_", Path(match.group(2)).stem)
            return f"const {{{names}}} = {module};"
        text = re.sub(r'^import\s+\{([^}]*)\}\s+from\s+"\./([^"]+)";\s*$', rewrite_import, text, flags=re.M)
        if re.search(r"^\s*import\b|\bimport\(", text, flags=re.M):
            sys.exit(f"{name}: unsupported import form")
        exports = re.findall(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)", text, flags=re.M)
        text = re.sub(r"^export\s+", "", text, flags=re.M)
        parts.append(f"// ---- {name}\nconst {var} = (() => {{\n{text}\nreturn {{ {', '.join(exports)} }};\n}})();")
    out.write_text('"use strict";\n(() => {\n' + "\n".join(parts) + "\n})();\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
