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

/** "mcp__lima__workspace_open_tab: {json}" → "Opened example.com". */
function toolLabel(raw) {
  const [name, ...rest] = raw.replace(/^mcp__lima__/, "").split(": ");
  let detail = rest.join(": ");
  // CLIs pass the arguments as (sometimes truncated) JSON: pick the telling field.
  const field = /"(url|command|title|name|path)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(detail);
  if (field) {
    const value = field[2];
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
  const sendButton = el("button", { class: "send", title: "Send (↩)", onclick: send }, icon("send"));
  const stopButton = el("button", { class: "send stop", title: "Stop", onclick: () => call("chat.cancel", { id: chatId }), hidden: true }, icon("stop"));
  const title = el("h1", { class: "chat-title" });
  const subtitle = el("div", { class: "chat-sub" });
  const draftKey = `draft.${chatId}`;
  input.value = prefs.get(draftKey, "");

  app.replaceChildren(el("div", { class: "chat-page" },
    el("header", { class: "chat-head" }, el("img", { class: "chat-star", src: STAR, alt: "" }), el("div", {}, title, subtitle)),
    messages,
    el("div", { class: "composer" }, now,
      el("div", { class: "composer-box" }, input,
        el("div", { class: "composer-row" }, providerSelect, modelSelect, el("span", { class: "spacer" }), stopButton, sendButton)))));

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
    subtitle.textContent = workspace?.parentID ? `Helper agent · ${workspace.task ?? ""}` : workspace ? `Workspace agent · ${conversation.provider} · ${workspace.directory.replace(/^\/Users\/[^/]+/, "~")}` : conversation.provider;
    providerSelect.value = conversation.provider;
    const running = conversation.messages.some(m => m.status === "streaming");
    stopButton.hidden = !running;
    sendButton.hidden = running;
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
    if (message.tools.length) {
      const details = el("details", { class: "tools" }, el("summary", { text: `${message.tools.length} step${message.tools.length === 1 ? "" : "s"} · ${toolLabel(message.tools.at(-1))}` }),
        ...message.tools.map(t => el("div", { text: toolLabel(t) })));
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
      workspace = data; draw();
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
  loadModels();
  autosize();
  input.focus();
}
