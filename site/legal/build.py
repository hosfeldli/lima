#!/usr/bin/env python3
"""Builds Lima's legal center from the Markdown sources in this folder.

  site/legal/<slug>.md  ->  site/public/legal/<slug>.html  (one page per policy)
                            site/public/legal.html          (the index, /legal)

PDFs (site/public/legal/<slug>.pdf) are printed from these pages by
print_pdfs.py, so the download matches the page. Run both after editing a
policy. Only a small Markdown subset is understood: ## headings, paragraphs,
- and 1. lists, pipe tables, **bold**, and [label](url) links.
"""
import html
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "public"
EFFECTIVE = "November 26, 2026"
CONTACT = "lima.issues@gmail.com"
# Reading order on the index: the ones most people need first.
ORDER = ["terms", "privacy", "eula", "ai-usage", "acceptable-use", "commercial-data", "retention",
         "licenses", "security", "incident-response", "partner"]
GROUPS = [("For everyone using Lima", ["terms", "privacy", "eula", "ai-usage", "acceptable-use"]),
          ("Data and money", ["commercial-data", "retention"]),
          ("Open source and security", ["licenses", "security", "incident-response"]),
          ("For partners", ["partner"])]


def inline(text):
    out = html.escape(text, quote=False)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', out)
    # Bare emails and the project's own addresses become links.
    out = re.sub(r"\b([\w.+-]+@[\w-]+\.[\w.]+)\b", r'<a href="mailto:\1">\1</a>', out)
    out = re.sub(r"(?<![/\w])(github\.com/hosfeldli/lima)\b", r'<a href="https://\1">\1</a>', out)
    out = re.sub(r"(?<![/\w])(mozilla\.org/MPL/2\.0)\b", r'<a href="https://www.\1/">\1</a>', out)
    return out


def render(markdown):
    lines = markdown.strip().split("\n")
    parts, i = [], 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith("## "):
            title = line[3:].strip()
            anchor = re.sub(r"[^a-z0-9]+", "-", re.sub(r"^\d+\.\s*", "", title.lower())).strip("-")
            parts.append(f'<h2 id="{anchor}">{inline(title)}</h2>')
            i += 1
        elif line.startswith("| "):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([cell.strip() for cell in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], [row for row in rows[1:] if not all(set(cell) <= set("-: ") for cell in row)]
            parts.append('<div class="table"><table><thead><tr>' + "".join(f"<th>{inline(c)}</th>" for c in head) +
                         "</tr></thead><tbody>" + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>" for row in body) +
                         "</tbody></table></div>")
        elif re.match(r"^(- |\d+\. )", line):
            ordered = bool(re.match(r"^\d+\. ", line))
            items = []
            while i < len(lines) and re.match(r"^(- |\d+\. )", lines[i]):
                items.append(re.sub(r"^(- |\d+\. )", "", lines[i]))
                i += 1
            tag = "ol" if ordered else "ul"
            parts.append(f"<{tag}>" + "".join(f"<li>{inline(item)}</li>" for item in items) + f"</{tag}>")
        else:
            para = []
            while i < len(lines) and lines[i].strip() and not re.match(r"^(## |\| |- |\d+\. )", lines[i]):
                para.append(lines[i].strip())
                i += 1
            parts.append(f"<p>{inline(' '.join(para))}</p>")
    return "\n".join(parts)


def load(slug):
    text = (HERE / f"{slug}.md").read_text()
    front, body = text.split("---", 2)[1:]
    meta = dict(line.split(": ", 1) for line in front.strip().split("\n"))
    return meta, body


HEAD = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} · Lima</title>
  <meta name="description" content="{description}">
  <link rel="canonical" href="https://lima.liamhosfeld.com{path}">
  <link rel="icon" href="/lima.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/legal.css">
</head>
<body class="legal">
  <header class="legal-head">
    <a class="brand" href="/" aria-label="Lima home"><img src="/lima.svg" alt="" width="26" height="26"><span>Lima</span></a>
    <nav class="legal-crumbs" aria-label="Breadcrumb">{crumbs}</nav>
    <a class="button primary legal-download" href="/download">Download for macOS</a>
  </header>
"""
FOOT = """  <footer class="legal-foot">
    <p>Published by Liam Hosfeld · <a href="mailto:{contact}">{contact}</a> · Effective {effective}</p>
    <p><a href="/">Lima</a> · <a href="/legal">Legal</a> · <a href="https://github.com/hosfeldli/lima">Source on GitHub</a></p>
  </footer>
</body>
</html>
"""


def page(slug, meta, body):
    toc = [(m.group(1), re.sub(r"<[^>]+>", "", m.group(2))) for m in re.finditer(r'<h2 id="([^"]+)">(.+?)</h2>', body)]
    nav = ""
    if len(toc) > 3:
        nav = '<nav class="legal-toc" aria-label="On this page"><p>On this page</p><ol>' + \
              "".join(f'<li><a href="#{a}">{t}</a></li>' for a, t in toc) + "</ol></nav>"
    return HEAD.format(title=html.escape(meta["title"]), description=html.escape(meta["summary"]), path=f"/legal/{slug}",
                       crumbs=f'<a href="/legal">Legal</a><span aria-hidden="true">/</span><span>{html.escape(meta["title"])}</span>') + f"""  <main class="legal-doc">
    <div class="legal-doc-head">
      <h1>{html.escape(meta["title"])}</h1>
      <p class="legal-meta">Effective {EFFECTIVE} · Liam Hosfeld</p>
      <p class="legal-summary">{html.escape(meta["summary"])}</p>
      <a class="button ghost legal-pdf" href="/legal/{slug}.pdf" download>Download PDF</a>
    </div>
    <div class="legal-layout">
      {nav}
      <article class="legal-body">
{body}
      </article>
    </div>
  </main>
""" + FOOT.format(contact=CONTACT, effective=EFFECTIVE)


NOTICES = [
    ("AI can make mistakes.", "Agents and answers can be wrong or out of date. Check important details before you rely on them."),
    ("You approve what agents do.", "Purchases, messages, account changes and commands you approve are your decisions and your responsibility."),
    ("No tracking.", "Lima collects no usage statistics, analytics or telemetry. Your notes, chats and browsing stay on your Mac."),
    ("Google is the default search engine.", "For new installs. Change it in Settings → Search; Lima never changes your choice."),
    ("Other services have their own terms.", "Your AI provider, search engine, Google and websites follow their own terms and privacy policies."),
    ("Not affiliated.", "Lima isn't affiliated with or endorsed by Mozilla, Zen, Anthropic, OpenAI, Spotify, Apple or Google."),
]


def index(docs):
    groups = []
    for title, slugs in GROUPS:
        rows = "".join(f"""
        <li class="legal-row">
          <a class="legal-row-main" href="/legal/{slug}">
            <span class="legal-row-title">{html.escape(docs[slug]["title"])}</span>
            <span class="legal-row-summary">{html.escape(docs[slug]["summary"])}</span>
          </a>
          <a class="legal-row-pdf" href="/legal/{slug}.pdf" download aria-label="Download {html.escape(docs[slug]["title"])} as PDF">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4.5 15.5h11"/></svg>PDF<span class="legal-row-size">{docs[slug]["size"]}</span>
          </a>
        </li>""" for slug in slugs)
        groups.append(f'<section class="legal-group" aria-labelledby="g-{slugs[0]}"><h2 id="g-{slugs[0]}">{title}</h2><ul class="legal-list">{rows}\n        </ul></section>')
    notices = "".join(f"<li><strong>{html.escape(t)}</strong> {html.escape(d)}</li>" for t, d in NOTICES)
    return HEAD.format(title="Legal", description="Lima's Terms, Privacy Policy, license, AI and data policies, as pages and PDFs.",
                       path="/legal", crumbs="<span>Legal</span>") + f"""  <main class="legal-index">
    <div class="legal-hero">
      <h1>Legal</h1>
      <p class="legal-lede">Lima's policies, in plain language. Read them here or download each as a PDF. Effective {EFFECTIVE}.</p>
    </div>
    <section class="legal-notices" aria-labelledby="notices-title">
      <h2 id="notices-title">The short version</h2>
      <ul>{notices}</ul>
    </section>
    {"".join(groups)}
    <p class="legal-contact">Questions or requests about these policies: <a href="mailto:{CONTACT}">{CONTACT}</a>.</p>
  </main>
""" + FOOT.format(contact=CONTACT, effective=EFFECTIVE)


def main():
    (OUT / "legal").mkdir(exist_ok=True)
    docs = {}
    for slug in ORDER:
        meta, body = load(slug)
        (OUT / "legal" / f"{slug}.html").write_text(page(slug, meta, render(body)))
        pdf = OUT / "legal" / f"{slug}.pdf"
        meta["size"] = f"{max(1, round(pdf.stat().st_size / 1024))} KB" if pdf.exists() else ""
        docs[slug] = meta
    (OUT / "legal.html").write_text(index(docs))
    print(f"built {len(docs)} policies and the index")


if __name__ == "__main__":
    main()
