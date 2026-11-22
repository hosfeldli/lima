import { bridge, call, el, errorText, setPage } from "./lib.js";
import { companion } from "./companion.js";
import { PROVIDERS } from "./composer.js";
import { setupAction } from "./views.js";

export function renderWelcome(app) {
  setPage("Lima Basics");
  const steps = ["Meet Lima", "Connect an AI", "Try Search", "Create a Workspace", "You're Ready"];
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
  const skip = button("Skip for Now", finish);
  const back = button("Back", () => show(index - 1));
  const next = button("Continue", () => index + 1 === steps.length ? finish() : show(index + 1), "primary");
  const paragraph = text => el("p", { class: "welcome-description", text });
  function show(step, focus = true) {
    const ticket = ++generation;
    index = step;
    indicator.textContent = `Step ${step + 1} of ${steps.length}`;
    title.textContent = steps[step];
    status.textContent = "";
    back.disabled = step === 0;
    next.textContent = step === 1 ? "Skip for Now" : step === steps.length - 1 ? "Finish" : "Continue";
    skip.hidden = step === steps.length - 1;
    if (step === 0) content.replaceChildren(paragraph("Your browser, workspace, and AI tools in one place."),
      paragraph("I’m Lima, your Companion. I’ll check what’s already set up on this Mac, so you only see the steps you need."));
    if (step === 1) detect(ticket);
    if (step === 2) content.replaceChildren(paragraph("Press ⌘T to find pages, tools, notes, and workspaces. Ask a question there and I’ll answer in place."),
      el("div", { class: "row" }, button("Try It", () => bridge.browser("search", { text: "" }), "primary")));
    if (step === 3) content.replaceChildren(paragraph("Connect an AI agent to a project folder. Its chat, terminal, and pages live together in one sidebar folder."),
      el("div", { class: "row" }, button("Try It", () => bridge.browser("create", { what: "workspace", pickFolder: true }), "primary")));
    if (step === 4) content.replaceChildren(paragraph("Start browsing. Lima is available whenever you need it."),
      paragraph("Open the Companion in the top left of the sidebar to delegate a task. Requests that need your approval appear there."),
      el("details", { class: "welcome-permission" }, el("summary", { text: "Optional permissions" }),
        paragraph("You can grant these later, when you use a feature that needs them."),
        el("div", { class: "row" },
          button("Grammar shortcut (⌘G)", () => bridge.openTab("about:lima?view=integrations&section=writing")),
          button("Accessibility settings", () => bridge.browser("accessibilitySettings", {})),
          button("Files & Folders settings", () => bridge.browser("filesPrivacySettings", {})))));
    if (focus) title.focus();
  }
  async function detect(ticket) {
    content.replaceChildren(paragraph("Choose Claude Code, Codex, or OpenCode. Checking which are on this Mac…"));
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
          button("Open Setup", () => bridge.openTab("about:lima?view=integrations&section=agents")),
          button("Check Again", recheck)));
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
