#!/usr/bin/env python3
"""Bundle the about:lima UI modules into one classic script.

about:lima pages have an about: origin, and module scripts must be
same-origin or CORS-enabled, which resource:// cannot be. Sources stay as
readable ES modules; this concatenates them in dependency order inside one
IIFE, dropping import lines and `export` keywords.
"""
import re
import sys
from pathlib import Path

ORDER = ["lib.js", "notes.js", "terminal.js", "chat.js", "studio.js", "views.js", "app.js"]

def main(src: Path, out: Path) -> None:
    parts = []
    names = {}
    for name in ORDER:
        text = (src / name).read_text()
        text = re.sub(r'^import\s+\{[^}]*\}\s+from\s+"[^"]+";\s*$', "", text, flags=re.M)
        if re.search(r"^\s*import\b|\bimport\(", text, flags=re.M):
            sys.exit(f"{name}: unsupported import form")
        for match in re.finditer(r"^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)", text, flags=re.M):
            if match.group(1) in names:
                sys.exit(f"duplicate export {match.group(1)} in {name} and {names[match.group(1)]}")
            names[match.group(1)] = name
        text = re.sub(r"^export\s+", "", text, flags=re.M)
        parts.append(f"// ---- {name}\n{text}")
    out.write_text('"use strict";\n(() => {\n' + "\n".join(parts) + "\n})();\n")

if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
