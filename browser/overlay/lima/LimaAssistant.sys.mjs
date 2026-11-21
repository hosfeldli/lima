import { lastVisibleTool, replyActivity, toolActivity } from "resource://lima/ui/tool-activity.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LimaBridge: "resource://lima/LimaBridge.sys.mjs",
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
    let needsHandoff = false;
    const prompts = new Set();
    const activity = new Map();
    const replies = new Map();

    function paint() {
      const states = [...activity.values()];
      const moving = states.findLast(state => state.state === "working" || state.state === "starting");
      const active = moving ?? states.at(-1);
      if (moving) button.dataset.activity = moving.motion;
      else delete button.dataset.activity;
      if (active?.icon) {
        icon.style.maskImage = `url("resource://lima-ui/icons/${active.icon}.svg")`;
      } else {
        icon.style.maskImage = "";
      }
      const attention = needsHandoff || prompts.size > 0;
      button.toggleAttribute("lima-attention", attention);
      button.title = attention ? "Lima Companion · Response requested" : active ? `Lima Companion · ${active.label}` : "Lima Companion";
      button.setAttribute("aria-label", button.title);
    }

    function toggle(show = !open) {
      open = show;
      outside.hidden = !open;
      if (open) panel.style.setProperty("--lima-assistant-top", `${Math.max(8, button.getBoundingClientRect().bottom + 6)}px`);
      button.setAttribute("aria-expanded", String(open));
      panel.setAttribute("aria-hidden", String(!open));
      panel.toggleAttribute("open", open);
      if (!open) { button.focus(); return; }
      if (!browser) {
        browser = doc.createXULElement("browser");
        browser.setAttribute("type", "content");
        browser.setAttribute("remote", "true");
        browser.setAttribute("remoteType", "privilegedabout");
        browser.setAttribute("maychangeremoteness", "true");
        browser.setAttribute("disableglobalhistory", "true");
        const workspace = lazy.LimaWorkspaces.workspaceForTab(win.gBrowser.selectedTab);
        browser.setAttribute("src", `about:lima?view=assistant${workspace ? `&workspaceId=${encodeURIComponent(workspace)}` : ""}`);
        panel.append(browser);
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
    win.addEventListener("LimaAssistantOpen", () => { if (!open) toggle(true); });
    win.addEventListener("LimaAssistantClose", () => { if (open) toggle(false); });
    win.addEventListener("LimaAssistantAttention", event => { needsHandoff = event.detail === true; paint(); });

    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) return;
    function setActivity(id, state) {
      activity.delete(id);
      if (state) activity.set(id, state);
      paint();
    }
    const unsubscribe = lazy.LimaBridge.onEvent(({ event, data }) => {
      if (event === "prompt.opened") { prompts.add(data.id); paint(); }
      if (event === "prompt.closed") { prompts.delete(data.id); paint(); }
      if (event === "workspace.deleted") {
        for (const [id, reply] of replies) if (reply.workspace === data.id) replies.delete(id);
        setActivity(data.id);
      }
      if (event === "workspace.activity") {
        const raw = { terminal: "workspace_run", tab: "workspace_read_tab" }[data.surface];
        if (raw) {
          const { label, icon, kind } = toolActivity(raw);
          setActivity(data.id, { state: "working", label, icon, motion: kind });
        } else if (data.surface === "chat") {
          const reply = [...replies.values()].find(item => item.workspace === data.id);
          if (reply) {
            reply.tool = undefined;
            setActivity(data.id, replyActivity(reply.message, { provider: reply.provider }));
          }
        } else if (data.surface === "idle" && ![...replies.values()].some(reply => reply.workspace === data.id && reply.message.status === "streaming")) {
          const state = activity.get(data.id)?.state;
          if (state === "working" || state === "starting") setActivity(data.id);
        }
      }
      if (event === "chat.updated") {
        const message = data.messages?.findLast(item => item.role === "assistant");
        const workspace = data.workspaceID ?? data.id;
        const prior = replies.get(data.id);
        const tool = prior?.message.id === message?.id && prior?.message.tools?.length === message?.tools?.length
          ? prior?.tool : lastVisibleTool(message?.tools);
        const next = replyActivity(message, { provider: data.provider, tool });
        if (message?.status === "streaming") replies.set(data.id, { workspace, provider: data.provider, message, tool });
        else replies.delete(data.id);
        setActivity(workspace, message?.status === "streaming" || message?.status === "failed" ? next : null);
      }
      if (event === "chat.delta") {
        const reply = replies.get(data.conversationId);
        if (reply?.message.id === data.messageId && (reply.tool || !reply.message.text?.trim()) && data.text?.trim()) {
          reply.tool = undefined;
          reply.message = { ...reply.message, text: data.text };
          setActivity(reply.workspace, replyActivity(reply.message, { provider: reply.provider }));
        }
      }
    });
    lazy.LimaBridge.request("workspace.prompts").then(list => { for (const prompt of list) prompts.add(prompt.id); paint(); }).catch(() => {});
    win.addEventListener("unload", unsubscribe, { once: true });
  },
};
