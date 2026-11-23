
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaVisualActivity: "resource://lima/LimaVisualActivity.sys.mjs",
  broadcastToLimaPages: "resource://lima/actors/LimaParent.sys.mjs",
  LimaWorkspaces: "resource://lima/LimaWorkspaces.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});
const HTML = "http://www.w3.org/1999/xhtml";

export const LimaAssistant = {
  attach(win) {
    const doc = win.document;
    const toolbar = doc.getElementById("zen-sidebar-top-buttons-customization-target") ?? doc.getElementById("nav-bar-customization-target");
    const surface = doc.getElementById("browser");
    if (!toolbar || !surface) return;

    const icon = doc.createElementNS(HTML, "span");
    const button = doc.createElementNS(HTML, "button");
    button.id = "lima-assistant-toggle";
    button.title = "Lima Companion";
    button.setAttribute("aria-label", "Lima Companion");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "lima-assistant-panel");
    button.setAttribute("skipintoolbarset", "true");
    const updatePersonality = () => button.dataset.personality = Services.prefs.getStringPref("lima.personality", "full");
    updatePersonality();
    Services.prefs.addObserver("lima.personality", updatePersonality);
    win.addEventListener("unload", () => Services.prefs.removeObserver("lima.personality", updatePersonality), { once: true });
    button.append(icon);
    const root = doc.documentElement;
    function placeButton() {
      const floats = root.getAttribute("zen-compact-mode") === "true" || root.getAttribute("zen-right-side") === "true";
      button.toggleAttribute("floating", floats);
      const parent = floats ? surface : toolbar;
      if (button.parentNode !== parent) parent.prepend(button);
    }
    placeButton();
    const layout = new win.MutationObserver(placeButton);
    layout.observe(root, { attributes: true, attributeFilter: ["zen-compact-mode", "zen-right-side"] });
    win.addEventListener("unload", () => layout.disconnect(), { once: true });

    const panel = doc.createXULElement("vbox");
    panel.id = "lima-assistant-panel";
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "Lima Companion");
    panel.setAttribute("aria-hidden", "true");
    const outside = doc.createElementNS(HTML, "div");
    outside.id = "lima-assistant-outside";
    outside.hidden = true;
    outside.setAttribute("aria-hidden", "true");
    surface.append(outside, panel);

    let browser;
    let open = false;
    let pendingDraft = "";
    let needsHandoff = false;
    let active;

    function paint() {
      if (active?.motion && active.motion !== "idle") button.dataset.activity = active.motion;
      else delete button.dataset.activity;
      const attention = needsHandoff || active?.state === "blocked" || active?.state === "failed";
      button.toggleAttribute("lima-attention", attention);
      button.title = needsHandoff ? "Lima Companion · Review workspace access" : active ? `Lima Companion · ${active.label}` : "Lima Companion";
      button.setAttribute("aria-label", button.title);
    }

    function toggle(show = !open) {
      const returnFocus = panel.contains(doc.activeElement) || doc.activeElement === button;
      open = show;
      outside.hidden = !open;
      if (open) panel.style.setProperty("--lima-assistant-top", `${Math.max(8, button.getBoundingClientRect().bottom + 6)}px`);
      button.setAttribute("aria-expanded", String(open));
      panel.setAttribute("aria-hidden", String(!open));
      panel.toggleAttribute("open", open);
      try {
        browser?.browsingContext?.currentWindowGlobal?.getActor("Lima")?.sendAsyncMessage("event",
          { event: "ui.companionVisible", data: open });
      } catch {}
      if (!open) { if (returnFocus) button.focus(); return; }
      if (!browser) {
        browser = doc.createXULElement("browser");
        browser.setAttribute("type", "content");
        browser.setAttribute("remote", "true");
        browser.setAttribute("remoteType", "privilegedabout");
        browser.setAttribute("maychangeremoteness", "true");
        browser.setAttribute("disableglobalhistory", "true");
        const workspace = lazy.LimaWorkspaces.workspaceForTab(win.gBrowser.selectedTab);
        const draft = pendingDraft ? `&draft=${encodeURIComponent(pendingDraft.slice(0, 4000))}` : "";
        pendingDraft = "";
        browser.setAttribute("src", `about:lima?view=assistant${workspace ? `&workspaceId=${encodeURIComponent(workspace)}` : ""}${draft}`);
        panel.append(browser);
      } else if (pendingDraft) {
        lazy.broadcastToLimaPages("assistant.draft", { text: pendingDraft.slice(0, 4000) });
        pendingDraft = "";
      }
      browser.focus();
    }

    button.addEventListener("click", () => toggle());
    outside.addEventListener("click", () => toggle(false));
    win.addEventListener("keydown", event => {
      if (open && event.key === "Escape" && (event.target === button || panel.contains(event.target))) {
        event.preventDefault();
        toggle(false);
      }
    }, true);
    // Search's Delegate Task opens the Companion with the query as its draft.
    win.addEventListener("LimaAssistantOpen", event => {
      if (typeof event.detail?.draft === "string") pendingDraft = event.detail.draft;
      if (!open) toggle(true);
      else if (pendingDraft) { lazy.broadcastToLimaPages("assistant.draft", { text: pendingDraft.slice(0, 4000) }); pendingDraft = ""; }
    });
    win.addEventListener("LimaAssistantClose", () => { if (open) toggle(false); });
    win.addEventListener("LimaAssistantAttention", event => { needsHandoff = event.detail === true; paint(); });

    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    const unsubscribe = lazy.LimaVisualActivity.subscribe(snapshot => {
      active = snapshot.companion;
      paint();
    });
    win.addEventListener("unload", unsubscribe, { once: true });
  },
};
