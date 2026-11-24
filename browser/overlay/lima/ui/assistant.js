import { activityStatus, bridge, call, el, errorText, filesPrivacyButton, icon, markdown, onEvent, prefs, relativeTime, setPage } from "./lib.js";
import { agentControls, attachmentTray, QUEUE_HINT, queuedActions, restoreDraft, sendMode, sentAttachments } from "./composer.js";
import { mediaStrip } from "./chat.js";
import { companion, cueCompanion, setCompanionState, watchVisualActivity } from "./companion.js";
import { workspacePrompts } from "./workspace-prompts.js";
import { failureActivity, isFolderPermissionError } from "./tool-activity.sys.mjs";
import { imageGenerationSettingsURL, watchGeneration } from "./studio-production.js";

export async function renderAssistant(app, _initialWorkspace, { home = false } = {}) {
  setPage(home ? "Lima" : "Lima Companion", "lima");
  const workspaces = new Map();
  const generationLifetime = new AbortController();
  const input = el("textarea", { rows: home ? 3 : 2, placeholder: "What would you like Lima to do? Each request becomes its own chat.", "aria-label": "Question or task" });
  const character = companion(home ? "home" : "status");
  const send = el("button", { class: "primary", onclick: delegate, disabled: true }, icon("send"), "Send");
  const activity = activityStatus();
  const target = el("strong", { hidden: true });
  const openAgent = el("button", { class: "ghost", hidden: true, onclick: () => openWorkspace(shownWorkspace) }, "Open agent", icon("arrow"));
  const recovery = el("div", { class: "row", hidden: true });
  const status = el("div", { class: "handoff" }, el("div", { class: "grow" }, target, activity.node, recovery), openAgent);
  const recent = el("div", { class: "handoff-recent" });
  const prompts = workspacePrompts();
  // Each request is an entry; opening one shows its small chat in place.
  const requestList = el("section", { class: "companion-requests", "aria-label": "Chats", hidden: true });
  const openSchedules = () => bridge.openTab("about:lima?view=schedules");
  const scheduleStrip = el("button", { type: "button", class: "companion-schedules", hidden: true, onclick: openSchedules });
  const threadView = el("section", { class: "companion-thread", hidden: true });
  const listView = el("div", { class: "companion-list-view" });
  const threads = new Map(); // conversation ID → thread
  let openThread = null;
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
  listView.append(
    el("div", { class: "handoff-composer composer-box" }, input,
      el("div", { class: "composer-row handoff-controls" }, agent.provider, agent.model,
        el("span", { class: "spacer" }), send)),
    status, prompts.node, scheduleStrip, requestList, recent, home ? null : providerHelp);
  app.replaceChildren(el("div", { class: home ? "assistant-page handoff-home" : "assistant-page" },
    head, el("div", { class: "handoff-body" }, listView, threadView)));

  input.addEventListener("focus", () => { if (character.dataset.state === "idle") cueCompanion(character, "listen"); });
  input.addEventListener("input", () => prefs.set(draftKey, input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); delegate(); }
  });
  if (!home) {
    // Escape leaves an open thread first, then closes the Companion.
    document.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (openThread) showList(); else close();
    });
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
    if (task.thread) paintEntry(task.thread);
    paintActivity();
  }

  function showApproval(task, plan) {
    const destinations = plan.workspaceIds.map(id => workspaces.get(id)?.name).filter(Boolean);
    paintTask(task, "approval", el("strong", { text: "Connect to workspaces?" }),
      el("p", { text: destinations.join(", ") }),
      plan.pages.length ? el("p", { class: "muted", text: "Relevant tab content will be shared with these agents." }) : null,
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: () => submit(task, plan) }, "Approve handoff"),
        el("button", { class: "ghost", onclick: () => { paintTask(task, "complete"); remember(task.thread, "Handoff canceled."); } }, "Cancel")));
  }

  /** Scheduling is confirmed here: what runs, when, and where. */
  function showSchedule(task, proposal, agentSettings) {
    const destination = proposal.workspaceId && workspaces.get(proposal.workspaceId);
    const create = async () => {
      paintTask(task, "working", "Scheduling…");
      try {
        const created = await call("schedule.create", { ...agentSettings, title: proposal.title, instruction: proposal.instruction, when: proposal.when,
          workspaceId: destination ? proposal.workspaceId : undefined, workspaceName: destination ? undefined : proposal.newName });
        paintTask(task, "complete", el("strong", { text: `Scheduled · ${created.summary}` }),
          el("button", { class: "ghost", onclick: openSchedules }, icon("calendar"), "Scheduled Tasks"));
        await remember(task.thread, `Scheduled “${created.title}”: ${created.summary.toLowerCase()}${created.nextRunLabel ? `. First run ${created.nextRunLabel}` : ""}.` +
          (proposal.note ? ` ${proposal.note}` : ""));
        drawSchedules();
      } catch (error) {
        paintTask(task, "failed", errorText(error));
        remember(task.thread, `I couldn't schedule this: ${errorText(error)}`);
      }
    };
    paintTask(task, "approval", el("strong", { text: "Schedule this?" }),
      el("p", { class: "schedule-proposal-when" }, icon("calendar"), el("span", { text: proposal.summary }),
        proposal.nextRunLabel ? el("span", { class: "muted", text: ` · first run ${proposal.nextRunLabel}` }) : null),
      el("p", { class: "schedule-proposal-what", text: proposal.instruction }),
      proposal.note ? el("p", { class: "muted", text: proposal.note }) : null,
      el("p", { class: "muted", text: destination ? `Runs in ${destination.name}.` : `Runs in a new workspace, “${proposal.newName}”.` }),
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: create }, "Schedule"),
        el("button", { class: "ghost", onclick: () => { paintTask(task, "complete"); remember(task.thread, "Scheduling canceled."); } }, "Cancel")));
  }

  /** "3 scheduled · next: …" above the chats; opens Scheduled Tasks. */
  async function drawSchedules() {
    const items = await call("schedule.list").catch(() => []);
    const upcoming = items.filter(item => item.state === "scheduled");
    scheduleStrip.hidden = !items.length;
    const next = upcoming[0];
    scheduleStrip.replaceChildren(icon("calendar"),
      el("span", { class: "companion-schedules-count", text: upcoming.length ? `${upcoming.length} scheduled` : "Scheduled tasks" }),
      el("span", { class: "companion-schedules-next", text: next ? `Next: ${next.title} · ${next.nextRunLabel ?? next.summary}` : "None upcoming" }),
      icon("chevron", "icon companion-entry-open"));
  }

  async function generateArtwork(task, action, agentSettings) {
    const settingsButton = () => el("button", { class: "ghost", onclick: () => bridge.openTab(imageGenerationSettingsURL) }, "Image Generation Settings");
    try {
      const config = await call("image.generation_config");
      if (!config.configured) {
        paintTask(task, "failed", "Choose a local ComfyUI checkpoint to generate artwork.", settingsButton());
        return;
      }
      const target = action.workspaceId && workspaces.get(action.workspaceId);
      if (action.workspaceId && !target) throw new Error("The requested workspace is unavailable.");
      const launch = async () => {
        try {
          paintTask(task, "working", "Starting image generation…");
          const workspace = target ?? await call("workspace.create", { name: String(action.title || "Image Studio").trim().slice(0, 60), ...agentSettings });
          const job = await call("image.generate", { workspace_id: workspace.id, prompt: action.prompt, count: action.count ?? 1,
            output_name: action.outputName || "generated.png", idempotency_key: task.requestId, show_in_workspace: true });
          let status;
          const stop = el("button", { class: "ghost", onclick: async () => {
            try { await call("image.generation_cancel", { workspace_id: workspace.id, operation_id: job.operation_id }); }
            catch (error) { paintTask(task, "failed", errorText(error)); }
          } }, "Stop import");
          const result = await watchGeneration(workspace.id, job.operation_id, entry => {
            if (status === entry.status) return;
            status = entry.status;
            if (status === "queued" || status === "running") paintTask(task, "working",
              status === "running" ? "Generating image… " : "Waiting for local ComfyUI… ", stop);
          }, generationLifetime.signal);
          if (!result) return;
          if (result.status !== "completed") {
            paintTask(task, "failed", result.error ?? "Image generation stopped.", result.artifact_ids.join(", "), settingsButton());
            return;
          }
          paintTask(task, "complete", el("strong", { text: "Image ready" }),
            ...result.documents.map(document => el("button", { class: "ghost", onclick: () => bridge.openTab(document.studio_url) },
              icon("image"), `Open ${document.source_path}`)));
        } catch (error) { paintTask(task, "failed", errorText(error), settingsButton()); }
      };
      if (target) {
        paintTask(task, "approval", el("strong", { text: `Save generated artwork in ${target.name}?` }),
          el("div", { class: "row" }, el("button", { class: "primary", onclick: launch }, "Generate"),
            el("button", { class: "ghost", onclick: () => paintTask(task, "complete", "Generation canceled.") }, "Cancel")));
      } else await launch();
    } catch (error) { paintTask(task, "failed", errorText(error), settingsButton()); }
  }

  async function delegate() {
    const text = input.value.trim();
    const agentSettings = agent.settings();
    if (!text || !ready || !agentSettings.provider) return;
    const reply = el("div", { class: "companion-task-reply" });
    const task = { reply, requestId: crypto.randomUUID(), taskIds: [] };
    tasks.push(task);
    input.value = "";
    prefs.set(draftKey, "");
    requestError = undefined;
    cueCompanion(character, "receive");
    // The request becomes a Companion thread: a conversation that keeps the
    // exchange so follow-ups have context. If it can't be stored, the request
    // still runs; it just can't be continued.
    let conversation;
    try {
      conversation = await call("chat.create", { ...agentSettings, companion: true });
      conversation = await call("chat.record", { id: conversation.id, role: "user", text });
    } catch { conversation = { id: `local-${task.requestId}`, title: text, messages: [{ id: "u", role: "user", text, status: "complete" }], local: true }; }
    const thread = addThread(conversation, { prepend: true });
    thread.task = task;
    task.thread = thread;
    paintTask(task, "working", "Understanding the request…");
    // The request opens as its chat right away; ← goes back to all chats.
    showThread(thread);
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
        if (plan.localAction.kind === "image_generation") {
          await generateArtwork(task, plan.localAction, agentSettings);
          return;
        }
        const note = plan.localAction.kind === "note";
        paintTask(task, "working", note ? "Creating your note…" : "Creating your tab folder…");
        const result = await bridge.browser("assistantLocalTask", plan.localAction);
        const open = el("button", { class: "ghost", onclick: async () => {
          try {
            if (note) await bridge.openTab(`about:lima?note=${encodeURIComponent(result.id)}`);
            else await bridge.browser("assistantRevealGroup", { id: result.id });
          } catch (error) { paintTask(task, "failed", errorText(error)); }
        } }, icon(note ? "note" : "folder"), note ? "Open note" : "Show folder");
        const summary = note ? `Created the note “${result.title}”.` : `Created “${result.title}” with ${result.count} ${result.count === 1 ? "tab" : "tabs"}.`;
        paintTask(task, "complete", open);
        await remember(thread, summary);
        return;
      }
      if (plan.schedule) {
        showSchedule(task, plan.schedule, { ...agentSettings, mascot: plan.mascot });
        return;
      }
      if (plan.answer) {
        paintTask(task, "complete");
        await remember(thread, plan.answer);
        return;
      }
      if (plan.workspaceIds.some(id => !workspaces.has(id))) throw new Error("A workspace changed during planning. Send the request again.");
      plan.pages = pages.filter(Boolean);
      plan.text = text;
      plan.agent = agentSettings;
      if (plan.workspaceIds.length) showApproval(task, plan);
      else await submit(task, plan);
    } catch (error) {
      paintTask(task, "failed", errorText(error));
      remember(thread, `I couldn't finish this: ${errorText(error)}`);
    }
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
      // The thread stays here; its status keeps updating in the entry.
      await remember(task.thread, `Handed off to ${destinations.map(workspace => workspace.name).join(", ")}. I'll track it here.`, task.taskIds);
    } catch (error) {
      paintTask(task, "failed", errorText(error));
      remember(task.thread, `I couldn't hand this off: ${errorText(error)}`);
    }
    finally { draw(); }
  }

  // MARK: Orchestrated tasks: one persistent record per handoff

  const STATES = {
    accepted: "Preparing your task…", planned: "Assigned", queued: "Waiting for available capacity", waiting: "Waiting for agents",
    running: "Working", paused: "Work paused", blocked: "Needs you", verifying: "Verifying results…", completed: "Task completed",
    completed_with_warnings: "Done, with notes", failed: "Failed", canceled: "Stopped",
  };
  const TERMINAL = new Set(["completed", "completed_with_warnings", "failed", "canceled"]);
  const orchestrated = new Map();
  const tracked = new Map();

  function taskView(record) {
    const { task: item, children } = record;
    const active = children.filter(child => ["running", "verifying"].includes(child.state)).length;
    const queued = children.filter(child => ["queued", "waiting"].includes(child.state)).length;
    const last = item.events.at(-1)?.message ?? "";
    const notice = item.attention && !item.attention.dismissed ? item.attention : null;
    const workspace = workspaces.get(item.workspaceID);
    const where = workspace ? (item.state === "accepted" || item.state === "planned" ? `Assigned to ${workspace.name}` : workspace.name) : "";
    const agents = [active ? `${active} ${active === 1 ? "agent" : "agents"} working` : "", queued ? `${queued} queued` : ""].filter(Boolean).join(" · ");
    const actions = [];
    if (workspace) actions.push(el("button", { class: "ghost", onclick: () => openWorkspace(workspace) }, TERMINAL.has(item.state) ? "Review Result" : "Open Workspace"));
    if (!TERMINAL.has(item.state)) actions.push(el("button", { class: "ghost", onclick: () => control("task.cancel", item.id) }, "Stop Task"));
    if (notice) actions.push(el("button", { class: "ghost", onclick: () => control("task.dismiss", item.id) }, "Dismiss"));
    if (notice?.action === "settings") actions.push(el("button", { class: "ghost", onclick: () => bridge.openTab("about:lima?view=integrations&section=agents") }, "Open Settings"));
    if (["paused", "blocked", "failed"].includes(item.state)) actions.push(el("button", { class: "ghost", onclick: () => control("task.resume", item.id) }, item.state === "paused" ? "Resume" : "Retry"));
    return el("div", { class: "companion-task-status", "data-state": item.state },
      el("p", { class: "companion-task-line" }, el("strong", { text: STATES[item.state] ?? item.state }),
        where ? el("span", { class: "muted", text: ` · ${where}` }) : null),
      notice ? el("p", { text: notice.reason }) : last && last !== STATES[item.state] ? el("p", { class: "muted", text: last }) : null,
      notice ? el("p", { class: "muted", text: notice.remedy }) : null,
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
    if (task.thread) paintEntry(task.thread);
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

  // MARK: Request threads

  const THREAD_LIMIT = 30;

  function addThread(conversation, { prepend = false } = {}) {
    const thread = { id: conversation.id, conversation, task: null, entry: null };
    const title = el("span", { class: "companion-entry-title" });
    const state = el("span", { class: "companion-entry-state" });
    const preview = el("span", { class: "companion-entry-preview" });
    const when = el("time", { class: "companion-entry-time" });
    // A chat row: what was asked, where it stands, the latest reply, and a
    // chevron saying it opens.
    thread.entry = el("button", { type: "button", class: "companion-entry", title: "Open this chat", onclick: () => showThread(thread) },
      el("span", { class: "companion-entry-icon", "aria-hidden": "true" }, icon("chat"), el("span", { class: "companion-entry-dot" })),
      el("span", { class: "companion-entry-main" },
        el("span", { class: "companion-entry-line" }, title, when),
        el("span", { class: "companion-entry-line" }, state, preview)),
      icon("chevron", "icon companion-entry-open"));
    thread.parts = { title, state, preview, when };
    threads.set(thread.id, thread);
    requestList.hidden = false;
    if (!requestList.firstChild) {
      requestList.append(el("header", { class: "companion-requests-head" },
        el("h2", { text: "Chats" }), el("span", { text: "Click one to follow up" })));
    }
    if (prepend) requestList.firstChild.after(thread.entry);
    else requestList.append(thread.entry);
    const extra = [...threads.values()].slice(THREAD_LIMIT);
    for (const old of extra) { old.entry.remove(); threads.delete(old.id); }
    paintEntry(thread);
    return thread;
  }

  /** One line per request: what it is, where it stands, when. */
  function threadState(thread) {
    const { task, conversation } = thread;
    const last = conversation.messages?.at(-1);
    if (task?.phase === "approval") return ["blocked", "Needs you"];
    if (conversation.messages?.some(message => message.role === "assistant" && message.status === "streaming")) return ["working", "Replying…"];
    if (task?.phase === "working") return ["working", "Working…"];
    const records = (task?.taskIds ?? []).map(id => orchestrated.get(id)?.task).filter(Boolean);
    const live = records.find(record => !TERMINAL.has(record.state));
    if (live) return [live.state === "blocked" ? "blocked" : "working", STATES[live.state] ?? "Working"];
    if (records.some(record => record.state === "failed")) return ["failed", "Failed"];
    if (last?.status === "failed" || task?.phase === "failed") return ["failed", "Didn't finish"];
    if (records.length) return ["complete", records.some(record => record.state === "completed_with_warnings") ? "Done, with notes" : "Done"];
    return ["complete", conversation.messages?.length > 2 ? "Chat" : "Answered"];
  }

  function paintEntry(thread) {
    const [state, label] = threadState(thread);
    thread.entry.dataset.state = state;
    thread.parts.title.textContent = thread.conversation.title || thread.conversation.messages?.[0]?.text || "Request";
    thread.parts.state.textContent = label;
    const messages = (thread.conversation.messages ?? []).filter(message => message.text);
    const replies = messages.filter(message => message.role === "assistant");
    const latest = replies.at(-1)?.text?.replace(/\s+/g, " ").trim() || thread.conversation.preview || "";
    thread.parts.preview.textContent = latest ? `· ${latest}` : messages.length > 1 ? `· ${messages.length} messages` : "";
    const at = thread.conversation.updatedAt ?? thread.conversation.createdAt;
    thread.parts.when.textContent = at ? relativeTime(at) : "";
    if (openThread === thread) paintThread();
  }

  /** Records what Lima did, so the thread can continue with context. */
  async function remember(thread, text, taskIds = []) {
    if (!thread) return;
    if (thread.conversation.local) {
      thread.conversation.messages.push({ id: crypto.randomUUID(), role: "assistant", text, status: "complete" });
      paintEntry(thread);
      return;
    }
    try { thread.conversation = await call("chat.record", { id: thread.id, role: "assistant", text, taskIds }); }
    catch {}
    paintEntry(thread);
  }

  function showList() {
    openThread = null;
    view = null;
    threadView.hidden = true;
    threadView.replaceChildren();
    listView.hidden = false;
    input.focus();
  }

  async function showThread(thread) {
    openThread = thread;
    listView.hidden = true;
    threadView.hidden = false;
    if (!thread.conversation.local && (!thread.conversation.messages || thread.conversation.placeholder)) {
      try { thread.conversation = await call("chat.get", { id: thread.id }); } catch {}
    }
    if (openThread !== thread) return;
    paintThread(true);
  }

  function messageView(message) {
    if (message.role === "user" && message.status === "queued") {
      const thread = openThread;
      const adopt = updated => { if (updated) { thread.conversation = updated; paintEntry(thread); } };
      return el("div", { class: "companion-msg user queued" }, el("div", { class: "bubble", text: message.text }),
        queuedActions({
          interrupt: () => call("chat.interrupt", { id: thread.id, messageId: message.id }).then(adopt, error => threadNotice(errorText(error))),
          edit: () => call("chat.unqueue", { id: thread.id, messageId: message.id }).then(updated => {
            adopt(updated);
            if (view) { restoreDraft(view.field, [message.text]); view.field.focus(); }
          }, error => threadNotice(errorText(error))),
        }));
    }
    if (message.role === "user" && message.attachments?.length) {
      return el("div", { class: "companion-msg user" }, sentAttachments(message.attachments), el("div", { class: "bubble", text: message.text }));
    }
    if (message.role === "user") return el("div", { class: "companion-msg user" }, el("div", { class: "bubble", text: message.text }));
    const node = el("div", { class: "companion-msg assistant", "data-status": message.status });
    if (message.notice) node.append(el("p", { class: "msg-notice" }, icon("redo"), el("span", { text: message.notice })));
    const images = (message.steps ?? []).flatMap(step => step.images ?? []);
    if (images.length && openThread) node.append(mediaStrip(openThread.id, images.slice(-6)));
    const body = message.text ? markdown(message.text) : el("p", { class: "muted", text: message.status === "streaming" ? "Thinking…" : "" });
    if (message.status === "streaming") body.classList.add("typing");
    node.append(body);
    if (message.status === "failed" && message.error) {
      node.append(el("div", { class: "failure" }, el("span", { class: "grow", text: message.error.message }),
        el("button", { class: "ghost", onclick: async event => {
          event.currentTarget.disabled = true;
          try { openThread.conversation = await call("chat.retry", { id: openThread.id, messageId: message.id }); paintThread(); }
          catch (error) { threadNotice(errorText(error)); }
        } }, "Retry")));
    }
    return node;
  }

  // The open thread's view is built once; repaints update its parts so the
  // reply box keeps focus and text while answers stream in.
  let view = null;
  function threadNotice(text) { if (view) view.status.textContent = text; }

  function buildThread(thread) {
    const field = el("textarea", { rows: 2, placeholder: "Reply…", "aria-label": "Follow-up" });
    const reply = el("button", { class: "primary companion-thread-send", type: "submit", title: "Send", "aria-label": "Send" }, icon("send"));
    // While Lima replies: Send queues, Send Now (⌘↩) interrupts, Stop stops.
    const now = el("button", { type: "button", class: "ghost send-now", title: "Stop the reply and send this now (⌘↩)", hidden: true,
      onclick: () => followUp(thread, field, "interrupt") }, "Send Now");
    const stop = el("button", { type: "button", class: "ghost icon-only", title: "Stop the reply", "aria-label": "Stop the reply", hidden: true,
      onclick: async () => {
        try {
          const result = await call("chat.cancel", { id: thread.id });
          if (result?.unsent?.length) restoreDraft(field, result.unsent);
        } catch (error) { threadNotice(errorText(error)); }
      } }, icon("stop"));
    const hint = el("p", { class: "composer-hint", text: QUEUE_HINT, hidden: true });
    const tray = attachmentTray({ conversation: () => thread.id, input: field });
    // Provider and model for this chat, switchable at any time: a reply in
    // progress restarts on the new choice.
    const controls = agentControls({
      onChange: async choice => {
        if (thread.conversation.local) return;
        thread.conversation = await call("chat.configure", { id: thread.id, ...choice });
        paintEntry(thread);
      },
      onError: error => threadNotice(errorText(error)),
    });
    if (!thread.conversation.local && thread.conversation.provider) controls.show(thread.conversation, false);
    const form = el("form", { class: "companion-thread-composer composer-box", onsubmit: event => { event.preventDefault(); followUp(thread, field); } },
      tray.node, field, el("div", { class: "composer-row" }, controls.provider, controls.model, el("span", { class: "spacer" }), stop, now, reply), hint);
    field.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); followUp(thread, field, sendMode(event)); }
    });
    const title = el("strong", { class: "grow" });
    const state = el("span", { class: "companion-entry-state" });
    const log = el("div", { class: "companion-thread-log", role: "log", "aria-live": "polite" });
    const status = el("p", { class: "companion-thread-status", role: "status" });
    threadView.replaceChildren(
      el("header", { class: "companion-thread-head" },
        el("button", { type: "button", class: "ghost icon-only", title: "All requests", "aria-label": "All requests", onclick: showList }, icon("arrow", "icon companion-back")),
        title, state),
      log, status, form);
    view = { thread, field, reply, now, stop, hint, title, state, log, status, controls, tray };
  }

  function paintThread(focus = false) {
    const thread = openThread;
    if (!thread) return;
    if (view?.thread !== thread) buildThread(thread);
    const { conversation, task } = thread;
    const [state, label] = threadState(thread);
    view.title.textContent = conversation.title || "Request";
    view.state.dataset.state = state;
    view.state.textContent = label;
    const atBottom = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 40;
    view.log.replaceChildren(...(conversation.messages ?? []).map(messageView),
      task?.reply?.childElementCount ? el("div", { class: "companion-thread-live" }, task.reply) : null);
    if (atBottom || focus) view.log.scrollTop = view.log.scrollHeight;
    const streaming = conversation.messages?.some(message => message.status === "streaming");
    view.reply.disabled = !!conversation.local;
    view.reply.title = streaming ? "Send after this reply (↩)" : "Send";
    view.now.hidden = view.stop.hidden = view.hint.hidden = !streaming || !!conversation.local;
    view.controls.provider.disabled ||= !!conversation.local;
    view.controls.model.disabled ||= !!conversation.local;
    view.field.placeholder = conversation.local ? "This request couldn't be saved, so it can't be continued." : streaming ? "Lima is replying… add a message for after" : "Reply…";
    if (focus) view.field.focus();
  }

  /** A follow-up continues the same thread, with the whole exchange (and the
   * latest status of any handed-off work) as context. Provider usage limits
   * fail over on the runtime; the reply notes the switch. */
  async function followUp(thread, field, mode = "queue") {
    const tray = view?.thread === thread ? view.tray : null;
    const text = field.value.trim() || (tray?.count ? "See the attached files." : "");
    if (!text || thread.conversation.local) return;
    let attachments = [];
    try { attachments = tray?.ready() ?? []; } catch (error) { threadNotice(errorText(error)); return; }
    field.value = "";
    try {
      const records = (thread.task?.taskIds ?? []).map(id => orchestrated.get(id)?.task).filter(Boolean);
      const status = records.map(record => `${workspaces.get(record.workspaceID)?.name ?? record.title}: ${STATES[record.state] ?? record.state}` +
        (record.outcome ? ` — ${record.outcome}` : record.events?.at(-1)?.message ? ` — ${record.events.at(-1).message}` : "")).join("\n");
      if (status && status !== thread.lastStatus) {
        thread.conversation = await call("chat.record", { id: thread.id, role: "assistant", text: `Status of the handed-off work:\n${status}` });
        thread.lastStatus = status;
      }
      thread.conversation = await call("chat.send", { id: thread.id, text, mode, attachments });
      tray?.clear();
      paintEntry(thread);
    } catch (error) {
      field.value = text;
      threadNotice(errorText(error));
    }
  }

  /** Reopening the Companion lists recent requests with their status. */
  async function restoreThreads() {
    const summaries = await call("chat.list", { companion: true }).catch(() => []);
    summaries.sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt));
    for (const summary of summaries.slice(0, THREAD_LIMIT)) {
      if (threads.has(summary.id)) continue;
      const conversation = { ...summary, messages: undefined };
      const thread = addThread(conversation);
      // Status for the summary line before the thread is opened.
      if (summary.running) conversation.messages = [{ role: "assistant", status: "streaming" }];
      else if (summary.lastStatus === "failed") conversation.messages = [{ role: "assistant", status: "failed" }];
      if (summary.taskIDs?.length) {
        const task = { reply: el("div", { class: "companion-task-reply" }), phase: "tracked", taskIds: summary.taskIDs, thread };
        thread.task = task;
        tasks.push(task);
        for (const id of summary.taskIDs) {
          tracked.set(id, task);
          const record = await call("task.get", { id }).catch(() => null);
          if (record) orchestrated.set(id, record);
        }
        paintTracked(task);
      }
      // Status summaries above aren't real messages; load them on open.
      if (!summary.running && summary.lastStatus !== "failed") conversation.messages = undefined;
      else conversation.placeholder = true;
      paintEntry(thread);
    }
  }

  function chatEvent(event, data) {
    if (event === "chat.updated" && threads.has(data?.id)) {
      const thread = threads.get(data.id);
      thread.conversation = data;
      paintEntry(thread);
      return true;
    }
    if (event === "chat.delta" && threads.has(data?.conversationId)) {
      const thread = threads.get(data.conversationId);
      const message = thread.conversation.messages?.find(item => item.id === data.messageId);
      if (message) { message.text = (message.text ?? "") + data.text; if (openThread === thread) paintThread(); }
      return true;
    }
    return false;
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
    if (chatEvent(event, data)) return;
    if (event === "task.updated" && data) {
      const root = data.parentID ?? data.id;
      if (tracked.has(root)) {
        if (!data.parentID) { const record = orchestrated.get(root); if (record) record.task = data; paintTracked(tracked.get(root)); }
        refreshTask(root);
      }
      return;
    }
    if (event === "schedule.updated" || event === "schedule.deleted") { drawSchedules(); return; }
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
  window.addEventListener("pagehide", () => { generationLifetime.abort(); unsubscribe(); unwatch(); }, { once: true });

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
  drawSchedules();
  await restoreThreads();
  await agent.ready;
  draw();
}
