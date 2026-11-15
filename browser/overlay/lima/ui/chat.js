/* AI chat tab. One conversation per URL (about:lima?chat=<id>), so chats
 * are pinnable, bookmarkable and restored with the session. */
import { bar, bridge, call, el, errorText, markdown, onEvent, prefs, relativeTime, setPage } from "./lib.js";

const PROVIDERS = ["claude", "codex", "opencode"];
const FAILURE_HELP = {
  missing_executable: "CLI not installed",
  authentication: "Sign-in needed",
  model_rejected: "Model unavailable",
  incompatible_version: "CLI version incompatible",
  connection: "Connection problem",
  rate_limited: "Rate limited",
  process_crashed: "CLI stopped unexpectedly",
  cancelled: "Stopped",
  unknown: "Failed",
};

export async function renderChat(app, chatId, initialPrompt) {
  setPage("AI Chat", "chat");
  if (!chatId || chatId === "new") {
    const provider = prefs.get("provider", "claude");
    const conversation = await call("chat.create", { provider });
    if (initialPrompt) await call("chat.send", { id: conversation.id, text: initialPrompt });
    bridge.replaceURL(`about:lima?chat=${encodeURIComponent(conversation.id)}`);
    return;
  }
  mountChat(app, chatId);
}

async function mountChat(app, chatId) {
  let conversation;
  const list = el("div", { class: "chat-list" });
  const messages = el("div", { class: "messages" });
  const providerSelect = el("select", { "aria-label": "CLI" }, PROVIDERS.map(p => el("option", { value: p, text: p })));
  const modelSelect = el("select", { "aria-label": "Model" });
  const input = el("textarea", { placeholder: "Ask or give a task…  (Enter to send, Shift+Enter for a new line)", rows: 2 });
  const sendButton = el("button", { class: "primary", onclick: send }, "Send");
  const stopButton = el("button", { onclick: () => call("chat.cancel", { id: chatId }), hidden: true }, "Stop");
  const draftKey = `draft.${chatId}`;
  input.value = prefs.get(draftKey, "");

  app.replaceChildren(
    bar("AI Chat", el("button", { onclick: () => bridge.openTab("about:lima?chat=new") }, "New Chat")),
    el("div", { class: "chat" }, list,
      el("div", { class: "chat-main" }, messages,
        el("div", { class: "composer" }, el("div", { class: "composer-box" }, input,
          el("div", { class: "row", style: { justifyContent: "space-between" } },
            el("div", { class: "row" }, providerSelect, modelSelect),
            el("div", { class: "row" }, stopButton, sendButton))))))
  );

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

  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", () => prefs.set(draftKey, input.value));

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    prefs.set(draftKey, "");
    try {
      conversation = await call("chat.send", { id: chatId, text });
      draw();
    } catch (error) {
      input.value = text; // never lose the draft
      messages.append(el("div", { class: "notice bad", text: errorText(error) }));
    }
  }

  function draw() {
    if (!conversation) return;
    setPage(conversation.title, "chat");
    providerSelect.value = conversation.provider;
    const running = conversation.messages.some(m => m.status === "streaming");
    stopButton.hidden = !running;
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    messages.replaceChildren(...conversation.messages.map(messageNode));
    if (!conversation.messages.length) messages.append(el("p", { class: "muted", style: { textAlign: "center", marginTop: "20vh" }, text: `Chat with ${conversation.provider}. Replies run through the installed CLI.` }));
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  function messageNode(message) {
    const node = el("div", { class: `msg ${message.role}`, "data-id": message.id });
    const meta = el("div", { class: "meta" }, message.role === "user" ? "You" : conversation.provider, message.status === "queued" ? el("span", { class: "badge", text: "queued" }) : null);
    if (message.role === "user") {
      meta.append(el("button", { class: "ghost", title: "Edit and resend", onclick: () => edit(message, node) }, "Edit"));
      node.append(meta, el("div", { class: "bubble", text: message.text }));
      return node;
    }
    node.append(meta);
    if (message.tools.length) node.append(el("div", { class: "tools" }, message.tools.map(t => el("div", { text: `↳ ${t}` }))));
    const body = markdown(message.text);
    if (message.status === "streaming") body.classList.add("typing");
    node.append(body);
    if (message.status === "failed" && message.error) {
      node.append(el("div", { class: "failure" },
        el("strong", { text: FAILURE_HELP[message.error.kind] ?? "Failed" }),
        el("span", { class: "grow", text: message.error.message }),
        message.error.kind === "cancelled" ? null : el("button", { onclick: () => call("chat.retry", { id: chatId, messageId: message.id }).then(c => { conversation = c; draw(); }) }, "Retry")));
    } else if (message.status === "complete" && message.text) {
      node.append(el("div", { class: "row" }, el("button", { class: "ghost", onclick: () => bridge.copy(message.text) }, "Copy")));
    }
    return node;
  }

  function edit(message, node) {
    const area = el("textarea", { rows: 3, style: { width: "100%" } });
    area.value = message.text;
    node.replaceChildren(area, el("div", { class: "row" },
      el("button", { class: "primary", onclick: async () => {
        try { conversation = await call("chat.edit", { id: chatId, messageId: message.id, text: area.value }); draw(); }
        catch (error) { node.append(el("p", { class: "error", text: errorText(error) })); }
      } }, "Resend"),
      el("button", { onclick: draw }, "Cancel")));
    area.focus();
  }

  async function drawList() {
    const conversations = await call("chat.list");
    list.replaceChildren(el("ul", { class: "list" }, conversations.map(c => el("li", {
      class: "clickable", style: c.id === chatId ? { background: "var(--surface-2)" } : {},
      onclick: () => bridge.openTab(`about:lima?chat=${encodeURIComponent(c.id)}`),
    }, el("span", { class: "grow", text: c.title }), c.running ? el("span", { class: "badge warn", text: "…" }) : el("span", { class: "muted", style: { fontSize: "11px" }, text: relativeTime(c.updatedAt) })))));
  }

  onEvent(message => {
    if (message.event === "chat.delta" && message.data.conversationId === chatId) {
      const target = conversation?.messages.find(m => m.id === message.data.messageId);
      if (target) { target.text += message.data.text; draw(); }
    } else if (message.event === "chat.updated") {
      if (message.data.id === chatId) { conversation = message.data; draw(); }
      drawList();
    }
  });

  try {
    conversation = await call("chat.get", { id: chatId });
  } catch (error) {
    messages.replaceChildren(el("p", { class: "error", text: `Conversation unavailable: ${errorText(error)}` }));
    return;
  }
  draw();
  drawList();
  loadModels();
  input.focus();
}
