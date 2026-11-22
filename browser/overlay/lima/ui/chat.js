/* AI chat tab: one conversation per URL (about:lima?chat=<id>). For a
 * workspace or helper agent it is the agent's chat; a live line says where
 * the agent is working (the sidebar shows the same with the prism). */
import { activityStatus, bridge, call, el, errorText, filesPrivacyButton, icon, markdown, onEvent, prefs, setPage } from "./lib.js";
import { failureActivity, isFolderPermissionError, toolActivity } from "./tool-activity.sys.mjs";

import { agentControls, composerMenu, preferredAgent } from "./composer.js";
import { companion, MASCOTS, setCompanionState, watchVisualActivity } from "./companion.js";
import { workspacePrompts } from "./workspace-prompts.js";
const MASCOT = "resource://lima-ui/marks/companion.svg";

export async function renderChat(app, chatId, initialPrompt) {
  setPage("AI Chat", MASCOT);
  if (!chatId || chatId === "new") {
    const conversation = await call("chat.create", await preferredAgent());
    if (initialPrompt) await call("chat.send", { id: conversation.id, text: initialPrompt });
    bridge.replaceURL(`about:lima?chat=${encodeURIComponent(conversation.id)}`);
    return;
  }
  mountChat(app, chatId);
}

/** The agent's own bookkeeping (tool lookup, todo lists) isn't a step. */
const visibleTools = tools => tools.filter(tool => !/^(ToolSearch|TodoWrite)\b/.test(tool));

function toolLabel(raw) {
  const { label, detail, server } = toolActivity(raw);
  return [label, detail, server].filter(Boolean).join(" · ");
}

function toolRow(raw, active = false) {
  const { icon: glyph, kind } = toolActivity(raw);
  return el("span", { class: "tool-row", "data-motion": active ? kind : null },
    icon(glyph, "icon tool-glyph"), el("span", { text: toolLabel(raw) }));
}

export function mountChat(app, chatId, { compact = false } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  initializeChat(app, chatId, compact, signal);
  return () => controller.abort();
}

async function initializeChat(app, chatId, compact, signal) {
  let conversation;
  let workspace = null;
  let modulesRequest = 0;
  let helperChats = new Set();
  let helperVisuals = {};
  let shownTaskID;
  const messages = el("div", { class: "messages", role: "log" });
  const activity = activityStatus();
  const recovery = el("div", { class: "row chat-recovery", hidden: true });
  let lastStepList;
  let visualActivity;
  const messageElements = new Map();
  let pendingRequest = false;
  let loaded = false;
  let requestError;
  let eventRevision = 0;
  let deltaPaint = 0;
  const settledMessages = new Map();
  const input = el("textarea", { placeholder: "Message…", rows: 1, "aria-label": "Message" });
  const controls = agentControls({
    onChange: async choice => {
      conversation = await call("chat.configure", { id: chatId, ...choice });
      requestError = undefined;
      draw();
    },
    onError: reportError,
  });
  const completionMenu = composerMenu(input, async () => {
    await controls.settled();
    return call("chat.resources", { id: chatId });
  });
  const character = companion("chat-avatar");
  const mascot = el("select", { class: "chat-mascot-picker", "aria-label": "Chat mascot", title: "Chat mascot",
    onchange: async () => {
      const revision = eventRevision;
      try {
        const updated = await call("chat.mascot", { id: chatId, mascot: mascot.value });
        if (revision === eventRevision) conversation = updated;
        draw();
      } catch (error) { reportError(error); }
    },
  }, Object.entries(MASCOTS).map(([value, text]) => el("option", { value, text })));
  const prompts = workspacePrompts({ workspace: () => workspace?.id ?? "", signal });
  const sendButton = el("button", { class: "send", title: "Send (↩)", onclick: send, disabled: true }, "Send");
  const stopButton = el("button", { class: "send stop", title: "Stop the reply", onclick: () => call("chat.cancel", { id: chatId }).catch(reportError), hidden: true }, "Stop");
  const title = el("h1", { class: "chat-title", text: "AI Chat" });
  const subtitle = el("div", { class: "chat-sub" });
  const draftKey = `draft.${chatId}`;
  let sendFailed = false;
  input.value = prefs.get(draftKey, "");

  // One column. Chat, Task Progress, Agents, Activity and Files are views
  // inside this tab; nothing is pinned to the right of the conversation.
  const counted = (label, n) => [label, n ? el("span", { class: "count", text: String(n) }) : null].filter(Boolean);
  const steps = el("ol", { class: "steps" });
  const agents = el("ul", { class: "list" });
  const files = el("ul", { class: "list" });
  const progress = el("div", { class: "task-progress" });
  const views = { chat: messages, progress, agents, activity: steps, files };
  const viewTab = (name, label) => el("button", { class: "tab", role: "tab", "data-view": name, "aria-selected": String(name === "chat"),
    onclick: () => showView(name) }, label);
  const chatTab = viewTab("chat", "Chat");
  const progressTab = viewTab("progress", "Task Progress");
  const agentsTab = viewTab("agents", "Agents");
  const stepsTab = viewTab("activity", "Activity");
  const filesTab = viewTab("files", "Files");
  progressTab.hidden = agentsTab.hidden = filesTab.hidden = true;
  let currentView = "chat";
  function showView(name) {
    currentView = name;
    for (const tab of [chatTab, progressTab, agentsTab, stepsTab, filesTab]) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    for (const [key, node] of Object.entries(views)) node.hidden = key !== name;
    if (name === "progress") drawProgress();
  }
  for (const [key, node] of Object.entries(views)) { node.classList.add("chat-view"); node.hidden = key !== "chat"; }
  const body = el("div", { class: "chat-body solo" },
    el("section", { class: "chat-main" }, el("div", { class: "mod-head chat-views", role: "tablist" }, chatTab, progressTab, agentsTab, stepsTab, filesTab),
      messages, progress, agents, steps, files,
      el("div", { class: "composer" }, prompts.node, activity.node, recovery,
        el("div", { class: "composer-box" }, input, completionMenu.node,
          el("div", { class: "composer-row" }, controls.provider, controls.model, el("span", { class: "spacer" }), stopButton, sendButton)))));
  app.replaceChildren(el("div", { class: compact ? "chat-page assistant-chat" : "chat-page" },
    el("header", { class: "chat-head" }, character, title, subtitle, el("span", { class: "spacer" }), mascot),
    body));

  const autosize = () => { input.style.height = "auto"; input.style.height = `${Math.min(220, input.scrollHeight)}px`; };
  input.addEventListener("input", () => { prefs.set(draftKey, input.value); autosize(); });
  input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });

  async function send() {
    const text = input.value.trim();
    if (!text || !loaded || pendingRequest || completionMenu.handle(text) || !controls.settings().provider) return;
    requestError = undefined;
    sendFailed = false;
    pendingRequest = true;
    sendButton.disabled = true;
    paintNow();
    try {
      await controls.settled();
      const revision = eventRevision;
      const response = workspace && !workspace.parentID
        ? await call("workspace.instruct", { id: workspace.id, text })
        : await call("chat.send", { id: chatId, text });
      if (eventRevision === revision) conversation = response;
      if (input.value.trim() === text) {
        input.value = "";
        prefs.set(draftKey, "");
        autosize();
      }
    } catch (error) {
      // The draft stays in the composer; the conversation is untouched.
      requestError = error;
      sendFailed = true;
    } finally { pendingRequest = false; draw(); }
  }

  function runningReply() {
    return conversation?.messages.findLast(message => message.status === "streaming");
  }

  function reportError(error) {
    requestError = error;
    paintNow();
  }

  function draw() {
    cancelAnimationFrame(deltaPaint);
    deltaPaint = 0;
    if (!conversation) return;
    const name = workspace?.name ?? conversation.title;
    character.classList.toggle("workspace-chat-avatar", Boolean(conversation.workspaceID) && !compact);
    mascot.value = character.dataset.variant = conversation.mascot ?? "classic";
    prompts.draw();
    if (!compact) setPage(workspace ? "Chat" : conversation.title, MASCOT);
    title.textContent = name;
    const folder = workspace?.directory.split("/").filter(Boolean).pop();
    subtitle.textContent = workspace?.parentID ? `Helper · ${workspace.task ?? ""}` : [conversation.provider, conversation.model && conversation.model !== "default" ? conversation.model : null, folder].filter(Boolean).join(" · ");
    subtitle.title = workspace?.directory ?? "";
    const running = !!runningReply();
    stopButton.hidden = !running;
    sendButton.hidden = running;
    sendButton.disabled = !loaded || pendingRequest || !controls.settings().provider;
    // Status and Activity must never stop the transcript from rendering.
    try { drawSteps(); } catch (error) { console.error(error); }
    try { paintNow(); } catch (error) { console.error(error); }
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
    const ids = new Set(conversation.messages.map(message => message.id));
    for (const id of settledMessages.keys()) if (!ids.has(id)) settledMessages.delete(id);
    messageElements.clear();
    messages.replaceChildren(...conversation.messages.map(message => {
      if (message.role !== "assistant" || message.status !== "complete") {
        settledMessages.delete(message.id);
        const node = messageNode(message);
        messageElements.set(message.id, node);
        return node;
      }
      const entry = settledMessages.get(message.id);
      if (entry?.text === message.text) return entry.node;
      const node = messageNode(message);
      settledMessages.set(message.id, { text: message.text, node });
      return node;
    }));
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
    const shownTools = visibleTools(message.tools ?? []);
    if (shownTools.length) {
      const details = el("details", { class: "tools" }, el("summary", { text: `${shownTools.length} step${shownTools.length === 1 ? "" : "s"} · ${toolLabel(shownTools.at(-1))}` }),
        ...shownTools.map(t => el("div", {}, toolRow(t))));
      node.append(details);
    }
    const body = markdown(message.text, { onTaskToggle: () => {} });
    if (message.status === "streaming") body.classList.add("typing");
    node.append(body);
    if (message.status === "failed" && message.error) {
      node.append(el("div", { class: "failure" },
        el("strong", { text: message.error.kind === "cancelled" ? "Response interrupted" : failureActivity(message.error, "Reply failed").label }),
        el("span", { class: "grow", text: message.error.message }),
        message.error.kind === "cancelled" ? null : el("button", { onclick: async event => {
          event.currentTarget.disabled = true;
          requestError = undefined;
          const revision = eventRevision;
          try {
            const response = await call("chat.retry", { id: chatId, messageId: message.id });
            if (eventRevision === revision) conversation = response;
          }
          catch (error) { reportError(error); }
          draw();
        } }, "Retry Message")));
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
        const revision = eventRevision;
        try {
          const response = await call("chat.edit", { id: chatId, messageId: message.id, text: area.value });
          if (eventRevision === revision) conversation = response;
          draw();
        }
        catch (error) { node.append(el("p", { class: "error", text: errorText(error) })); }
      } }, "Resend"),
      el("button", { onclick: draw }, "Cancel")));
    area.focus();
  }

  // Task Progress: the Orchestrator's record for this workspace's latest
  // task: its state, helpers, dependencies, history and outcome.
  const TASK_STATES = {
    accepted: "Preparing your task…", planned: "Planned", queued: "Waiting for available capacity", waiting: "Waiting for dependencies",
    running: "Working", paused: "Work paused", blocked: "Needs you", verifying: "Verifying results…", completed: "Task completed",
    completed_with_warnings: "Done, with notes", failed: "Failed", canceled: "Stopped",
  };
  const TASK_DONE = new Set(["completed", "completed_with_warnings", "failed", "canceled"]);
  let progressRequest = 0;
  async function drawProgress() {
    if (!workspace || signal.aborted) return;
    const owner = workspace.parentID ?? workspace.id;
    const request = ++progressRequest;
    const records = await call("task.list", { workspaceId: owner, limit: 1 }).catch(error => { progress.replaceChildren(el("p", { class: "error", text: errorText(error) })); return null; });
    if (!records || signal.aborted || request !== progressRequest) return;
    const record = records[0];
    shownTaskID = record?.task.id;
    if (!record) {
      progress.replaceChildren(el("p", { class: "muted", text: "Tasks you hand to this workspace from the Companion appear here, with their agents and results." }));
      return;
    }
    const { task, children } = record;
    const events = task.events.slice(-12).reverse();
    const eventRows = items => el("ol", { class: "task-events" }, items.map(event => el("li", {},
      el("time", { text: new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }),
      el("span", { text: event.message }))));
    const names = new Map(children.map(child => [child.id, child.title]));
    const control = (label, method) => el("button", { class: "ghost", onclick: async () => {
      try { await call(method, { id: task.id }); drawProgress(); } catch (error) { reportError(error); }
    } }, label);
    progress.replaceChildren(
      el("section", { class: "task-card", "data-state": task.state },
        el("div", { class: "row" }, el("strong", { class: "grow", text: task.title }), el("span", { class: "badge", text: TASK_STATES[task.state] ?? task.state })),
        task.context?.length ? el("p", { class: "muted", text: task.context.join(" · ") }) : null,
        task.attention && !task.attention.dismissed ? el("p", { class: "task-attention" }, el("strong", { text: task.attention.reason }), " ", task.attention.remedy) : null,
        task.outcome ? el("p", { class: "task-outcome", text: task.outcome }) : null,
        el("div", { class: "row" },
          !TASK_DONE.has(task.state) ? control("Stop Task", "task.cancel") : null,
          ["running", "waiting", "queued"].includes(task.state) ? control("Pause", "task.pause") : null,
          ["paused", "blocked", "failed"].includes(task.state) ? control(task.state === "paused" ? "Resume" : "Retry", "task.resume") : null,
          task.attention && !task.attention.dismissed ? control("Dismiss", "task.dismiss") : null)),
      children.length ? el("h3", { text: "Agents" }) : null,
      children.length ? el("ul", { class: "list" }, children.map(child => el("li", {
        class: child.conversationID ? "clickable" : "", title: child.objective,
        onclick: () => { if (child.conversationID) bridge.openTab(`about:lima?chat=${encodeURIComponent(child.conversationID)}`); },
      }, el("span", { class: "grow" }, el("strong", { text: child.title }),
          el("span", { class: "muted", text: ` · ${child.events.at(-1)?.message ?? ""}` }),
          child.dependsOn.length ? el("span", { class: "muted", text: ` · after ${child.dependsOn.map(id => names.get(id) ?? "another task").join(", ")}` }) : null),
        el("span", { class: "badge", text: TASK_STATES[child.state] ?? child.state })))) : null,
      el("h3", { text: "Activity" }),
      eventRows(events.slice(0, 3)),
      events.length > 3 ? el("details", {}, el("summary", { text: "Earlier activity" }), eventRows(events.slice(3))) : null);
  }

  // Steps: every tool call, timestamped by its reply; nothing disappears.
  function drawSteps() {
    const stepList = JSON.stringify([visualActivity?.state, visualActivity?.label, conversation.messages.map(message => [message.id, message.status, message.tools])]);
    if (stepList === lastStepList) return;
    lastStepList = stepList;
    const rows = [];
    for (const message of conversation.messages) {
      if (message.role !== "assistant") continue;
      const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      visibleTools(message.tools ?? []).forEach((tool, i, tools) => {
        const current = message.status === "streaming" && visualActivity?.state === "working" && toolLabel(tool) === visualActivity.label && i === tools.length - 1;
        rows.push(el("li", { class: current ? "now" : message.status === "failed" ? "failed" : "" }, el("time", { text: time }), toolRow(tool, current)));
      });
    }
    stepsTab.replaceChildren(...counted("Activity", rows.length));
    steps.replaceChildren(...(rows.length ? rows.slice(-40) : [el("li", { class: "muted" }, el("time", { text: "" }), el("span", { text: "Tool calls appear here as the agent works." }))]));
    if (!compact && currentView === "steps") steps.lastElementChild?.scrollIntoView?.({ block: "nearest" });
  }

  async function drawWorkspaceModules() {
    if (!workspace || compact || signal.aborted) return;
    progressTab.hidden = false;
    const request = ++modulesRequest;
    const [all, chats] = await Promise.all([call("workspace.list").catch(() => []), call("chat.list").catch(() => [])]);
    if (signal.aborted || request !== modulesRequest) return;
    const summaries = new Map(chats.map(chat => [chat.id, chat]));
    const helpers = all.filter(w => w.parentID === workspace.id);
    helperChats = new Set(helpers.map(helper => helper.conversationID));
    agentsTab.hidden = !helpers.length;
    agentsTab.replaceChildren(...counted("Agents", helpers.length));
    agents.replaceChildren(...helpers.map(h => {
      const summary = summaries.get(h.conversationID);
      const avatar = companion("agent-avatar");
      avatar.dataset.variant = summary?.mascot ?? "classic";
      return el("li", { class: "clickable", "data-agent-chat": h.conversationID,
        onclick: () => bridge.openTab(`about:lima?chat=${encodeURIComponent(h.conversationID)}`) },
        avatar, el("span", { class: "grow", text: h.name, title: h.task ?? "" }),
        h.browserTestURL ? el("span", { class: "muted", text: "Browser only" }) : null,
        el("span", { class: "badge" }));
    }));
    paintAgents();
    const entries = await call("fs.list", { path: workspace.directory }).catch(() => []);
    if (signal.aborted || request !== modulesRequest) return;
    filesTab.hidden = false;
    filesTab.replaceChildren(...counted("Files", entries.length));
    files.replaceChildren(...(entries.length ? entries.slice(0, 30).map(f => el("li", {}, icon(f.directory ? "folder" : "file"), el("span", { class: "grow", text: f.name })))
      : [el("li", { class: "muted", text: "Empty folder" })]));
  }

  function paintAgents() {
    for (const row of agents.children) {
      const activity = helperVisuals[row.dataset.agentChat];
      setCompanionState(row.firstElementChild, activity?.motion ?? "idle");
      const badge = row.lastElementChild;
      badge.textContent = activity?.label ?? "Ready";
      badge.className = "badge " + ({ working: "warn", complete: "ok", failed: "bad", blocked: "bad" }[activity?.state] ?? "");
    }
  }

  /** A task that needs the user says what to do next, with the button that does it. */
  function attentionActions(next) {
    const attention = next.notice;
    if (!attention || !next.taskId) return [];
    const task = method => async () => {
      try { await call(method, { id: next.taskId }); } catch (error) { reportError(error); }
    };
    const primary = {
      retry: el("button", { class: "ghost", onclick: task("task.resume") }, "Retry"),
      resume: el("button", { class: "ghost", onclick: task("task.resume") }, "Resume"),
      settings: el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=agents") }, "Open Settings"),
      review: el("button", { class: "ghost", onclick: () => showView("progress") }, "Review Task"),
    }[attention.action];
    return [el("span", { class: "attention-remedy", text: attention.remedy }), primary,
      attention.needsUser ? el("button", { class: "ghost", onclick: task("task.cancel") }, "Stop Task") : null,
      el("button", { class: "ghost", onclick: task("task.dismiss") }, "Dismiss")];
  }

  function paintNow() {
    if (signal.aborted) return;
    const reply = runningReply() ?? conversation?.messages.findLast(item => item.role === "assistant");
    const next = requestError ? { ...failureActivity(requestError, loaded ? (sendFailed ? "Message not sent" : "Request failed") : "Conversation unavailable"),
        ...(sendFailed ? { label: "Message not sent" } : {}) }
      : !loaded ? { state: "starting", label: "Opening conversation", icon: "notebook", motion: "think" }
      : pendingRequest && !runningReply() ? { state: "starting", label: "Sending request", icon: "send", motion: "think" }
      : (visualActivity ?? { state: "idle", label: "Ready", motion: "idle" });
    activity.update(next);
    setCompanionState(character, next.motion ?? "idle");
    const working = ["starting", "working"].includes(next.state);
    if (chatTab.hasAttribute("data-working") !== working) {
      chatTab.toggleAttribute("data-working", working);
      chatTab.replaceChildren(...(working ? [el("i", { class: "live" }), "Chat · working"] : ["Chat"]));
    }
    const folderError = requestError ?? reply?.error;
    recovery.replaceChildren(
      !loaded && requestError ? el("button", { class: "ghost", onclick: loadConversation }, "Retry") : null,
      loaded && sendFailed && requestError ? el("button", { class: "ghost", onclick: send }, "Retry Message") : null,
      isFolderPermissionError(folderError) ? filesPrivacyButton(reportError) : null,
      ...(!requestError ? attentionActions(next) : []));
    recovery.hidden = !recovery.childElementCount;
  }

  const unsubscribe = onEvent(message => {
    const data = message.data;
    if (message.event === "task.updated" && workspace && (data?.workspaceID === (workspace.parentID ?? workspace.id) ||
        (!!shownTaskID && (data?.id === shownTaskID || data?.parentID === shownTaskID)))) {
      if (currentView === "progress") drawProgress();
      return;
    }
    if (message.event === "integrations.setup.updated" && data?.phase === "done" && conversation) {
      controls.refresh(conversation, false).then(draw);
    }
    if (message.event === "chat.delta" && data.conversationId === chatId) {
      const target = conversation?.messages.find(m => m.id === data.messageId);
      if (target) {
        eventRevision++;
        target.text += data.text;
        if (!deltaPaint) deltaPaint = requestAnimationFrame(() => {
          deltaPaint = 0;
          const body = messageElements.get(target.id)?.querySelector(".typing");
          if (!body) return;
          const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
          body.replaceChildren(...markdown(target.text, { onTaskToggle: () => {} }).childNodes);
          if (atBottom) messages.scrollTop = messages.scrollHeight;
        });
      }
    } else if (message.event === "chat.updated" && data.id === chatId) {
      eventRevision++;
      const previous = runningReply();
      conversation = data;
      const running = runningReply();
      if (previous?.id !== running?.id) requestError = undefined;
      draw();
      // A reply just finished: render the stored final text, as a reload
      // would, in case a streamed chunk arrived out of order.
      if (previous && previous.id !== running?.id) {
        const revision = eventRevision;
        call("chat.get", { id: chatId }).then(fresh => {
          if (signal.aborted || revision !== eventRevision || !fresh) return;
          settledMessages.delete(previous.id);
          conversation = fresh;
          draw();
        }).catch(() => {});
      }
    } else if (message.event === "chat.updated" && helperChats.has(data.id)) {
      const avatar = [...agents.children].find(row => row.dataset.agentChat === data.id)?.firstElementChild;
      if (avatar) avatar.dataset.variant = data.mascot ?? "classic";
    } else if (message.event === "workspace.updated" && data.id === workspace?.id) {
      workspace = data; draw(); drawWorkspaceModules();
    } else if (workspace && ["workspace.created", "workspace.deleted"].includes(message.event)) {
      drawWorkspaceModules();
    } else if (workspace && message.event === "terminal.command") {
      drawWorkspaceModules();
    }
  });

  const unwatch = watchVisualActivity(snapshot => snapshot.chats[chatId], activity => {
    visualActivity = activity;
    paintNow();
    if (conversation) drawSteps();
  });
  const unwatchAgents = watchVisualActivity(snapshot => snapshot.chats, chats => { helperVisuals = chats; paintAgents(); });
  signal.addEventListener("abort", () => {
    unwatch();
    unwatchAgents();
    unsubscribe();
    cancelAnimationFrame(deltaPaint);
  }, { once: true });

  async function loadConversation() {
    requestError = undefined;
    paintNow();
    try {
      if (!conversation) {
        const opened = await call("chat.get", { id: chatId });
        conversation ??= opened;
      }
      if (conversation.workspaceID) workspace = await call("workspace.get", { id: conversation.workspaceID });
    } catch (error) {
      reportError(error);
      return;
    }
    if (signal.aborted) return;
    loaded = true;
    draw();
    drawWorkspaceModules();
    controls.show(conversation, false).then(draw);
    if (workspace?.browserTestURL) controls.provider.disabled = true;
    autosize();
    input.focus();
  }
  loadConversation();
}
