/* Per-window Lima workspace chrome: the bottom-anchored vertical tool rail
 * (spec v2 §2.2) and the workspace side panel it opens (§2.1). */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
});

const HTML = "http://www.w3.org/1999/xhtml";

// Rail order is bottom-up. `milestone` names the internal gate (spec §14)
// that delivers the surface; only Agents is live in this build.
const TOOLS = [
  { id: "agents", label: "Agents", glyph: "◎", milestone: null },
  { id: "terminal", label: "Terminal", glyph: "›_", milestone: "3 · Universal Search and CLI overhaul" },
  { id: "chat", label: "AI Chat", glyph: "✦", milestone: "3 · Universal Search and CLI overhaul" },
  { id: "notes", label: "Notes", glyph: "✎", milestone: "4 · Data platform and Notes" },
  { id: "context", label: "Context Shelf", glyph: "◷", milestone: "5 · Integrations and automation" },
  { id: "screenshot", label: "Screenshot Studio", glyph: "⌗", milestone: "6 · Media, screenshots and UI polish" },
  { id: "integrations", label: "Integrations", glyph: "⇄", milestone: "5 · Integrations and automation" },
  { id: "automations", label: "Automations", glyph: "↻", milestone: "5 · Integrations and automation" },
];

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

class WindowWorkspace {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.active = null;
  }

  attach() {
    const doc = this.doc;
    this.rail = el(doc, "div", { id: "lima-rail", role: "toolbar", "aria-orientation": "vertical", "aria-label": "Lima tools" });
    for (const tool of TOOLS) {
      const button = el(doc, "button", {
        class: "lima-rail-button",
        "data-tool": tool.id,
        title: tool.label,
        "aria-label": tool.label,
        "aria-pressed": "false",
        onclick: () => this.toggle(tool.id),
      }, [el(doc, "span", { class: "lima-glyph", text: tool.glyph })]);
      this.rail.prepend(button); // bottom-anchored: first tool sits lowest
    }
    this.rail.prepend(el(doc, "div", { class: "lima-rail-spacer" }));

    const foot = doc.getElementById("zen-sidebar-foot-buttons");
    if (foot?.parentNode) foot.parentNode.insertBefore(this.rail, foot);
    else (doc.getElementById("navigator-toolbox") ?? doc.documentElement).append(this.rail);

    this.panel = el(doc, "div", { id: "lima-panel", hidden: "true", role: "complementary" });
    const tabbox = doc.getElementById("tabbrowser-tabbox");
    if (tabbox?.parentNode) tabbox.parentNode.insertBefore(this.panel, tabbox.nextSibling);
    else doc.documentElement.append(this.panel);

    this.win.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.active && this.panel.contains(this.doc.activeElement)) this.toggle(this.active);
    });
  }

  toggle(id) {
    const opening = this.active !== id;
    this.active = opening ? id : null;
    for (const button of this.rail.querySelectorAll(".lima-rail-button")) {
      button.setAttribute("aria-pressed", String(button.dataset.tool === this.active));
    }
    if (!opening) {
      this.panel.setAttribute("hidden", "true");
      return;
    }
    this.panel.removeAttribute("hidden");
    this.render(TOOLS.find(t => t.id === id));
  }

  render(tool) {
    const doc = this.doc;
    const body = el(doc, "div", { class: "lima-panel-body" });
    this.panel.replaceChildren(
      el(doc, "header", { class: "lima-panel-header" }, [
        el(doc, "h2", { text: tool.label }),
        el(doc, "button", { class: "lima-close", "aria-label": "Close", text: "×", onclick: () => this.toggle(tool.id) }),
      ]),
      body
    );
    if (tool.id === "agents") this.renderAgents(body);
    else body.append(el(doc, "p", { class: "lima-muted", text: `Arrives in internal milestone ${tool.milestone}.` }));
  }

  async renderAgents(body) {
    const doc = this.doc;
    body.replaceChildren(el(doc, "p", { class: "lima-muted", text: "Connecting to Lima runtime…" }));
    try {
      const hello = await lazy.LimaBridge.request("host.hello");
      const agents = await lazy.LimaBridge.request("agents.discover");
      const list = el(doc, "ul", { class: "lima-agent-list" });
      for (const agent of agents) {
        list.append(el(doc, "li", { class: `lima-agent lima-status-${agent.status}` }, [
          el(doc, "span", { class: "lima-agent-name", text: agent.provider }),
          el(doc, "span", { class: "lima-agent-detail", text: agent.version ? `v${agent.version}` : agent.status.replaceAll("_", " ") }),
        ]));
      }
      body.replaceChildren(
        el(doc, "p", { class: "lima-muted", text: `Runtime ${hello.hostVersion} · bridge v${hello.protocol}` }),
        list
      );
    } catch (error) {
      body.replaceChildren(el(doc, "p", { class: "lima-error", text: `Lima runtime unavailable: ${error.message}` }));
    }
  }
}

export const LimaWindow = {
  attach(win) {
    if (win.limaWorkspace) return;
    win.limaWorkspace = new WindowWorkspace(win);
    win.limaWorkspace.attach();
  },
};
