import { bridge, call, el, errorText, icon, permissionSheet, setPage } from "./lib.js";
import { companion, cueCompanion, setCompanionState } from "./companion.js";
import { PROVIDERS } from "./composer.js";
import { setupAction } from "./views.js";

/* Lima Basics: a full-viewport walkthrough. Each step pairs short copy and
 * its actions with a small animated scene; the Companion reacts to every
 * step. All motion is decorative: Reduce Motion and the Off personality
 * leave the same layout and controls, standing still. */

const STEPS = [
  { id: "meet", eyebrow: "Welcome to Lima", title: "Hi, I’m Pip.", mood: null },
  { id: "about", eyebrow: "About you", title: "Nice to meet you.", mood: "write" },
  { id: "import", eyebrow: "Move in", title: "Bring your browser with you.", mood: "tabs" },
  { id: "default", eyebrow: "Links", title: "Open every link in Lima.", mood: "read" },
  { id: "ai", eyebrow: "Your AI", title: "Connect an AI.", mood: "think" },
  { id: "search", eyebrow: "⌘T", title: "One search for everything.", mood: "read" },
  { id: "workspace", eyebrow: "Workspaces", title: "Hand off the big stuff.", mood: "delegate" },
  { id: "ready", eyebrow: "All set", title: "You’re ready.", mood: "complete" },
];
const GREETINGS = ["Hi, I’m Pip!", "That tickles.", "Ready when you are.", "Pip, at your service.", "Boop.", "Let’s go!"];
const quiet = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.limaPersonality === "off";

export function renderWelcome(app) {
  setPage("Lima Basics");
  document.documentElement.classList.add("welcome-page");
  let index = 0;
  let generation = 0;
  let leaving = false;
  let greeting = 0;
  const visited = new Set([0]);
  // Steps whose task the user finished; their progress segment shows a tick.
  const completed = new Set();
  // The step's own primary action (save, use this AI); Continue runs it.
  let stepAction = null;

  const mascot = companion("home");
  const bubble = el("span", { class: "welcome-bubble", "aria-hidden": "true" });
  const buddy = el("button", { class: "welcome-buddy", type: "button", "aria-label": "Say hi to Lima", onclick: () => {
    cueCompanion(mascot, "receive");
    say(GREETINGS[greeting++ % GREETINGS.length]);
  } }, mascot, bubble);
  const say = text => {
    bubble.textContent = text;
    bubble.classList.remove("show");
    void bubble.offsetWidth;
    bubble.classList.add("show");
  };

  const eyebrow = el("p", { class: "welcome-eyebrow", "aria-live": "polite" });
  const title = el("h1", { class: "welcome-title", tabindex: "-1" });
  const content = el("div", { class: "welcome-step-content" });
  const status = el("p", { class: "welcome-status", role: "status" });
  const copy = el("section", { class: "welcome-copy" }, eyebrow, title, content, status);
  const scene = el("div", { class: "welcome-scene", "aria-hidden": "true" });
  const stage = el("main", { class: "welcome-stage" }, copy, el("div", { class: "welcome-visual" }, scene, buddy));

  const button = (label, run, className = "ghost") => el("button", { type: "button", class: className, onclick: async () => {
    status.textContent = "";
    try { await run(); }
    catch (error) { status.textContent = errorText(error); }
  } }, label);
  const paragraph = text => el("p", { class: "welcome-description", text });
  const stop = () => { generation++; };

  const progress = el("ol", { class: "welcome-progress", "aria-label": "Walkthrough steps" },
    STEPS.map((step, position) => el("li", {}, el("button", { type: "button", class: "welcome-dot", "aria-label": `Step ${position + 1}: ${step.title}`,
      onclick: () => show(position) }, el("span")))));
  const skip = button("Skip intro", () => finish());
  const back = button("Back", () => show(index - 1));
  const next = button("Continue", () => stepAction ? stepAction() : index + 1 === STEPS.length ? finish() : show(index + 1), "primary welcome-next");

  /** A finished task: confetti, a happy Companion, then the next step. */
  const celebrate = (text, ticket = generation) => {
    if (ticket !== generation || leaving) return;
    const step = index;
    completed.add(step);
    progress.children[step]?.setAttribute("data-complete", "");
    const burst = el("div", { class: "welcome-celebrate", "aria-hidden": "true" }, confetti(70));
    root.append(burst);
    setTimeout(() => burst.remove(), 2400);
    setCompanionState(mascot, "complete");
    cueCompanion(mascot, "receive");
    say(text);
    status.textContent = text;
    next.disabled = true;
    setTimeout(() => {
      next.disabled = false;
      if (ticket === generation && !leaving && index === step) show(step + 1);
    }, quiet() ? 700 : 1500);
  };
  const hint = el("span", { class: "welcome-keys", "aria-hidden": "true" }, el("kbd", { text: "←" }), el("kbd", { text: "→" }), " to move");

  const finish = async () => {
    if (leaving) return;
    leaving = true;
    stop();
    back.disabled = skip.disabled = next.disabled = true;
    root.dataset.step = "farewell";
    eyebrow.textContent = "";
    title.textContent = "See you around.";
    content.replaceChildren(paragraph("If you ever need anything, I’ll be right here in the sidebar."));
    scene.replaceChildren(confetti(60));
    title.focus();
    cueCompanion(mascot, "farewell");
    say("Bye for now!");
    await new Promise(resolve => setTimeout(resolve, quiet() ? 600 : 1500));
    try { await bridge.browser("finishWelcome", {}); }
    catch (error) {
      leaving = false;
      back.disabled = index === 0;
      skip.disabled = next.disabled = false;
      root.dataset.step = STEPS[index].id;
      throw error;
    }
  };

  function animateIn(direction) {
    if (quiet()) return;
    const offset = direction * 28;
    copy.animate([{ opacity: 0, transform: `translateX(${offset}px)` }, { opacity: 1, transform: "none" }],
      { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
    scene.animate([{ opacity: 0, transform: `translateX(${offset * 1.6}px) scale(.96)` }, { opacity: 1, transform: "none" }],
      { duration: 560, easing: "cubic-bezier(.2,.8,.2,1)" });
    const words = [...title.querySelectorAll(".welcome-word")];
    words.forEach((word, position) => word.animate([{ opacity: 0, transform: "translateY(.45em) rotate(3deg)" }, { opacity: 1, transform: "none" }],
      { duration: 460, delay: 60 + position * 55, easing: "cubic-bezier(.2,.9,.25,1.2)", fill: "backwards" }));
  }

  function setTitle(text) {
    title.replaceChildren(...text.split(" ").flatMap((word, position) => [position ? " " : "", el("span", { class: "welcome-word", text: word })]));
    title.setAttribute("aria-label", text);
  }

  function show(step, focus = true) {
    if (step < 0 || step >= STEPS.length) return;
    const direction = step >= index ? 1 : -1;
    const ticket = ++generation;
    index = step;
    stepAction = null;
    next.disabled = false;
    visited.add(step);
    const { id, eyebrow: label, title: name, mood } = STEPS[step];
    root.dataset.step = id;
    eyebrow.textContent = `${label} · ${step + 1} of ${STEPS.length}`;
    setTitle(name);
    status.textContent = "";
    back.disabled = step === 0;
    next.textContent = id === "ai" ? "Skip this step" : id === "ready" ? "Start browsing" : "Continue";
    // Once the scene is gone, a step's finished task still shows a tick.
    for (const [position, item] of [...progress.children].entries()) item.toggleAttribute("data-complete", completed.has(position));
    skip.style.visibility = id === "ready" ? "hidden" : "";
    for (const [position, item] of progress.querySelectorAll("li").entries()) {
      const dot = item.firstChild;
      if (position === step) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
      item.dataset.state = position < step ? "done" : position === step ? "current" : visited.has(position) ? "seen" : "";
    }
    if (mood) setCompanionState(mascot, mood);
    else delete mascot.dataset.state;
    scene.classList.remove("is-default");
    scene.replaceChildren(SCENES[id === "import" ? "moveIn" : id]());

    if (id === "meet") {
      content.replaceChildren(paragraph("I’m Lima’s companion. Lima is your browser, your notes and your AI helpers, all in one calm place."),
        paragraph("I’ll show you around in about a minute. I check what’s already set up on this Mac, so you only see what you need. You’ll find me in the sidebar, and every workspace gets a Pip of its own."));
      if (!focus) setTimeout(() => { if (ticket === generation) say("Hi, I’m Pip!"); }, 700);
    }
    if (id === "about") showAbout(ticket);
    if (id === "import") content.replaceChildren(
      paragraph("Bring over bookmarks, history and passwords from the browser you used before. You choose exactly what comes along."),
      el("div", { class: "row" }, button("Choose browser data", async () => {
        const result = await bridge.browser("welcomeImport", {});
        if (ticket !== generation) return;
        if (result?.imported) celebrate("All moved in!", ticket);
        else if (result?.waited) status.textContent = "Nothing was imported. You can do it later from File → Import From Another Browser.";
      }, "primary")));
    if (id === "default") showDefault(ticket);
    if (id === "ai") detect(ticket);
    if (id === "search") content.replaceChildren(
      paragraph("Press ⌘T and type anything: a website, an open tab, a note, a workspace, or a command. Enter opens the top result."),
      paragraph("Ask a question and I’ll offer a quick answer right there. ⌘↩ opens it in AI Chat instead."),
      el("div", { class: "row" }, button("Try it now", () => bridge.browser("search", { text: "" }), "primary"),
        el("span", { class: "welcome-shortcut", "aria-hidden": "true" }, el("kbd", { text: "⌘" }), el("kbd", { text: "T" }))));
    if (id === "workspace") content.replaceChildren(
      paragraph("Point an AI agent at a project folder and give it a goal. It gets its own folder in the sidebar with a chat and the pages it opens, and works with its own tools."),
      paragraph("Big jobs can split into helpers. You can follow along, or come back when it’s done."),
      el("div", { class: "row" }, button("Create a workspace", async () => {
        if (await bridge.browser("create", { what: "workspace", pickFolder: true })) celebrate("Your first workspace!", ticket);
      }, "primary")));
    if (id === "ready") {
      content.replaceChildren(paragraph("Start browsing. The Companion lives at the top of the sidebar whenever you want to hand something off, and anything that needs your OK shows up there."),
        el("details", { class: "welcome-permission" }, el("summary", { text: "Optional permissions" }),
          paragraph("You can grant these later, when you use a feature that needs them."),
          el("div", { class: "row" },
            button("Grammar shortcut (⌘G)", () => bridge.openTab("about:lima?view=integrations&section=writing")),
            button("Accessibility…", () => permissionSheet("accessibility")),
            button("Files & Folders…", () => permissionSheet("files")))));
      say("Woohoo!");
    }
    animateIn(direction);
    if (focus) title.focus();
  }

  /** Optional details, saved to Personal Memory, plus the Companion's own
   * daily memory switch. Nothing here is required; Continue skips it. */
  function showAbout(ticket) {
    const field = (label, control, wide = false) => el("label", { class: wide ? "welcome-field wide" : "welcome-field" }, el("span", { text: label }), control);
    const inputs = {
      name: el("input", { type: "text", autocomplete: "name", maxlength: 120, placeholder: "What should I call you?" }),
      email: el("input", { type: "email", autocomplete: "email", maxlength: 320 }),
      phone: el("input", { type: "tel", autocomplete: "tel", maxlength: 40 }),
      homeAddress: el("input", { type: "text", autocomplete: "street-address", maxlength: 500 }),
      notes: el("textarea", { rows: 2, maxlength: 4000, placeholder: "Your work, hobbies, how you like answers…" }),
    };
    const share = el("input", { type: "checkbox", checked: true });
    const remember = el("input", { type: "checkbox", checked: true });
    let saved = {};
    const filled = () => Object.values(inputs).some(input => input.value.trim());
    const label = () => {
      if (ticket !== generation) return;
      next.textContent = filled() ? "Save and continue" : "Skip for now";
      const tag = scene.querySelector(".scene-name");
      if (tag) tag.textContent = inputs.name.value.trim().split(/\s+/)[0] || "…";
    };
    const form = el("form", { class: "welcome-form", autocomplete: "on", oninput: label, onsubmit: event => { event.preventDefault(); next.click(); } },
      field("Name", inputs.name), field("Email", inputs.email), field("Phone", inputs.phone), field("Home address", inputs.homeAddress),
      field("Anything I should know?", inputs.notes, true),
      el("label", { class: "welcome-check wide" }, share, "Let the Companion use these when they help"),
      el("label", { class: "welcome-check wide" }, remember, "Let the Companion keep its own memory of what it learns, updated once a day"),
      el("button", { type: "submit", hidden: true, tabindex: "-1" }));
    content.replaceChildren(
      paragraph("All optional. Lima keeps this encrypted on this Mac, and you can change or clear it anytime in Settings → Personal Memory."),
      form);
    label();
    call("personalMemory.get").then(data => {
      if (ticket !== generation) return;
      saved = data ?? {};
      for (const [key, input] of Object.entries(inputs)) if (!input.value) input.value = saved[key] ?? "";
      if (Object.values(saved).some(value => value === true)) share.checked = saved.shareProfile || saved.shareNotes;
      label();
    }).catch(() => {});
    call("companionMemory.get").then(data => { if (ticket === generation && data) remember.checked = data.enabled; }).catch(() => {});
    stepAction = async () => {
      next.disabled = true;
      try {
        await call("companionMemory.update", { enabled: remember.checked }).catch(() => {});
        const values = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]));
        const changed = Object.entries(values).some(([key, value]) => value !== (saved[key] ?? ""));
        if (!filled() && !changed) return show(index + 1);
        await call("personalMemory.save", { ...saved, ...values, shareProfile: share.checked, shareNotes: share.checked && !!values.notes });
        const first = values.name.split(/\s+/)[0];
        celebrate(first ? `Nice to meet you, ${first}!` : "Got it, thanks!", ticket);
      } finally {
        if (!completed.has(index)) next.disabled = false;
      }
    };
  }

  function showDefault(ticket) {
    const showState = isDefault => {
      if (ticket !== generation) return;
      makeDefault.disabled = isDefault;
      makeDefault.textContent = isDefault ? "Lima is your default browser" : "Set as default";
      scene.classList.toggle("is-default", isDefault);
    };
    const makeDefault = button("Set as default", async () => {
      makeDefault.disabled = true;
      try {
        const isDefault = await bridge.browser("welcomeMakeDefault", {});
        showState(isDefault);
        if (isDefault) celebrate("Yay! Links open here now.", ticket);
        else if (ticket === generation) status.textContent = "If macOS asks, confirm the change there. You can then check again.";
      } catch (error) {
        showState(false);
        throw error;
      }
    }, "primary");
    // Already default on arrival is just shown; becoming default celebrates.
    let wasDefault = null;
    const check = () => bridge.browser("welcomeDefaultStatus", {}).then(isDefault => {
      showState(isDefault);
      if (isDefault && wasDefault === false) celebrate("Yay! Links open here now.", ticket);
      wasDefault = isDefault;
    });
    content.replaceChildren(paragraph("Links you click in Mail, Messages, Slack and every other app can open right here."),
      el("div", { class: "row" }, makeDefault, button("Check again", check)));
    check().catch(() => {});
  }

  async function detect(ticket) {
    content.replaceChildren(paragraph("I work with Claude Code, Codex, or OpenCode. Checking which are on this Mac…"));
    const mark = (ids, ready) => {
      for (const card of scene.querySelectorAll("[data-provider]")) {
        if (ids.includes(card.dataset.provider)) card.dataset.found = ready ? "ready" : "installed";
      }
    };
    try {
      const [providers, configured] = await Promise.all([call("agents.discover"), call("agents.configured")]);
      if (ticket !== generation) return;
      const ready = configured.filter(id => Object.hasOwn(PROVIDERS, id));
      if (ready.length) {
        const preferences = await bridge.browser("agentPreferences", {});
        if (ticket !== generation) return;
        let chosen = ready.includes(preferences.provider) ? preferences.provider : ready[0];
        await bridge.browser("rememberAgent", { provider: chosen, model: preferences.models[chosen] ?? "default" });
        if (ticket !== generation) return;
        mark(ready, true);
        setCompanionState(mascot, "complete");
        say("Found it!");
        const waiting = providers.filter(item => item.status === "available" && !ready.includes(item.provider)).map(item => item.provider);
        const choose = id => {
          chosen = id;
          for (const option of choices.querySelectorAll("[role=radio]")) {
            const on = option.dataset.provider === id;
            option.setAttribute("aria-checked", String(on));
            option.tabIndex = on ? 0 : -1;
          }
          for (const card of scene.querySelectorAll("[data-provider]")) card.toggleAttribute("data-chosen", card.dataset.provider === id);
          next.textContent = `Use ${PROVIDERS[id]}`;
        };
        const choices = el("div", { class: "welcome-choices", role: "radiogroup", "aria-label": "Default AI",
          onkeydown: event => {
            if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const step = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
            const id = ready[(ready.indexOf(chosen) + step + ready.length) % ready.length];
            choose(id);
            choices.querySelector(`[data-provider="${id}"]`)?.focus();
          } },
          ready.map(id => el("button", { type: "button", role: "radio", class: "welcome-choice", "data-provider": id, onclick: () => choose(id) },
            el("span", { class: "welcome-choice-mark" }, icon("check")), el("strong", { text: PROVIDERS[id] }), el("small", { text: "Signed in and ready" }))),
          waiting.map(id => el("div", { class: "welcome-choice", "aria-disabled": "true" },
            el("span", { class: "welcome-choice-mark" }), el("strong", { text: PROVIDERS[id] }), el("small", { text: "Installed. Sign in from Settings to use it." }))));
        content.replaceChildren(
          paragraph(ready.length > 1 ? "Pick the AI I should use by default. You can change it anytime in Settings." : `${PROVIDERS[chosen]} is ready. Make it my default?`),
          choices,
          paragraph(ready.length > 1 ? "If one hits its usage limit, I’ll quietly continue with another one that’s signed in." : "Sign in to another provider later and I can switch to it if this one hits its usage limit."));
        choose(chosen);
        stepAction = async () => {
          await bridge.browser("rememberAgent", { provider: chosen, model: preferences.models[chosen] ?? "default" });
          celebrate(`${PROVIDERS[chosen]} it is!`, ticket);
        };
        return;
      }
      const installed = providers.filter(provider => provider.status === "available");
      mark(installed.map(provider => provider.provider), false);
      const recheck = () => detect(ticket);
      content.replaceChildren(paragraph(installed.length
        ? `I found ${installed.map(provider => PROVIDERS[provider.provider]).join(" and ")}. Finish signing in so I can use it.`
        : "I couldn’t find a ready AI provider on this Mac. Install one in Settings, then check again. Everything else works without it."),
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

  const root = el("article", { class: "welcome", "aria-label": "Welcome to Lima" },
    el("div", { class: "welcome-backdrop", "aria-hidden": "true" }, el("i"), el("i"), el("i"), el("div", { class: "welcome-grid" })),
    el("header", { class: "welcome-top" }, el("span", { class: "welcome-brand" }, el("span", { class: "welcome-brand-mark" }), "Lima"), progress, skip),
    stage,
    el("nav", { class: "welcome-navigation", "aria-label": "Walkthrough" }, back, hint, next));

  // Arrow keys move between steps unless a control wants them.
  const onKey = event => {
    if (leaving || event.defaultPrevented || event.metaKey || event.altKey || event.ctrlKey) return;
    if (event.target.closest?.("input, textarea, select, details, [contenteditable]")) return;
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); next.click(); }
    if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); show(index - 1); }
  };
  // A gentle parallax: the backdrop and the character lean toward the pointer.
  const onPointer = event => {
    if (quiet()) return;
    const x = event.clientX / innerWidth - 0.5;
    const y = event.clientY / innerHeight - 0.5;
    root.style.setProperty("--welcome-x", x.toFixed(3));
    root.style.setProperty("--welcome-y", y.toFixed(3));
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("pointermove", onPointer, { passive: true });
  window.addEventListener("pagehide", () => {
    stop();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("pointermove", onPointer);
  }, { once: true });

  show(0, false);
  app.append(root);
}

// MARK: Scenes. Pure decoration (aria-hidden); CSS does the animating.

function chip(name, label, delay = 0) {
  const node = el("span", { class: "scene-chip" }, icon(name), label ? el("span", { text: label }) : null);
  node.style.setProperty("--delay", `${delay}s`);
  return node;
}

function windowFrame(label, ...children) {
  return el("div", { class: "scene-window" }, el("div", { class: "scene-window-bar" }, el("i"), el("i"), el("i"), el("span", { text: label })), ...children);
}

function confetti(count) {
  const burst = el("div", { class: "scene-confetti" });
  for (let n = 0; n < count; n++) {
    const piece = el("i");
    const angle = (n / count) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 120 + Math.random() * 220;
    piece.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    piece.style.setProperty("--dy", `${Math.sin(angle) * distance - 80}px`);
    piece.style.setProperty("--spin", `${Math.round(Math.random() * 720 - 360)}deg`);
    piece.style.setProperty("--delay", `${(Math.random() * 0.25).toFixed(2)}s`);
    piece.style.setProperty("--shade", `${30 + Math.round(Math.random() * 55)}%`);
    piece.dataset.shape = ["strip", "dot", "tri"][n % 3];
    burst.append(piece);
  }
  return burst;
}

const SCENES = {
  about() {
    const floaters = [["smile", -150, -90, 0], ["note", 150, -70, 0.4], ["star", -130, 100, 0.8], ["chat", 140, 110, 1.2]].map(([name, x, y, delay]) => {
      const chip = el("span", { class: "scene-floater" }, icon(name));
      chip.style.setProperty("--x", `${x}px`);
      chip.style.setProperty("--y", `${y}px`);
      chip.style.setProperty("--delay", `${delay}s`);
      return chip;
    });
    return el("div", { class: "scene scene-about" }, ...floaters,
      el("div", { class: "scene-tag" }, el("div", { class: "scene-tag-head" }, el("strong", { text: "HELLO" }), el("small", { text: "my name is" })),
        el("div", { class: "scene-tag-body" }, el("span", { class: "scene-name", text: "…" }))));
  },

  meet() {
    const orbit = el("div", { class: "scene-orbit" });
    ["tab", "note", "download", "chat", "search", "workspace"].forEach((name, position, all) => {
      const planet = el("span", { class: "scene-planet" }, icon(name));
      planet.style.setProperty("--angle", `${(360 / all.length) * position}deg`);
      orbit.append(planet);
    });
    return el("div", { class: "scene scene-meet" }, el("div", { class: "scene-ring" }), el("div", { class: "scene-ring small" }), orbit);
  },

  moveIn() {
    const items = [["bookmark", "Bookmarks"], ["history", "History"], ["key", "Passwords"], ["tab", "Tabs"], ["bookmark", ""], ["history", ""]];
    return el("div", { class: "scene scene-import" },
      windowFrame("Your old browser", el("div", { class: "scene-lines" }, el("i"), el("i"), el("i"))),
      el("div", { class: "scene-flight" }, items.map(([name, label], position) => chip(name, label, position * 0.55))),
      windowFrame("Lima", el("div", { class: "scene-shelf" }, el("i"), el("i"), el("i"), el("i"))));
  },

  default() {
    const apps = [["inbox", "Mail"], ["chat", "Messages"], ["note", "Notes"], ["hash", "Slack"]];
    return el("div", { class: "scene scene-default" },
      el("div", { class: "scene-apps" }, apps.map(([name, label], position) => {
        const tile = el("span", { class: "scene-app" }, icon(name), el("small", { text: label }));
        tile.style.setProperty("--delay", `${position * 0.7}s`);
        return tile;
      })),
      el("div", { class: "scene-links" }, apps.map((_, position) => chip("link", "", position * 0.7))),
      el("div", { class: "scene-target" }, el("span", { class: "scene-target-mark" }), el("span", { class: "scene-target-check" }, icon("check"))));
  },

  ai() {
    return el("div", { class: "scene scene-ai" },
      Object.entries(PROVIDERS).map(([id, name], position) => {
        const card = el("div", { class: "scene-provider", "data-provider": id },
          el("span", { class: "scene-provider-icon" }, icon(id === "opencode" ? "braces" : id === "codex" ? "terminal" : "spark")),
          el("strong", { text: name }), el("span", { class: "scene-provider-state" }, icon("check")));
        card.style.setProperty("--delay", `${position * 0.12}s`);
        return card;
      }),
      el("div", { class: "scene-scan" }));
  },

  search() {
    const typed = el("span", { class: "scene-typed" });
    const rows = el("div", { class: "scene-results" });
    const panel = el("div", { class: "scene-search" },
      el("div", { class: "scene-search-field" }, el("span", { class: "scene-search-mark" }), typed, el("span", { class: "scene-caret" })), rows);
    const demos = [
      { text: "github.com", rows: [["globe", "github.com", "Open Website"], ["search", "github.com", "Search"]] },
      { text: "launch notes", rows: [["search", "launch notes", "Search"], ["note", "Launch notes", "Open"], ["tab", "Launch plan — Docs", "Switch"]] },
      { text: "what is a cron job?", rows: [["search", "what is a cron job?", "Search"], ["spark", "Ask Lima", "Ask"]] },
    ];
    let demo = 0;
    let timer = null;
    const play = () => {
      if (!panel.isConnected && demo) return;
      const { text, rows: list } = demos[demo++ % demos.length];
      typed.textContent = "";
      rows.replaceChildren();
      if (quiet()) {
        typed.textContent = text;
        rows.replaceChildren(...list.map((row, position) => resultRow(...row, position)));
        return;
      }
      let letter = 0;
      const typeNext = () => {
        if (!panel.isConnected) return;
        typed.textContent = text.slice(0, ++letter);
        if (letter < text.length) timer = setTimeout(typeNext, 55 + Math.random() * 60);
        else {
          rows.replaceChildren(...list.map((row, position) => resultRow(...row, position)));
          timer = setTimeout(play, 2600);
        }
      };
      timer = setTimeout(typeNext, 350);
    };
    const resultRow = (name, label, action, position) => {
      const row = el("div", { class: position === 0 ? "scene-row selected" : "scene-row" }, icon(name), el("span", { text: label }),
        position === 0 ? el("small", { text: `↩ ${action}` }) : null);
      row.style.setProperty("--delay", `${position * 0.08}s`);
      return row;
    };
    setTimeout(play, 0);
    window.addEventListener("pagehide", () => clearTimeout(timer), { once: true });
    return el("div", { class: "scene scene-searching" },
      el("div", { class: "scene-keys" }, el("kbd", { text: "⌘" }), el("kbd", { text: "T" })), panel);
  },

  workspace() {
    const row = (name, label, depth, delay, extra = "") => {
      const node = el("div", { class: `scene-folder-row ${extra}` }, icon(name), el("span", { text: label }));
      node.style.setProperty("--depth", depth);
      node.style.setProperty("--delay", `${delay}s`);
      return node;
    };
    const lead = companion("agent-avatar");
    const helper = companion("agent-avatar");
    helper.dataset.variant = "explorer";
    setCompanionState(lead, "delegate");
    setCompanionState(helper, "read");
    return el("div", { class: "scene scene-workspace" },
      el("div", { class: "scene-sidebar" },
        row("workspace", "Launch research", 0, 0, "lead"),
        row("chat", "Chat", 1, 0.35),
        row("note", "Findings", 1, 0.55),
        row("folder", "Tabs", 1, 0.75),
        row("agents", "Agents", 1, 0.95),
        row("spark", "pricing-scout", 2, 1.25, "helper")),
      el("div", { class: "scene-handoff" }, lead, el("span", { class: "scene-baton" }, icon("note")), helper));
  },

  ready() {
    return el("div", { class: "scene scene-ready" }, el("div", { class: "scene-rays" }, Array.from({ length: 12 }, (_, n) => {
      const ray = el("i");
      ray.style.setProperty("--angle", `${n * 30}deg`);
      return ray;
    })), confetti(48));
  },
};
