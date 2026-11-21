import { bridge, call, el, errorText, setPage } from "./lib.js";
import { companion } from "./companion.js";
import { PROVIDERS } from "./composer.js";
import { setupAction } from "./views.js";

export function renderWelcome(app) {
  setPage("Lima Basics");
  const steps = ["Meet Lima", "Connect your AI", "Choose permissions", "Try Lima"];
  const indicator = el("p", { class: "welcome-position", "aria-live": "polite" });
  const title = el("h2", { tabindex: "-1" });
  const content = el("div", { class: "welcome-step-content" });
  const status = el("p", { role: "status" });
  let index = 0;
  let generation = 0;
  let leaving = false;
  const mascot = companion("home");
  const button = (label, run, className = "ghost") => el("button", { class: className, onclick: async () => {
    status.textContent = "";
    try { await run(); }
    catch (error) { status.textContent = errorText(error); }
  } }, label);
  const stop = () => { generation++; };
  const finish = async () => {
    if (leaving) return;
    leaving = true;
    stop();
    back.disabled = skip.disabled = next.disabled = true;
    indicator.textContent = "";
    title.textContent = "See you around";
    content.replaceChildren(paragraph("If you ever need anything, I’ll be right here."));
    title.focus();
    await new Promise(resolve => setTimeout(resolve, 1900));
    const { x, y, width, height } = mascot.getBoundingClientRect();
    mascot.style.visibility = "hidden";
    try { await bridge.browser("finishWelcome", { x, y, width, height }); }
    catch (error) {
      leaving = false;
      mascot.style.visibility = "";
      back.disabled = index === 0;
      skip.disabled = next.disabled = false;
      throw error;
    }
  };
  const skip = button("Skip setup", finish);
  const back = button("Back", () => show(index - 1));
  const next = button("Get started", () => index + 1 === steps.length ? finish() : show(index + 1), "primary");
  const paragraph = text => el("p", { class: "welcome-description", text });
  function show(step, focus = true) {
    const ticket = ++generation;
    index = step;
    indicator.textContent = `Step ${step + 1} of ${steps.length}`;
    title.textContent = steps[step];
    status.textContent = "";
    back.disabled = step === 0;
    next.textContent = ["Get started", "Skip for now", "Continue", "Finish"][step];
    if (step === 0) content.replaceChildren(paragraph("I’m Lima, your Companion. Ask me a quick question or give me a task. I can organize your tabs, take notes, and show you what a workspace agent is doing."),
      paragraph("I’ll check which AI tools are already on this Mac. You can skip any setup step and come back later."));
    if (step === 1) detect(ticket);
    if (step === 2) content.replaceChildren(
      paragraph("These permissions are optional. You can grant them later when you use a feature that needs them."),
      el("div", { class: "welcome-permission" }, el("strong", { text: "Grammar shortcut" }),
        paragraph("Enable ⌘G in Writing Tools. In macOS Accessibility settings, allow Lima to read the selected text."),
        button("Open Writing Tools", () => bridge.openTab("about:lima?view=integrations&section=writing")),
        button("Open Accessibility settings", () => bridge.browser("accessibilitySettings", {}))),
      el("div", { class: "welcome-permission" }, el("strong", { text: "Project folders" }),
        paragraph("If macOS blocks a workspace from opening Documents or Desktop, check Lima’s access under Files & Folders."),
        button("Open Files & Folders settings", () => bridge.browser("filesPrivacySettings", {}))));
    if (step === 3) content.replaceChildren(
      paragraph("Open the Companion in the top left to ask me for help. Press ⌘T to search tabs, notes, and tools. Use Plus in the sidebar to start a note, terminal, or AI workspace."),
      paragraph("Click a workspace row to open its chat. The arrow on the row shows its tabs and terminal. Requests that need your input appear in the Companion."),
      el("div", { class: "row" },
        button("Open Companion", () => bridge.browser("openAssistant", {})),
        button("Try Lima Search", () => bridge.browser("search", {})),
        button("Open Notes", () => bridge.openTab("about:lima?view=notes"))));
    if (focus) title.focus();
  }
  async function detect(ticket) {
    content.replaceChildren(paragraph("Checking for Claude, Codex, and OpenCode…"));
    try {
      const [providers, configured] = await Promise.all([call("agents.discover"), call("agents.configured")]);
      if (ticket !== generation) return;
      const ready = configured.filter(id => Object.hasOwn(PROVIDERS, id));
      if (ready.length) {
        const preferences = await bridge.browser("agentPreferences", {});
        if (ticket !== generation) return;
        const provider = ready.includes(preferences.provider) ? preferences.provider : ready[0];
        await bridge.browser("rememberAgent", { provider, model: preferences.models[provider] ?? "default" });
        if (ticket !== generation) return;
        const other = ready.filter(id => id !== provider).map(id => PROVIDERS[id]);
        content.replaceChildren(paragraph(`${PROVIDERS[provider]} is ready. I’ll use it by default.`),
          other.length ? paragraph(`Also connected: ${other.join(", ")}. You can switch providers in Settings.`) : null);
        next.textContent = "Continue";
        return;
      }
      const installed = providers.filter(provider => provider.status === "available");
      const recheck = () => detect(ticket);
      content.replaceChildren(paragraph(installed.length
        ? `I found ${installed.map(provider => PROVIDERS[provider.provider]).join(" and ")}. Finish signing in so I can use it.`
        : "I couldn’t find a ready AI provider on this Mac. Install a provider in Settings, then check again."),
        ...installed.filter(provider => ["claude", "codex"].includes(provider.provider)).map(provider =>
          setupAction(provider.provider, `Sign in to ${PROVIDERS[provider.provider]}`, `Start ${PROVIDERS[provider.provider]} sign-in on this Mac?`, recheck)),
        el("div", { class: "row" },
          button("Open AI provider settings", () => bridge.openTab("about:lima?view=integrations&section=agents")),
          button("Check again", recheck)));
    } catch (error) {
      if (ticket === generation) {
        content.replaceChildren(paragraph("I couldn’t check which AI tools are ready."), button("Try again", () => detect(ticket)));
        status.textContent = errorText(error);
      }
    }
  }

  window.addEventListener("pagehide", stop, { once: true });
  show(0, false);
  app.append(el("article", { class: "welcome-tour" },
    el("header", {}, mascot, el("h1", { text: "Welcome to Lima" })),
    el("section", { class: "welcome-step" }, indicator, title, content, status),
    el("nav", { class: "welcome-navigation", "aria-label": "Walkthrough steps" }, back, skip, next)));
}
