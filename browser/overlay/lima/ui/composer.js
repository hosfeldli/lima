import { bridge, call, el, prefs } from "./lib.js";

export const PROVIDERS = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

async function storedPreferences() {
  const remote = await bridge.browser("agentPreferences", {}).catch(() => null);
  const fallback = Object.fromEntries(Object.keys(PROVIDERS).map(provider => [provider, prefs.get("model." + provider, "default")]));
  return remote ?? { provider: prefs.get("provider", "claude"), models: fallback };
}

export async function preferredAgent() {
  const [stored, connected] = await Promise.all([storedPreferences(), call("agents.configured").catch(() => [])]);
  const provider = connected.includes(stored.provider) ? stored.provider : connected[0];
  if (!provider) throw new Error("Connect an AI provider in Lima Settings.");
  return { provider, model: stored.models[provider] ?? "default" };
}

export function agentControls({ onChange, onError } = {}) {
  const provider = el("select", { "aria-label": "Provider" }, el("option", { text: "Checking providers…" }));
  const model = el("select", { "aria-label": "Model" });
  let generation = 0;
  let selected = { provider: "", model: "default" };
  let memory = {};
  let connected = [];
  const hydrate = () => Promise.all([storedPreferences(), call("agents.configured").catch(() => [])]).then(([store, available]) => {
    memory = { ...store.models, ...memory };
    connected = available.filter(item => Object.hasOwn(PROVIDERS, item));
    return store;
  });
  let hydration = hydrate();

  function settings() { return { ...selected }; }
  async function show(next, fallback = true) {
    const turn = ++generation;
    await hydration;
    if (turn !== generation) return false;
    const choice = connected.includes(next.provider) ? next.provider : fallback ? connected[0] : "";
    selected = { provider: choice ?? "", model: choice === next.provider ? next.model ?? "default" : memory[choice] ?? "default" };
    provider.replaceChildren(
      ...(!choice ? [el("option", { value: "", disabled: true, text: connected.length ? "Choose a provider" : "No connected providers" })] : []),
      ...connected.map(value => el("option", { value, text: PROVIDERS[value] })));
    provider.disabled = !connected.length;
    provider.value = selected.provider;
    model.disabled = !choice;
    model.replaceChildren(el("option", { value: selected.model, text: selected.model === "default" ? "CLI default" : selected.model }));
    if (!choice) return false;
    const available = await call("agents.models", { provider: selected.provider }).catch(() => []);
    if (turn !== generation) return false;
    const models = [...available];
    if (!models.some(item => item.id === selected.model)) models.push({ id: selected.model, label: selected.model === "default" ? "CLI default" : selected.model });
    model.replaceChildren(...models.map(item => el("option", { value: item.id, text: item.label })));
    model.value = selected.model;
    return true;
  }

  let changes = Promise.resolve();
  function commit(choice = settings()) {
    memory[choice.provider] = choice.model;
    prefs.set("provider", choice.provider);
    prefs.set("model." + choice.provider, choice.model);
    changes = changes.then(async () => {
      await bridge.browser("rememberAgent", choice).catch(() => {});
      await onChange?.(choice);
    }).catch(error => onError?.(error));
  }
  provider.addEventListener("change", () => {
    const next = provider.value;
    const choice = { provider: next, model: memory[next] ?? "default" };
    if (connected.includes(next)) {
      selected = choice;
      commit(choice);
      show(choice);
    }
  });
  model.addEventListener("change", () => {
    selected.model = model.value;
    commit();
  });
  const ready = hydration.then(store => {
    if (generation) return;
    return show({ provider: store.provider, model: memory[store.provider] ?? "default" });
  });
  async function refresh(next, fallback = true) {
    hydration = hydrate();
    const store = await hydration;
    return show(next ?? { provider: selected.provider || store.provider, model: memory[selected.provider || store.provider] }, fallback);
  }
  return { provider, model, show, settings, ready, refresh, settled: () => changes };
}

const COMMANDS = [
  { value: "/skills", label: "Skills", description: "View available provider skills", category: "skills" },
  { value: "/mcp", label: "MCP servers", description: "View configured servers", category: "mcp" },
  { value: "/settings", label: "Settings", description: "View available provider settings", category: "settings" },
];

export function composerMenu(input, load) {
  const menu = el("div", { class: "composer-menu", role: "listbox", "aria-label": "Chat resources", hidden: true });
  let options = [];
  let current = 0;
  let query;
  let request = 0;

  function hide() {
    request++;
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function draw(rows) {
    options = rows;
    current = 0;
    menu.replaceChildren(...rows.map((row, index) => el("button", {
      type: "button", role: "option", "aria-selected": String(index === 0),
      onmousedown: event => event.preventDefault(), onclick: () => choose(index),
    }, el("span", { text: row.label }), el("small", { text: row.description ?? "" }))));
    menu.hidden = !rows.length;
    input.setAttribute("aria-expanded", String(rows.length > 0));
  }

  async function refresh() {
    const text = input.value.slice(0, input.selectionStart);
    const match = /(?:^|\s)([\/@])([^\s]*)$/.exec(text);
    if (!match) { hide(); return; }
    const turn = ++request;
    const [, trigger, term] = match;
    query = { start: text.length - match[2].length - 1, end: text.length };
    const data = await load().catch(() => ({}));
    if (turn !== request) return;
    const matching = row => row.label.toLowerCase().includes(term.toLowerCase()) || row.value?.toLowerCase().includes(term.toLowerCase());
    const rows = trigger === "/" ? [
      ...COMMANDS,
      ...(data.skills ?? []).map(name => ({ value: "/" + name, label: "/" + name, description: "Skill" })),
    ] : [
      ...COMMANDS,
      ...(data.skills ?? []).filter(name => term && name.includes(term)).map(name => ({ value: "/" + name, label: "/" + name, description: "Skill" })),
      ...(data.files ?? []).map(name => ({ value: /\s/.test(name) ? '@"' + name + '"' : "@" + name, label: name, description: "File" })),
    ];
    const filtered = rows.filter(matching).slice(0, 12);
    if (filtered.length) draw(filtered); else hide();
  }

  async function showCategory(category) {
    const turn = ++request;
    const data = await load().catch(() => ({}));
    if (turn !== request) return;
    const rows = (data[category] ?? []).map(name => ({
      label: name, value: category === "skills" ? "/" + name : null, description: category === "mcp" ? "Configured" : "",
    }));
    draw(rows.length ? rows : [{ label: "No " + (category === "mcp" ? "configured MCP servers" : category) }]);
  }

  function choose(index) {
    const choice = options[index];
    if (!choice) return;
    if (choice.category) {
      input.setRangeText("", query.start, query.end, "end");
      query = { start: input.selectionStart, end: input.selectionStart };
      showCategory(choice.category);
    } else if (choice.value) {
      input.setRangeText(choice.value + " ", query.start, query.end, "end");
      hide();
    } else return;
    input.focus();
  }

  input.addEventListener("input", refresh);
  input.addEventListener("keydown", event => {
    if (menu.hidden || event.isComposing) return;
    if (event.key === "Escape") { hide(); event.stopImmediatePropagation(); return; }
    if (event.key === "Enter" && !event.shiftKey && options[current]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      choose(current);
    } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      current = (current + options.length + (event.key === "ArrowDown" ? 1 : -1)) % options.length;
      for (const [index, row] of [...menu.children].entries()) row.setAttribute("aria-selected", String(index === current));
      menu.children[current]?.scrollIntoView({ block: "nearest" });
    }
  });
  input.addEventListener("blur", hide);
  return {
    node: menu,
    handle(text) {
      const command = COMMANDS.find(item => item.value === text);
      if (!command) return false;
      query = { start: 0, end: input.value.length };
      showCategory(command.category);
      return true;
    },
  };
}
