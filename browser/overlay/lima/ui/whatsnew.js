import { bridge, el, errorText, markdown, setPage } from "./lib.js";
import { companion } from "./companion.js";
import { react } from "./mascot.js";
import { releaseSections, sectionArt, TOPICS } from "./whatsnew-art.sys.mjs";

/* What's New: opens once after an update. Each change in the release (from
 * its commit messages) gets a card with an illustration drawn for it, and
 * the page's Pip celebrates. */
export async function renderWhatsNew(app) {
  setPage("What’s New", "spark");
  document.body.classList.add("whats-new-page");
  // Lima's own theme, which may differ from the Mac's appearance.
  const dark = () => document.documentElement.getAttribute("lima-theme") === "dark";
  let data;
  try { data = await bridge.browser("whatsNew", {}); }
  catch (error) { app.replaceChildren(el("main", { class: "whats-new" }, el("p", { class: "muted", text: errorText(error) }))); return; }
  const version = data?.version ?? "";
  const sections = releaseSections(data?.notes ?? "");
  const pip = companion("chat-avatar", `whats-new-${version}`);
  const confetti = el("div", { class: "whats-new-confetti", "aria-hidden": "true" },
    Array.from({ length: 18 }, (_, index) => el("i", { style: `--i:${index}; --x:${(index * 37) % 100}%; --h:${(index * 47) % 360}` })));
  const art = svg => {
    const node = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
    return document.importNode(node, true);
  };
  const cards = sections.map((section, index) => {
    const { topic, svg } = sectionArt(section.title, section.topic, dark());
    const card = el("article", { class: "whats-new-card", style: `--delay:${Math.min(index, 8) * 70}ms`, "data-topic": topic },
      el("div", { class: "whats-new-art" }, art(svg), (() => { const mini = companion("status", `${version}-${section.title}`); mini.classList.add("whats-new-mini"); return mini; })()),
      el("div", { class: "whats-new-copy" },
        el("span", { class: "whats-new-topic", text: TOPICS[topic]?.label ?? "New" }),
        el("h2", { text: section.title }),
        section.body.length ? markdown(section.body.map(line => (/^[-*]\s/.test(line) ? line : `- ${line}`)).join("\n")) : null));
    return card;
  });
  const main = el("main", { class: "whats-new" },
    el("header", { class: "whats-new-hero" }, confetti, pip,
      el("div", {},
        el("p", { class: "whats-new-kicker", text: version ? `Lima ${version}` : "Lima" }),
        el("h1", { text: "What’s new" }),
        el("p", { class: "whats-new-lede", text: sections.length
          ? `${sections.length} change${sections.length === 1 ? "" : "s"} in this update. Here’s what they mean for you.`
          : "This update brings small improvements and fixes." }))),
    el("section", { class: "whats-new-grid", "aria-label": "Changes in this update" }, cards),
    el("footer", { class: "whats-new-foot" },
      el("p", { class: "muted", text: "These notes are written from the changes that went into this release. Lima checks for updates on its own; you can see them in Settings → Updates." }),
      el("div", { class: "row" },
        el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=updates") }, "Update settings"),
        el("button", { class: "primary", onclick: () => bridge.browser("closeWhatsNew", {}).catch(() => window.close()) }, "Got it"))));
  app.replaceChildren(main);
  setTimeout(() => react(pip, "complete"), 450);
}
