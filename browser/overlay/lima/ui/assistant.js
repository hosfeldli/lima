import { activityStatus, bridge, call, el, errorText, filesPrivacyButton, icon, markdown, onEvent, prefs, setPage } from "./lib.js";
import { agentControls } from "./composer.js";
import { companion, cueCompanion, setCompanionState, watchVisualActivity } from "./companion.js";
import { workspacePrompts } from "./workspace-prompts.js";
import { failureActivity, isFolderPermissionError } from "./tool-activity.sys.mjs";

export async function renderAssistant(app, _initialWorkspace, { home = false } = {}) {
  setPage(home ? "Lima" : "Lima Companion", "lima");
  const workspaces = new Map();
  const input = el("textarea", { rows: home ? 3 : 2, placeholder: "What would you like Lima to do?", "aria-label": "Question or task" });
  const character = companion(home ? "home" : "status");
  const send = el("button", { class: "primary", onclick: delegate, disabled: true }, icon("send"), "Send");
  const activity = activityStatus();
  const target = el("strong", { hidden: true });
  const openAgent = el("button", { class: "ghost", hidden: true, onclick: () => openWorkspace(shownWorkspace) }, "Open agent", icon("arrow"));
  const recovery = el("div", { class: "row", hidden: true });
  const status = el("div", { class: "handoff" }, el("div", { class: "grow" }, target, activity.node, recovery), openAgent);
  const recent = el("div", { class: "handoff-recent" });
  const prompts = workspacePrompts();
  const taskChat = el("section", { class: "companion-task-chat", role: "log", "aria-label": "Companion requests", hidden: true });
  const tasks = [];
  const agent = agentControls();
  const providerHelp = el("details", { class: "assistant-providers", hidden: true });
  const draftKey = "assistant.draft";
  input.value = prefs.get(draftKey, "");
  // Delegate Task from Search: the query becomes the draft, never sent unasked.
  const handedDraft = home ? null : new URLSearchParams(location.search).get("draft");
  if (handedDraft) { input.value = handedDraft; prefs.set(draftKey, handedDraft); }
  let handedOff;
  let ready = false;
  let shownWorkspace;
  let requestError;
  let visualSnapshot;

  const close = () => bridge.browser("closeAssistant", {});
  const head = home
    ? el("header", { class: "handoff-head" }, character, el("h1", { text: "What are we working on?" }))
    : el("header", { class: "assistant-head" }, character, el("strong", { text: "Lima Companion" }), el("span", { class: "spacer" }),
      el("button", { class: "ghost icon-only", title: "Close Companion", "aria-label": "Close Companion", onclick: close }, icon("close")));
  app.replaceChildren(el("div", { class: home ? "assistant-page handoff-home" : "assistant-page" },
    head, el("div", { class: "handoff-body" },
      el("div", { class: "handoff-composer composer-box" }, input,
        el("div", { class: "composer-row handoff-controls" }, agent.provider, agent.model,
          el("span", { class: "spacer" }), send)),
      taskChat, status, prompts.node, recent, home ? null : providerHelp)));

  input.addEventListener("focus", () => { if (character.dataset.state === "idle") cueCompanion(character, "listen"); });
  input.addEventListener("input", () => prefs.set(draftKey, input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); delegate(); }
  });
  if (!home) {
    document.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
    loadProviderHelp();
  }

  async function loadProviderHelp() {
    const installers = {
      claude: ["Claude Code", "brew install --cask claude-code"],
      codex: ["Codex", "npm install -g @openai/codex"],
      opencode: ["OpenCode", "brew install anomalyco/tap/opencode-v2"],
    };
    try {
      const [providers, configured] = await Promise.all([call("agents.discover"), call("agents.configured")]);
      const missing = providers.filter(provider => !configured.includes(provider.provider));
      providerHelp.hidden = false;
      if (missing.length === providers.length) providerHelp.open = true;
      providerHelp.replaceChildren(el("summary", { text: "AI providers" }),
        ...providers.map(provider => {
          const [name, install] = installers[provider.provider];
          const files = provider.installations ?? [];
          if (configured.includes(provider.provider)) return el("div", {},
            el("strong", { text: name }), el("span", { class: "muted", text: " · " + (provider.version ?? "Available") }),
            ...files.map((file, index) => el("div", { class: "provider-install", title: file.resolvedPath },
              el("code", { text: file.path }), el("small", { class: "muted", text: index ? "Alternate" : "In use" }))));
          return el("div", {}, el("strong", { text: name }),
            provider.status === "version_probe_failed"
              ? el("p", { class: "muted", text: "The CLI was found but its version check failed." })
              : provider.status === "not_installed" ? el("code", { text: install }) : el("p", { class: "muted", text: "Sign-in required." }),
            el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=agents") }, "Open setup"));
        }),
        el("button", { class: "ghost", onclick: async () => { await agent.refresh(); draw(); loadProviderHelp(); } }, "Check again"));
    } catch { providerHelp.hidden = true; }
  }

  function describe(workspace) {
    return visualSnapshot?.workspaces[workspace.id] ?? { state: "idle", label: "Ready" };
  }

  function reportError(error) { requestError = error; paintActivity(); }

  function openWorkspace(workspace) {
    if (workspace) bridge.browser("openChat", { id: workspace.id }).catch(reportError);
  }

  function paintActivity() {
    shownWorkspace = workspaces.get(handedOff) ?? [...workspaces.values()].find(workspace =>
      !workspace.parentID && ["starting", "working", "blocked"].includes(describe(workspace).state));
    const pending = tasks.some(task => task.phase === "working");
    const shared = visualSnapshot?.companion;
    const next = requestError ? failureActivity(requestError, ready ? "Workspace request failed" : "Workspaces unavailable")
      : !ready ? { state: "starting", label: "Loading workspaces", icon: "workspace", motion: "think" }
      : tasks.some(task => task.phase === "approval") ? { state: "blocked", label: "Needs your approval", icon: "note", motion: "waiting" }
      : ["blocked", "failed", "disconnected"].includes(shared?.state) ? shared
      : pending ? { state: "starting", label: "Planning task…", icon: "notebook", motion: "planning" }
      : (shared ?? { state: "idle", label: "Ready to delegate" });
    status.hidden = home && ready && !pending && !requestError && !shownWorkspace;
    target.hidden = openAgent.hidden = !shownWorkspace || pending || !!requestError;
    target.textContent = shownWorkspace?.name ?? "";
    activity.update(next);
    setCompanionState(character, next.motion ?? "idle");
    recovery.replaceChildren(
      requestError && !ready ? el("button", { class: "ghost", onclick: load }, "Retry") : null,
      isFolderPermissionError(requestError ?? next.detail) ? filesPrivacyButton(reportError) : null);
    recovery.hidden = !recovery.childElementCount;
    send.disabled = !ready || !agent.settings().provider;
  }

  function draw() {
    const roots = [...workspaces.values()].filter(workspace => !workspace.parentID);
    const rows = roots.slice(0, home ? 6 : 10).map(workspace => {
      const { label, state, detail } = describe(workspace);
      return el("button", { class: "ghost handoff-workspace", "data-workspace-id": workspace.id, onclick: () => openWorkspace(workspace) },
        icon("workspace"), el("span", { class: "grow", text: workspace.name }),
        el("span", { class: "handoff-state", "data-state": state, text: label, title: detail }));
    });
    recent.replaceChildren(...(rows.length ? [el("h2", { text: home ? "Continue" : "Workspaces" }), ...rows] : []));
    paintActivity();
  }

  function paintTask(task, phase, ...content) {
    task.phase = phase;
    task.reply.dataset.state = phase;
    task.reply.replaceChildren(...content);
    if (!home) bridge.browser("assistantAttention", { pending: tasks.some(item => item.phase === "approval") }).catch(() => {});
    paintActivity();
  }

  function showApproval(task, plan) {
    const destinations = plan.workspaceIds.map(id => workspaces.get(id)?.name).filter(Boolean);
    paintTask(task, "approval", el("strong", { text: "Connect to workspaces?" }),
      el("p", { text: destinations.join(", ") }),
      plan.pages.length ? el("p", { class: "muted", text: "Relevant tab content will be shared with these agents." }) : null,
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: () => submit(task, plan) }, "Approve handoff"),
        el("button", { class: "ghost", onclick: () => paintTask(task, "complete", "Handoff canceled.") }, "Cancel")));
  }

  async function delegate() {
    const text = input.value.trim();
    const agentSettings = agent.settings();
    if (!text || !ready || !agentSettings.provider) return;
    const reply = el("div", { class: "companion-task-reply" });
    const row = el("article", { class: "companion-task" },
      el("p", { class: "companion-task-request", text }), reply);
    const task = { row, reply, requestId: crypto.randomUUID(), taskIds: [] };
    tasks.push(task);
    const settled = tasks.filter(item => ["complete", "failed"].includes(item.phase)
      || (item.phase === "tracked" && item.taskIds.every(id => TERMINAL.has(orchestrated.get(id)?.task.state))));
    if (settled.length > 15) {
      const oldest = settled[0];
      oldest.row.remove();
      tasks.splice(tasks.indexOf(oldest), 1);
    }
    taskChat.hidden = false;
    taskChat.prepend(row);
    input.value = "";
    prefs.set(draftKey, "");
    requestError = undefined;
    cueCompanion(character, "receive");
    paintTask(task, "working", "Understanding the request…");
    try {
      const [tabs, folders] = await Promise.all([
        bridge.browser("assistantTabs", {}),
        bridge.browser("assistantFolders", {}).catch(() => []),
      ]);
      const metadata = tabs.map(({ title, url, live }, index) => ({ title, site: new URL(url).hostname, live, index }));
      const planWith = () => call("assistant.plan", { text, ...agentSettings, tabs: metadata, folders });
      const first = await planWith();
      const pages = await Promise.all([...new Set(first.tabIndexes ?? [])].map(async index => {
        const tab = tabs[index];
        if (!tab) return null;
        const excerpt = await bridge.browser("assistantReadTab", { id: tab.id, url: tab.url }).catch(() => "");
        metadata[index].excerpt = excerpt;
        return { ...tab, excerpt };
      }));
      const plan = pages.some(page => page?.excerpt) ? await planWith() : first;
      if (plan.localAction) {
        const note = plan.localAction.kind === "note";
        paintTask(task, "working", note ? "Creating your note…" : "Creating your tab folder…");
        const result = await bridge.browser("assistantLocalTask", plan.localAction);
        const open = el("button", { class: "ghost", onclick: async () => {
          try {
            if (note) await bridge.openTab(`about:lima?note=${encodeURIComponent(result.id)}`);
            else await bridge.browser("assistantRevealGroup", { id: result.id });
          } catch (error) { paintTask(task, "failed", errorText(error)); }
        } }, icon(note ? "note" : "folder"), note ? "Open note" : "Show folder");
        paintTask(task, "complete", el("p", { text: note ? `I'll handle that directly. Created “${result.title}”.`
          : `Created “${result.title}” with ${result.count} ${result.count === 1 ? "tab" : "tabs"}.` }), open);
        return;
      }
      if (plan.answer) { paintTask(task, "complete", el("p", { class: "muted", text: "Here's the answer." }), markdown(plan.answer)); return; }
      if (plan.workspaceIds.some(id => !workspaces.has(id))) throw new Error("A workspace changed during planning. Send the request again.");
      plan.pages = pages.filter(Boolean);
      plan.text = text;
      plan.agent = agentSettings;
      if (plan.workspaceIds.length) showApproval(task, plan);
      else await submit(task, plan);
    } catch (error) { paintTask(task, "failed", errorText(error)); }
  }

  async function submit(task, plan) {
    paintTask(task, "working", plan.workspaceIds.length ? "I'll send this to your existing workspace." : "This requires several steps. I'll coordinate the work.");
    try {
      const pages = plan.pages.map(tab => [tab.title, tab.url, tab.excerpt].filter(Boolean).join("\n"));
      const destinations = [];
      for (const [index, id] of (plan.workspaceIds.length ? plan.workspaceIds : [undefined]).entries()) {
        // One request ID per destination: resubmitting never creates a second task.
        const { task: record, workspace } = await call("task.submit", {
          requestId: `${task.requestId}:${index}`, id, name: plan.newName, text: plan.text, mascot: plan.mascot, ...plan.agent,
          references: pages.join("\n\n"), referenceCount: pages.length,
        });
        workspaces.set(workspace.id, workspace);
        destinations.push(workspace);
        handedOff = workspace.id;
        tracked.set(record.id, task);
        task.taskIds.push(record.id);
        orchestrated.set(record.id, { task: record, children: [] });
      }
      task.phase = "tracked";
      paintTracked(task);
      if (!home && !input.value && !tasks.some(item => ["working", "approval"].includes(item.phase))) close().catch(() => {});
    } catch (error) { paintTask(task, "failed", errorText(error)); }
    finally { draw(); }
  }

  // MARK: Orchestrated tasks: one persistent record per handoff

  const STATES = {
    accepted: "Preparing your task…", planned: "Assigned", queued: "Waiting for available capacity", waiting: "Waiting for agents",
    running: "Working", paused: "Work paused", blocked: "Blocked", verifying: "Verifying results…", completed: "Task completed",
    completed_with_warnings: "Completed with warnings", failed: "Failed", canceled: "Stopped",
  };
  const TERMINAL = new Set(["completed", "completed_with_warnings", "failed", "canceled"]);
  const orchestrated = new Map();
  const tracked = new Map();

  function taskView(record) {
    const { task: item, children } = record;
    const active = children.filter(child => ["running", "verifying"].includes(child.state)).length;
    const queued = children.filter(child => ["queued", "waiting"].includes(child.state)).length;
    const last = item.events.at(-1)?.message ?? "";
    const workspace = workspaces.get(item.workspaceID);
    const where = workspace ? (item.state === "accepted" || item.state === "planned" ? `Assigned to ${workspace.name}` : workspace.name) : "";
    const agents = [active ? `${active} ${active === 1 ? "agent" : "agents"} working` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
    const actions = [];
    if (workspace) actions.push(el("button", { class: "ghost", onclick: () => openWorkspace(workspace) }, TERMINAL.has(item.state) ? "Review Result" : "Open Workspace"));
    if (!TERMINAL.has(item.state)) actions.push(el("button", { class: "ghost", onclick: () => control("task.cancel", item.id) }, "Stop Task"));
    if (item.attention?.action === "settings") actions.push(el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=agents") }, "Open Settings"));
    if (["paused", "blocked", "failed"].includes(item.state)) actions.push(el("button", { class: "ghost", onclick: () => control("task.resume", item.id) }, item.state === "paused" ? "Resume" : "Retry"));
    return el("div", { class: "companion-task-status", "data-state": item.state },
      el("p", { class: "companion-task-line" }, el("strong", { text: STATES[item.state] ?? item.state }),
        where ? el("span", { class: "muted", text: ` · ${where}` }) : null),
      item.attention ? el("p", { text: item.attention.reason }) : last && last !== STATES[item.state] ? el("p", { class: "muted", text: last }) : null,
      item.attention ? el("p", { class: "muted", text: item.attention.remedy }) : null,
      agents ? el("p", { class: "muted", text: agents }) : null,
      TERMINAL.has(item.state) && item.outcome ? el("p", { class: "companion-task-outcome", text: item.outcome }) : null,
      el("div", { class: "row" }, ...actions));
  }

  async function control(method, id) {
    try {
      const record = await call(method, { id });
      orchestrated.set(record.task.id, record);
      const owner = tracked.get(record.task.id);
      if (owner) paintTracked(owner);
    } catch (error) { reportError(error); }
  }

  function paintTracked(task) {
    const records = task.taskIds.map(id => orchestrated.get(id)).filter(Boolean);
    task.reply.dataset.state = records.every(record => TERMINAL.has(record.task.state)) ? "complete" : "working";
    task.reply.replaceChildren(...records.map(taskView));
  }

  let refreshing = new Map();
  function refreshTask(id) {
    clearTimeout(refreshing.get(id));
    refreshing.set(id, setTimeout(async () => {
      const record = await call("task.get", { id }).catch(() => null);
      if (!record) return;
      orchestrated.set(id, record);
      const owner = tracked.get(id);
      if (owner) paintTracked(owner);
    }, 120));
  }

  /** Reopening the Companion shows the tasks still in progress and recent results. */
  async function restoreTasks() {
    const records = await call("task.list", { limit: 6 }).catch(() => []);
    for (const record of records.reverse()) {
      if (tracked.has(record.task.id)) continue;
      if (TERMINAL.has(record.task.state) && Date.now() - (record.task.finishedAt ?? 0) > 6 * 3600_000) continue;
      const reply = el("div", { class: "companion-task-reply" });
      const row = el("article", { class: "companion-task" }, el("p", { class: "companion-task-request", text: record.task.request }), reply);
      const task = { row, reply, phase: "tracked", taskIds: [record.task.id] };
      tasks.push(task);
      tracked.set(record.task.id, task);
      orchestrated.set(record.task.id, record);
      taskChat.hidden = false;
      taskChat.prepend(row);
      paintTracked(task);
    }
  }

  const queued = [];
  function update(event, data) {
    if (event === "workspace.deleted") {
      workspaces.delete(data.id);
      if (data.id === handedOff) handedOff = undefined;
    }
    else workspaces.set(data.id, data);
  }
  const unsubscribe = onEvent(({ event, data }) => {
    if (event === "task.updated" && data) {
      const root = data.parentID ?? data.id;
      if (tracked.has(root)) {
        if (!data.parentID) { const record = orchestrated.get(root); if (record) record.task = data; paintTracked(tracked.get(root)); }
        refreshTask(root);
      }
      return;
    }
    if (event === "assistant.draft" && !home && typeof data?.text === "string") {
      input.value = data.text;
      prefs.set(draftKey, data.text);
      input.focus();
      return;
    }
    if (event === "integrations.setup.updated" && data?.phase === "done") {
      agent.refresh().then(draw);
      if (!home) loadProviderHelp();
    }
    if (!["workspace.created", "workspace.updated", "workspace.deleted"].includes(event)) return;
    if (!ready) queued.push([event, data]);
    else { update(event, data); draw(); }
  });
  const unwatch = watchVisualActivity(snapshot => snapshot, snapshot => {
    visualSnapshot = snapshot;
    paintActivity();
    for (const row of recent.querySelectorAll("[data-workspace-id]")) {
      const next = describe(workspaces.get(row.dataset.workspaceId) ?? { id: row.dataset.workspaceId });
      const label = row.querySelector(".handoff-state");
      if (label.textContent !== next.label) label.textContent = next.label;
      label.dataset.state = next.state;
      label.title = next.detail ?? "";
    }
  });
  window.addEventListener("pagehide", () => { unsubscribe(); unwatch(); }, { once: true });

  async function load() {
    requestError = undefined;
    paintActivity();
    try {
      const all = await call("workspace.list");
      for (const workspace of all) workspaces.set(workspace.id, workspace);
      for (const [event, data] of queued.splice(0)) update(event, data);
      ready = true;
      draw();
    } catch (error) { reportError(error); }
  }
  await load();
  await restoreTasks();
  await agent.ready;
  draw();
}
