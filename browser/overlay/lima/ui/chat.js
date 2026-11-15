/* AI chat tab: one conversation per URL (about:lima?chat=<id>). For a
 * workspace or helper agent it is the agent's chat; a live line says where
 * the agent is working (the sidebar shows the same with the prism). */
import { bridge, call, el, errorText, icon, markdown, onEvent, prefs, setPage } from "./lib.js";

const PROVIDERS = ["claude", "codex", "opencode"];
const FAILURE_HELP = {
  missing_executable: "CLI not installed", authentication: "Sign-in needed", model_rejected: "Model unavailable",
  incompatible_version: "CLI version incompatible", connection: "Connection problem", rate_limited: "Rate limited",
  process_crashed: "CLI stopped unexpectedly", cancelled: "Stopped", unknown: "Failed",
};
const STAR = "resource://lima-ui/marks/star-prism.svg";

export async function renderChat(app, chatId, initialPrompt) {
  setPage("AI Chat", STAR);
  if (!chatId || chatId === "new") {
    const conversation = await call("chat.create", { provider: prefs.get("provider", "claude") });
    if (initialPrompt) await call("chat.send", { id: conversation.id, text: initialPrompt });
    bridge.replaceURL(`about:lima?chat=${encodeURIComponent(conversation.id)}`);
    return;
  }
  mountChat(app, chatId);
}

/** The agent's own bookkeeping (tool lookup, todo lists) isn't a step. */
const visibleTools = tools => tools.filter(tool => !/^(ToolSearch|TodoWrite)\b/.test(tool));

/** "mcp__lima__workspace_open_tab: {json}" → "Opened example.com". */
function toolLabel(raw) {
  const [name, ...rest] = raw.replace(/^mcp__lima__/, "").split(": ");
  let detail = rest.join(": ");
  // CLIs pass the arguments as (sometimes truncated) JSON: pick the telling field.
  const field = /"(url|command|title|name|path)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(detail);
  if (field) {
    const value = field[2].replace(/\\\//g, "/").replace(/\\"/g, '"');
    try { detail = /^https?:/.test(value) ? new URL(value).host + new URL(value).pathname.replace(/\/$/, "") : value; } catch { detail = value; }
  } else if (detail.startsWith("{")) detail = "";
  if (detail.length > 70) detail = `${detail.slice(0, 67)}…`;
  const nice = { workspace_open_tab: "Opened", workspace_read_tab: "Read", workspace_run: "Ran", workspace_note: "Wrote note",
    workspace_bookmark: "Bookmarked", workspace_list_tabs: "Looked at tabs", workspace_files: "Listed files", agent_spawn: "Spawned",
    agents_status: "Checked agents", workspace_info: "Looked at workspace" }[name];
  return `${nice ?? name}${detail ? ` ${detail}` : ""}`;
}

async function mountChat(app, chatId) {
  let conversation;
  let workspace = null;
  const messages = el("div", { class: "messages", role: "log" });
  const now = el("div", { class: "agent-now", hidden: true });
  const providerSelect = el("select", { "aria-label": "CLI" }, PROVIDERS.map(p => el("option", { value: p, text: p })));
  const modelSelect = el("select", { "aria-label": "Model" });
  const input = el("textarea", { placeholder: "Message…", rows: 1 });
  const sendButton = el("button", { class: "send", title: "Send (↩)", onclick: send }, "Send");
  const stopButton = el("button", { class: "send stop", title: "Stop the reply", onclick: () => call("chat.cancel", { id: chatId }), hidden: true }, "Stop");
  const title = el("h1", { class: "chat-title" });
  const subtitle = el("div", { class: "chat-sub" });
  const stateBadge = el("span", { class: "badge" });
  const draftKey = `draft.${chatId}`;
  input.value = prefs.get(draftKey, "");

  // Modules: Chat (conversation + composer) | Steps · Agents · Files.
  const chatTab = el("span", { class: "tab" }, "Chat");
  const steps = el("ol", { class: "steps" });
  const counted = (label, n) => [label, n ? el("span", { class: "count", text: String(n) }) : null].filter(Boolean);
  const stepsTab = el("span", { class: "tab" }, "Steps");
  const agentsTab = el("span", { class: "tab" }, "Agents");
  const filesTab = el("span", { class: "tab" }, "Files");
  const agents = el("ul", { class: "list" });
  const files = el("ul", { class: "list" });
  const side = el("aside", { class: "chat-side" },
    el("section", { class: "mod" }, el("div", { class: "mod-head" }, stepsTab), steps),
    el("section", { class: "mod", hidden: true }, el("div", { class: "mod-head" }, agentsTab), agents),
    el("section", { class: "mod", hidden: true }, el("div", { class: "mod-head" }, filesTab,
), files));
  const body = el("div", { class: "chat-body solo" },
    el("section", { class: "chat-main" }, el("div", { class: "mod-head" }, chatTab), messages,
      el("div", { class: "composer" }, now,
        el("div", { class: "composer-box" }, input,
          el("div", { class: "composer-row" }, providerSelect, modelSelect, el("span", { class: "spacer" }), stopButton, sendButton)))),
    side);
  app.replaceChildren(el("div", { class: "chat-page" },
    el("header", { class: "chat-head" }, el("img", { class: "chat-star", src: STAR, alt: "" }), title, stateBadge, subtitle),
    body));

  const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(220, input.scrollHeight)}px`; };
  input.addEventListener("input", () => { prefs.set(draftKey, input.value); autosize(); });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  async function loadModels() {
    const models = await call("agents.models", { provider: providerSelect.value }).catch(() => [{ id: "default", label: "CLI default" }]);
    modelSelect.replaceChildren(...models.map(m => el("option", { value: m.id, text: m.label })));
    modelSelect.value = conversation?.model && models.some(m => m.id === conversation.model) ? conversation.model : "default";
  }
  providerSelect.addEventListener("change", async () => {
    prefs.set("provider", providerSelect.value);
    await loadModels();
    conversation = await call("chat.configure", { id: chatId, provider: providerSelect.value, model: modelSelect.value });
  });
  modelSelect.addEventListener("change", async () => {
    conversation = await call("chat.configure", { id: chatId, provider: providerSelect.value, model: modelSelect.value });
  });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    autosize();
    prefs.set(draftKey, "");
    try {
      conversation = workspace && !workspace.parentID
        ? await call("workspace.instruct", { id: workspace.id, text })
        : await call("chat.send", { id: chatId, text });
      draw();
    } catch (error) {
      input.value = text; // never lose the draft
      messages.append(el("div", { class: "notice bad", text: errorText(error) }));
    }
  }

  function draw() {
    if (!conversation) return;
    const name = workspace?.name ?? conversation.title;
    setPage(workspace ? "Chat" : conversation.title, STAR);
    title.textContent = name;
    const folder = workspace?.directory.split("/").filter(Boolean).pop();
    subtitle.textContent = workspace?.parentID ? `Helper · ${workspace.task ?? ""}` : [conversation.provider, conversation.model && conversation.model !== "default" ? conversation.model : null, folder].filter(Boolean).join(" · ");
    subtitle.title = workspace?.directory ?? "";
    providerSelect.value = conversation.provider;
    const running = conversation.messages.some(m => m.status === "streaming");
    const failed = !running && conversation.messages.at(-1)?.status === "failed";
    stateBadge.className = running ? "badge warn" : failed ? "badge bad" : "badge";
    stateBadge.textContent = running ? "writing" : failed ? "failed" : "idle";
    stopButton.hidden = !running;
    sendButton.hidden = running;
    chatTab.replaceChildren(...(running ? [el("i", { class: "live" }), "Chat · writing"] : ["Chat"]));
    drawSteps();
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    messages.replaceChildren(...conversation.messages.map(messageNode));
    if (!conversation.messages.length) {
      messages.append(el("div", { class: "chat-empty" },
        el("p", { text: workspace ? "Tell the agent what to do. It opens pages in Tabs, works in the Terminal, writes notes, and can spawn helper agents — all in the sidebar." : `Chat with ${conversation.provider}.` })));
    }
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  function messageNode(message) {
    if (message.role === "user") {
      return el("div", { class: "msg user" }, el("div", { class: "bubble", text: message.text }),
        el("button", { class: "ghost edit", title: "Edit and resend", onclick: e => edit(message, e.currentTarget.parentElement) }, "Edit"));
    }
    const node = el("div", { class: "msg assistant" });
    const shownTools = visibleTools(message.tools);
    if (shownTools.length) {
      const details = el("details", { class: "tools" }, el("summary", { text: `${shownTools.length} step${shownTools.length === 1 ? "" : "s"} · ${toolLabel(shownTools.at(-1))}` }),
        ...shownTools.map(t => el("div", { text: toolLabel(t) })));
      node.append(details);
    }
    const body = markdown(message.text);
    if (message.status === "streaming") body.classList.add("typing");
    node.append(body);
    if (message.status === "failed" && message.error) {
      node.append(el("div", { class: "failure" },
        el("strong", { text: FAILURE_HELP[message.error.kind] ?? "Failed" }),
        el("span", { class: "grow", text: message.error.message }),
        message.error.kind === "cancelled" ? null : el("button", { onclick: () => call("chat.retry", { id: chatId, messageId: message.id }).then(c => { conversation = c; draw(); }) }, "Retry")));
    } else if (message.status === "complete" && message.text) {
      node.append(el("button", { class: "ghost copy", onclick: () => bridge.copy(message.text) }, icon("copy"), "Copy"));
    }
    return node;
  }

  function edit(message, node) {
    const area = el("textarea", { rows: 3 });
    area.value = message.text;
    node.replaceChildren(area, el("div", { class: "row" },
      el("button", { class: "primary", onclick: async () => {
        try { conversation = await call("chat.edit", { id: chatId, messageId: message.id, text: area.value }); draw(); }
        catch (error) { node.append(el("p", { class: "error", text: errorText(error) })); }
      } }, "Resend"),
      el("button", { onclick: draw }, "Cancel")));
    area.focus();
  }

  // Steps: every tool call, timestamped by its reply; nothing disappears.
  function drawSteps() {
    const rows = [];
    for (const message of conversation.messages) {
      if (message.role !== "assistant") continue;
      const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      visibleTools(message.tools).forEach((tool, i, tools) => {
        const current = message.status === "streaming" && i === tools.length - 1;
        rows.push(el("li", { class: current ? "now" : message.status === "failed" ? "failed" : "" }, el("time", { text: time }), el("span", { text: toolLabel(tool), title: tool })));
      });
    }
    stepsTab.replaceChildren(...counted("Steps", rows.length));
    steps.replaceChildren(...(rows.length ? rows.slice(-40) : [el("li", { class: "muted" }, el("time", { text: "" }), el("span", { text: "Tool calls appear here as the agent works." }))]));
    steps.lastElementChild?.scrollIntoView?.({ block: "nearest" });
  }

  async function drawWorkspaceModules() {
    if (!workspace) return;
    body.classList.remove("solo");
    const [all, chats] = await Promise.all([call("workspace.list").catch(() => []), call("chat.list").catch(() => [])]);
    const running = new Set(chats.filter(c => c.running).map(c => c.id));
    const helpers = all.filter(w => w.parentID === workspace.id);
    agents.parentElement.hidden = !helpers.length;
    agentsTab.replaceChildren(...counted("Agents", helpers.length));
    agents.replaceChildren(...helpers.map(h => el("li", { class: "clickable", onclick: () => bridge.openTab(`about:lima?chat=${encodeURIComponent(h.conversationID)}`) },
      el("span", { class: "grow", text: h.name, title: h.task ?? "" }),
      el("span", { class: running.has(h.conversationID) ? "badge warn" : "badge", text: running.has(h.conversationID) ? "working" : "idle" }))));
    const entries = await call("fs.list", { path: workspace.directory }).catch(() => []);
    files.parentElement.hidden = false;
    filesTab.replaceChildren(...counted("Files", entries.length));
    files.replaceChildren(...(entries.length ? entries.slice(0, 30).map(f => el("li", {}, icon(f.directory ? "folder" : "file"), el("span", { class: "grow", text: f.name })))
      : [el("li", { class: "muted", text: "Empty folder" })]));
  }

  function paintNow(state) {
    const text = !state || state.surface === "idle" ? "" : state.surface === "chat" ? "Writing…"
      : state.surface === "terminal" ? "Working in the terminal" : `Reading ${state.url?.startsWith("about:lima?note=") ? "a note" : (() => { try { return new URL(state.url).host; } catch { return "a tab"; } })()}`;
    now.hidden = !text;
    now.replaceChildren(el("span", { class: "now-star" }), text);
  }

  onEvent(message => {
    const data = message.data;
    if (message.event === "chat.delta" && data.conversationId === chatId) {
      const target = conversation?.messages.find(m => m.id === data.messageId);
      if (target) { target.text += data.text; draw(); }
    } else if (message.event === "chat.updated" && data.id === chatId) {
      conversation = data; draw();
    } else if (message.event === "workspace.activity" && data.id === workspace?.id) {
      paintNow(data);
    } else if (message.event === "workspace.updated" && data.id === workspace?.id) {
      workspace = data; draw(); drawWorkspaceModules();
    } else if (workspace && ["workspace.created", "workspace.deleted"].includes(message.event)) {
      drawWorkspaceModules();
    } else if (workspace && message.event === "terminal.command") {
      drawWorkspaceModules();
    }
  });

  try {
    conversation = await call("chat.get", { id: chatId });
  } catch (error) {
    messages.replaceChildren(el("p", { class: "error", text: `Conversation unavailable: ${errorText(error)}` }));
    return;
  }
  if (conversation.workspaceID) {
    workspace = await call("workspace.get", { id: conversation.workspaceID }).catch(() => null);
    call("workspace.activity").then(all => paintNow(all[conversation.workspaceID])).catch(() => {});
  }
  draw();
  drawWorkspaceModules();
  loadModels();
  autosize();
  input.focus();
}
