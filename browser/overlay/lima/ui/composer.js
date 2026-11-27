import { bridge, call, el, errorText, icon, prefs } from "./lib.js";

export const PROVIDERS = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

async function storedPreferences() {
  const remote = await bridge.browser("agentPreferences", {}).catch(() => null);
  const fallback = Object.fromEntries(Object.keys(PROVIDERS).map(provider => [provider, prefs.get("model." + provider, "default")]));
  return remote ?? { provider: prefs.get("provider", "claude"), models: fallback };
}

/* Sending while a reply runs: ↩ queues the message to run after it (in
 * order); ⌘↩ stops the reply, keeping what it wrote, and sends at once. */
export const sendMode = event => (event?.metaKey || event?.ctrlKey ? "interrupt" : "queue");

export const QUEUE_HINT = "↩ queues it for after this reply · ⌘↩ stops the reply and sends now";

/** A queued message's row: send it now, or take it back to edit. */
export function queuedActions({ interrupt, edit }) {
  const act = (label, title, run) => el("button", { class: "ghost", title, onclick: async event => {
    event.currentTarget.disabled = true;
    try { await run(); } finally { if (event.currentTarget) event.currentTarget.disabled = false; }
  } }, label);
  return el("div", { class: "queued-actions" },
    el("span", { class: "queued-label" }, icon("history"), "Queued · sends after this reply"),
    act("Send now", "Stop the current reply and send this now", interrupt),
    act("Edit", "Take it back into the message box", edit));
}

/** Puts text that never ran back in front of the user's draft. */
export function restoreDraft(input, texts) {
  const restored = [...texts, input.value.trim()].filter(Boolean).join("\n\n");
  input.value = restored;
  input.dispatchEvent(new Event("input"));
}

export async function preferredAgent() {
  const [stored, connected] = await Promise.all([storedPreferences(), call("agents.configured").catch(() => [])]);
  const provider = connected.includes(stored.provider) ? stored.provider : connected[0];
  if (!provider) throw new Error("Connect an AI provider in Lima Settings.");
  return { provider, model: stored.models[provider] ?? "default", effort: prefs.get("effort", "default") };
}

export function agentControls({ onChange, onError } = {}) {
  const provider = el("select", { "aria-label": "Provider" }, el("option", { text: "Checking providers…" }));
  const model = el("select", { "aria-label": "Model" });
  // How hard the model thinks on each turn: the levels the chosen model
  // accepts, as its CLI lists them (none for a model without the setting).
  const effort = el("select", { "aria-label": "Effort", title: "How hard the model thinks: higher is slower and more thorough" },
    el("option", { value: "default", text: "Effort: default" }));
  let catalog = [];
  const sameOptions = (select, items) => select.options.length === items.length
    && items.every((item, index) => select.options[index].value === item.value && select.options[index].text === item.text);
  /** Replaces a menu's choices only when they changed, so an open menu keeps its list. */
  function setOptions(select, items, value) {
    if (!sameOptions(select, items)) select.replaceChildren(...items.map(item => el("option", item)));
    select.value = value;
  }
  function paintEfforts() {
    const entry = catalog.find(item => item.id === selected.model) ?? catalog.find(item => item.id === "default");
    const levels = entry?.efforts ?? [];
    if (selected.effort !== "default" && !levels.some(level => level.id === selected.effort)) selected.effort = "default";
    const fallback = levels.find(level => level.id === entry?.defaultEffort);
    setOptions(effort, [{ value: "default", text: "Effort: default" },
      ...levels.map(level => ({ value: level.id, text: `Effort: ${level.label}` }))], selected.effort);
    effort.title = `How hard the model thinks: higher is slower and more thorough.${fallback ? ` This model's default is ${fallback.label}.` : ""}`;
    effort.hidden = !levels.length;
  }
  let generation = 0;
  let selected = { provider: "", model: "default", effort: prefs.get("effort", "default") };
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
    selected = { provider: choice ?? "", model: choice === next.provider ? next.model ?? "default" : memory[choice] ?? "default",
      effort: next.effort ?? (Object.hasOwn(next, "messages") ? "default" : selected.effort ?? "default") };
    provider.replaceChildren(
      ...(!choice ? [el("option", { value: "", disabled: true, text: connected.length ? "Choose a provider" : "No connected providers" })] : []),
      ...connected.map(value => el("option", { value, text: PROVIDERS[value] })));
    provider.disabled = !connected.length;
    provider.value = selected.provider;
    model.disabled = !choice;
    // Until the list arrives, the current choice stands alone (only if the
    // menu has nothing yet: an open menu keeps the list it's showing).
    const placeholder = { value: selected.model, text: selected.model === "default" ? "CLI default" : selected.model };
    if (!model.options.length || model.dataset.provider !== selected.provider) setOptions(model, [placeholder], selected.model);
    if (!choice) { paintEfforts(); return false; }
    const available = await call("agents.models", { provider: selected.provider }).catch(() => []);
    if (turn !== generation) return false;
    catalog = [...available];
    if (!catalog.some(item => item.id === selected.model)) catalog.push({ id: selected.model, label: placeholder.text });
    const current = catalog.filter(item => !item.older);
    const older = catalog.filter(item => item.older);
    setOptions(model, [...current, ...older].map(item => ({ value: item.id, text: item.older ? `${item.label} (older)` : item.label })), selected.model);
    model.dataset.provider = selected.provider;
    paintEfforts();
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
    const before = selected.effort;
    paintEfforts();
    if (before !== selected.effort) prefs.set("effort", selected.effort);
    commit();
  });
  effort.addEventListener("change", () => {
    selected.effort = effort.value;
    prefs.set("effort", effort.value);
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
  // A provider or model added in Settings (or a CLI signed in elsewhere)
  // shows up here too: the lists reload when you come back to this tab or
  // open one of the menus.
  let refreshedAt = Date.now();
  const freshen = () => {
    if (Date.now() - refreshedAt < 3000 || !provider.isConnected) return;
    refreshedAt = Date.now();
    const current = settings();
    refresh(current.provider ? current : undefined, !current.provider).catch?.(() => {});
  };
  // Not when a menu opens: swapping its list as it opens left only one choice.
  addEventListener("focus", freshen);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) freshen(); });
  return { provider, model, effort, show, settings, ready, refresh, settled: () => changes };
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

// MARK: Attachments

const CHUNK = 1536 * 1024; // raw bytes per upload frame (2 MB as base64)
const LONG_PASTE = { characters: 4000, lines: 80 };

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const formatSize = bytes => bytes < 1000 ? `${bytes} B` : bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;

/** Files dropped or pasted into a composer: uploaded to the conversation as
 * they arrive, shown as chips (thumbnails for images), sent with the next
 * message. A very long paste becomes a text attachment instead of filling
 * the box. `conversation()` returns the chat's ID. */
export function attachmentTray({ conversation, input, onChange = () => {} }) {
  const node = el("div", { class: "attachment-tray", hidden: true });
  const items = [];

  function paint() {
    node.hidden = !items.length;
    node.replaceChildren(...items.map(item => item.chip));
    onChange();
  }

  function add(file, { label } = {}) {
    const item = { file, name: file.name || "attachment", type: file.type || "application/octet-stream", state: "uploading", result: null };
    const progress = el("i", { class: "attachment-progress" });
    const preview = file.type.startsWith("image/") ? el("img", { class: "attachment-thumb", alt: "", src: URL.createObjectURL(file) })
      : el("span", { class: "attachment-thumb file" }, icon(file.type.startsWith("text/") ? "paragraph" : "file"));
    item.chip = el("span", { class: "attachment-chip", "data-state": "uploading", title: item.name },
      preview, el("span", { class: "attachment-text" }, el("strong", { text: label ?? item.name }), el("small", { text: formatSize(file.size) })),
      progress,
      el("button", { type: "button", class: "attachment-remove", title: "Remove", "aria-label": `Remove ${item.name}`, onclick: () => {
        items.splice(items.indexOf(item), 1);
        if (preview.src?.startsWith("blob:")) URL.revokeObjectURL(preview.src);
        paint();
      } }, icon("close")));
    items.push(item);
    paint();
    upload(item, progress).then(() => { item.state = "ready"; item.chip.dataset.state = "ready"; onChange(); },
      error => { item.state = "failed"; item.chip.dataset.state = "failed"; item.chip.title = errorText(error); onChange(); });
  }

  async function upload(item, progress) {
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    if (bytes.length > 50 * 1024 * 1024) throw new Error("Attachments can be up to 50 MB.");
    let token;
    for (let offset = 0; offset < Math.max(bytes.length, 1); offset += CHUNK) {
      const done = offset + CHUNK >= bytes.length;
      const reply = await call("chat.attach", { id: conversation(), name: item.name, type: item.type, upload: token,
        data: base64(bytes.subarray(offset, offset + CHUNK)), done });
      token = reply.upload;
      progress.style.width = `${Math.round(Math.min(1, (offset + CHUNK) / Math.max(bytes.length, 1)) * 100)}%`;
      if (done) item.result = reply;
    }
  }

  function takeFiles(list) {
    const files = [...(list ?? [])].filter(file => file.size >= 0);
    for (const file of files.slice(0, 10)) add(file);
    return files.length > 0;
  }

  // Drop anywhere on the composer; paste files, images or very long text.
  const target = input.closest(".composer-box") ?? input;
  target.addEventListener("dragover", event => {
    if (![...event.dataTransfer.types].includes("Files")) return;
    event.preventDefault();
    target.classList.add("dropping");
  });
  target.addEventListener("dragleave", event => { if (!target.contains(event.relatedTarget)) target.classList.remove("dropping"); });
  target.addEventListener("drop", event => {
    target.classList.remove("dropping");
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    takeFiles(event.dataTransfer.files);
    input.focus();
  });
  input.addEventListener("paste", event => {
    if (event.clipboardData.files.length) {
      event.preventDefault();
      takeFiles(event.clipboardData.files);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text.length < LONG_PASTE.characters && text.split("\n").length < LONG_PASTE.lines) return;
    event.preventDefault();
    const lines = text.split("\n").length;
    add(new File([text], "Pasted text.txt", { type: "text/plain" }), { label: `Pasted text · ${lines} lines` });
  });

  return {
    node,
    /** Ready attachments for chat.send, or throws while one is still uploading. */
    ready() {
      if (items.some(item => item.state === "uploading")) throw new Error("Wait for attachments to finish uploading.");
      return items.filter(item => item.state === "ready").map(item => ({ path: item.result.path, type: item.result.type }));
    },
    get count() { return items.length; },
    get busy() { return items.some(item => item.state === "uploading"); },
    clear() {
      for (const item of items) { const img = item.chip.querySelector("img"); if (img?.src?.startsWith("blob:")) URL.revokeObjectURL(img.src); }
      items.length = 0;
      paint();
    },
  };
}

/** A chat's attachment, full size in Glance over the current tab. */
export function openAttachment(chatId, path) {
  const url = `about:lima?view=attachment&chat=${encodeURIComponent(chatId)}&path=${encodeURIComponent(path)}`;
  return bridge.browser("openGlance", { url }).catch(() => bridge.openTab(url));
}

const attachmentCache = new Map();
/** An attachment's contents as a data URL (cached per chat and file). */
export function attachmentURL(chatId, path) {
  const key = `${chatId}\n${path}`;
  if (!attachmentCache.has(key)) {
    attachmentCache.set(key, call("chat.attachment", { id: chatId, path })
      .then(file => ({ ...file, url: `data:${file.type};base64,${file.data}` }))
      .catch(error => { attachmentCache.delete(key); throw error; }));
  }
  return attachmentCache.get(key);
}

/** Attachment chips on a sent message: images show a thumbnail, and any
 * chip opens the file in Glance. */
export function sentAttachments(list, chatId) {
  if (!list?.length) return null;
  return el("div", { class: "attachment-tray sent" }, list.map(item => {
    const image = item.type?.startsWith("image/");
    const thumb = el("span", { class: "attachment-thumb file" }, icon(image ? "image" : item.type?.startsWith("text/") ? "paragraph" : "file"));
    if (image && chatId && (item.size ?? 0) <= 12e6) {
      attachmentURL(chatId, item.path).then(file => {
        thumb.replaceWith(el("img", { class: "attachment-thumb", alt: "", src: file.url }));
      }).catch(() => {});
    }
    const text = el("span", { class: "attachment-text" }, el("strong", { text: item.name }), el("small", { text: formatSize(item.size ?? 0) }));
    return chatId
      ? el("button", { type: "button", class: "attachment-chip", "data-state": "ready", title: `Open ${item.name}`,
        onclick: event => { event.stopPropagation(); openAttachment(chatId, item.path); } }, thumb, text)
      : el("span", { class: "attachment-chip", "data-state": "ready", title: item.path }, thumb, text);
  }));
}

/** about:lima?view=attachment: one file from a chat, full size (in Glance). */
export async function renderAttachment(app, chatId, path) {
  const name = path.split("/").pop();
  document.title = name;
  const status = el("p", { class: "muted", text: "Loading…" });
  const page = el("div", { class: "media-page attachment-page" }, status);
  app.replaceChildren(page);
  try {
    const file = await attachmentURL(chatId, path);
    let view;
    if (file.type.startsWith("image/")) view = el("img", { class: "media-full", alt: file.name, src: file.url });
    else if (file.type === "application/pdf") {
      const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
      view = el("iframe", { class: "attachment-frame", title: file.name, src: URL.createObjectURL(new Blob([bytes], { type: file.type })) });
    } else if (file.type.startsWith("text/") || file.type === "application/json") {
      const text = new TextDecoder().decode(Uint8Array.from(atob(file.data), char => char.charCodeAt(0)));
      view = el("pre", { class: "attachment-text-view", text: text.slice(0, 400000) });
    } else view = el("p", { class: "muted", text: `${file.name} · ${formatSize(file.size)} · Lima can't show this kind of file here.` });
    page.replaceChildren(el("h1", { class: "attachment-title", text: file.name }), view);
  } catch (error) { status.textContent = errorText(error); }
}
