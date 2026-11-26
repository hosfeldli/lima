
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
    button.title = "Pip, your Lima Companion";
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
    const toolbox = doc.getElementById("navigator-toolbox");
    // The attributes Zen sets while a compact sidebar is slid out.
    const SHOWN = ["zen-has-hover", "zen-user-show", "zen-has-empty-tab", "flash-popup", "has-popup-menu", "movingtab", "zen-compact-mode-active"];
    // Where the Companion rests while the sidebar is closed (matches lima.css):
    // the left edge, just below the window buttons Zen shows on hover.
    const REST_X = 10;
    const REST_Y = 44;
    const sidebarOut = () => SHOWN.some(name => toolbox?.hasAttribute(name));
    const shouldFloat = () => root.getAttribute("zen-right-side") === "true" ||
      (root.getAttribute("zen-compact-mode") === "true" && !sidebarOut());
    /* Closing the sidebar (compact mode) carries the Companion with it: an
     * empty slot keeps its place in the sidebar's toolbar while the button,
     * fixed above everything, follows that slot each frame until it reaches
     * the window's left edge, and stays there. Opening the sidebar
     * reverses it: the button waits at the edge until the sliding slot
     * reaches it, rides in and drops into place. */
    let slot = null;
    let frame = 0;
    let startedAt = 0;
    let still = 0;
    let last = "";
    const put = (x, y) => { button.style.left = `${x}px`; button.style.top = `${y}px`; };
    function settle(floats) {
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
      button.style.removeProperty("left");
      button.style.removeProperty("top");
      button.toggleAttribute("floating", floats);
      if (floats) { if (button.parentNode !== surface) surface.prepend(button); slot?.remove(); }
      else if (slot?.isConnected) slot.replaceWith(button);
      else if (button.parentNode !== toolbar) toolbar.prepend(button);
      slot = null;
    }
    function step(now) {
      frame = 0;
      const rect = slot.getBoundingClientRect();
      const x = Math.max(REST_X, rect.left);
      const lift = Math.min(1, Math.max(0, (rect.left - REST_X) / 48));
      put(x, REST_Y + (rect.top - REST_Y) * lift);
      const key = `${Math.round(rect.left)},${Math.round(rect.top)}`;
      still = key === last ? still + 1 : 0;
      last = key;
      if ((still >= 4 && now - startedAt > 150) || now - startedAt > 900) { settle(shouldFloat()); return; }
      frame = win.requestAnimationFrame(step);
    }
    function placeButton() {
      const floats = shouldFloat();
      if (!slot && button.hasAttribute("floating") === floats && button.parentNode === (floats ? surface : toolbar)) return;
      const instant = root.getAttribute("zen-right-side") === "true" || !button.isConnected ||
        win.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (instant) { settle(floats); return; }
      if (!slot) {
        const from = button.getBoundingClientRect();
        slot = doc.createElementNS(HTML, "span");
        slot.id = "lima-assistant-slot";
        if (button.parentNode === toolbar) button.replaceWith(slot);
        else toolbar.prepend(slot);
        button.setAttribute("floating", "");
        if (button.parentNode !== surface) surface.prepend(button);
        put(from.left, from.top);
      }
      startedAt = win.performance.now();
      still = 0;
      last = "";
      if (!frame) frame = win.requestAnimationFrame(step);
    }
    placeButton();
    const layout = new win.MutationObserver(placeButton);
    layout.observe(root, { attributes: true, attributeFilter: ["zen-compact-mode", "zen-right-side"] });
    if (toolbox) layout.observe(toolbox, { attributes: true, attributeFilter: SHOWN });
    win.addEventListener("unload", () => { layout.disconnect(); if (frame) win.cancelAnimationFrame(frame); }, { once: true });

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
      button.title = needsHandoff ? "Pip · Review workspace access" : active ? `Pip · ${active.label}` : "Pip, your Lima Companion";
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
