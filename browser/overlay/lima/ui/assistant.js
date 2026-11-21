import { activityStatus, bridge, call, el, errorText, filesPrivacyButton, icon, markdown, onEvent, prefs, setPage } from "./lib.js";
import { agentControls } from "./composer.js";
import { companion, setCompanionState } from "./companion.js";
import { workspacePrompts } from "./workspace-prompts.js";
import { failureActivity, isFolderPermissionError, lastVisibleTool, replyActivity } from "./tool-activity.sys.mjs";

export async function renderAssistant(app, _initialWorkspace, { home = false } = {}) {
  setPage(home ? "Lima" : "Lima Companion", "lima");
  const workspaces = new Map();
  const conversations = new Map();
  const input = el("textarea", { rows: home ? 3 : 2, placeholder: "Ask a question or describe a task", "aria-label": "Question or task" });
  const character = companion(home ? "home" : "status");
  const send = el("button", { class: "primary", onclick: delegate, disabled: true }, icon("send"), "Send");
  const activity = activityStatus();
  const target = el("strong", { hidden: true });
  const openAgent = el("button", { class: "ghost", hidden: true, onclick: () => openWorkspace(shownWorkspace) }, "Open agent", icon("arrow"));
  const recovery = el("div", { class: "row", hidden: true });
  const status = el("div", { class: "handoff" }, el("div", { class: "grow" }, target, activity.node, recovery), openAgent);
  const recent = el("div", { class: "handoff-recent" });
  const prompts = workspacePrompts();
  const answer = el("section", { class: "companion-answer", hidden: true, "aria-live": "polite" });
  const approval = el("section", { class: "workspace-prompts", hidden: true });
  const agent = agentControls();
  const providerHelp = el("details", { class: "assistant-providers", hidden: true });
  const draftKey = "assistant.draft";
  input.value = prefs.get(draftKey, "");
  let pending = false;
  let handedOff;
  let ready = false;
  let shownWorkspace;
  let requestError;
  let conversationRevision = 0;
  let proposed;

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
      status, answer, approval, prompts.node, recent, home ? null : providerHelp)));

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
    const current = conversations.get(workspace.conversationID);
    return replyActivity(current?.message, { provider: current?.provider, tool: current?.tool });
  }

  function reportError(error) { requestError = error; paintActivity(); }

  function openWorkspace(workspace) {
    if (workspace) bridge.browser("openChat", { id: workspace.id }).catch(reportError);
  }

  function paintActivity() {
    shownWorkspace = workspaces.get(handedOff) ?? [...workspaces.values()].find(workspace =>
      !workspace.parentID && conversations.get(workspace.conversationID)?.message?.status === "streaming");
    const current = shownWorkspace && conversations.get(shownWorkspace.conversationID)?.message;
    const next = requestError ? failureActivity(requestError, ready ? "Workspace request failed" : "Workspaces unavailable")
      : !ready ? { state: "starting", label: "Loading workspaces", icon: "workspace", motion: "think" }
      : pending ? { state: "starting", label: "Reviewing the request", icon: "workspace", motion: "think" }
      : shownWorkspace ? describe(shownWorkspace) : { state: "idle", label: "Ready to delegate" };
    status.hidden = home && ready && !pending && !requestError && !shownWorkspace;
    target.hidden = openAgent.hidden = !shownWorkspace || pending || !!requestError;
    target.textContent = shownWorkspace?.name ?? "";
    activity.update(next);
    setCompanionState(character, next.motion ?? "idle");
    recovery.replaceChildren(
      requestError && !ready ? el("button", { class: "ghost", onclick: load }, "Retry") : null,
      isFolderPermissionError(requestError ?? current?.error) ? filesPrivacyButton(reportError) : null);
    recovery.hidden = !recovery.childElementCount;
    send.disabled = !ready || pending || !!proposed || !agent.settings().provider;
  }

  function draw() {
    const roots = [...workspaces.values()].filter(workspace => !workspace.parentID);
    const rows = roots.slice(0, home ? 6 : 10).map(workspace => {
      const { label, state, detail } = describe(workspace);
      return el("button", { class: "ghost handoff-workspace", onclick: () => openWorkspace(workspace) },
        icon("workspace"), el("span", { class: "grow", text: workspace.name }),
        el("span", { class: "handoff-state", "data-state": state, text: label, title: detail }));
    });
    recent.replaceChildren(...(rows.length ? [el("h2", { text: home ? "Continue" : "Workspaces" }), ...rows] : []));
    paintActivity();
  }

  function showApproval(plan) {
    proposed = plan;
    approval.hidden = !plan;
    if (!home) bridge.browser("assistantAttention", { pending: !!plan }).catch(() => {});
    if (!plan) { approval.replaceChildren(); return; }
    const destinations = plan.workspaceIds.map(id => workspaces.get(id)?.name).filter(Boolean);
    approval.replaceChildren(el("article", {},
      el("strong", { text: "Connect to workspaces?" }),
      el("p", { text: destinations.join(", ") }),
      plan.pages.length ? el("p", { class: "muted", text: "Relevant tab content will be shared with these agents." }) : null,
      el("div", { class: "row" },
        el("button", { class: "primary", onclick: () => { showApproval(null); submit(plan); } }, "Approve handoff"),
        el("button", { class: "ghost", onclick: () => { showApproval(null); draw(); } }, "Cancel"))));
  }

  async function delegate() {
    const text = input.value.trim();
    if (!text || pending || !ready || proposed || !agent.settings().provider) return;
    pending = true;
    requestError = undefined;
    paintActivity();
    answer.hidden = true;
    try {
      await agent.ready;
      const tabs = await bridge.browser("assistantTabs", {});
      const metadata = tabs.map(({ title, url, live }, index) => ({ title, site: new URL(url).hostname, live, index }));
      const agentSettings = agent.settings();
      const first = await call("assistant.plan", { text, ...agentSettings, tabs: metadata });
      const pages = await Promise.all([...new Set(first.tabIndexes)].map(async index => {
        const tab = tabs[index];
        if (!tab) return null;
        const excerpt = await bridge.browser("assistantReadTab", { id: tab.id, url: tab.url }).catch(() => "");
        metadata[index].excerpt = excerpt;
        return { ...tab, excerpt };
      }));
      const plan = pages.some(page => page?.excerpt)
        ? await call("assistant.plan", { text, ...agentSettings, tabs: metadata })
        : first;
      if (plan.answer) {
        answer.replaceChildren(el("strong", { text: text }), markdown(plan.answer));
        answer.hidden = false;
        if (input.value.trim() === text) {
          input.value = "";
          prefs.set(draftKey, "");
        }
        return;
      }
      if (!home) close().catch(() => {});
      if (plan.workspaceIds.some(id => !workspaces.has(id))) throw new Error("A workspace changed during planning. Send the request again.");
      plan.pages = pages.filter(Boolean);
      plan.text = text;
      plan.agent = agentSettings;
      if (plan.workspaceIds.length) showApproval(plan);
      else await submit(plan);
    } catch (error) {
      requestError = error;
      if (!home) bridge.browser("assistantAttention", { pending: true }).catch(() => {});
    } finally { pending = false; draw(); }
  }

  async function submit(plan) {
    pending = true;
    paintActivity();
    try {
      const pages = plan.pages.map(tab => [tab.title, tab.url, tab.excerpt].filter(Boolean).join("\n"));
      const revision = conversationRevision;
      for (const id of plan.workspaceIds.length ? plan.workspaceIds : [undefined]) {
        const { workspace, conversation } = await call("assistant.delegate", {
          id, name: plan.newName, text: plan.text, mascot: plan.mascot, ...plan.agent, references: pages.join("\n\n"),
        });
        workspaces.set(workspace.id, workspace);
        handedOff = workspace.id;
        if (revision === conversationRevision || !conversations.get(conversation.id)?.message?.id) rememberConversation(conversation);
      }
      if (input.value.trim() === plan.text) {
        input.value = "";
        prefs.set(draftKey, "");
      }
      if (!home) close().catch(() => {});
    } catch (error) {
      handedOff = undefined;
      requestError = error;
      if (!home) bridge.browser("assistantAttention", { pending: true }).catch(() => {});
    } finally {
      pending = false;
      draw();
    }
  }

  function rememberConversation(data) {
    const message = data.messages?.findLast(item => item.role === "assistant");
    const prior = conversations.get(data.id);
    const tool = prior?.message?.id === message?.id && prior?.message?.tools?.length === message?.tools?.length
      ? prior?.tool : lastVisibleTool(message?.tools);
    conversations.set(data.id, { message, tool, provider: data.provider });
  }

  const queued = [];
  function update(event, data) {
    if (event === "workspace.deleted") {
      conversations.delete(workspaces.get(data.id)?.conversationID);
      workspaces.delete(data.id);
      if (data.id === handedOff) handedOff = undefined;
    }
    else if (event === "chat.updated") rememberConversation(data);
    else workspaces.set(data.id, data);
  }
  const unsubscribe = onEvent(({ event, data }) => {
    if (event === "integrations.setup.updated" && data?.phase === "done") {
      agent.refresh().then(draw);
      if (!home) loadProviderHelp();
    }
    if (event === "chat.delta") {
      const current = conversations.get(data.conversationId);
      if (current?.message?.id === data.messageId && (current.tool || !current.message.text?.trim()) && data.text?.trim()) {
        conversationRevision++;
        current.message = { ...current.message, text: data.text };
        current.tool = undefined;
        draw();
      }
      return;
    }
    if (!["workspace.created", "workspace.updated", "workspace.deleted", "chat.updated"].includes(event)) return;
    if (event === "chat.updated") conversationRevision++;
    if (!ready) queued.push([event, data]);
    else { update(event, data); draw(); }
  });
  window.addEventListener("pagehide", unsubscribe, { once: true });

  async function load() {
    requestError = undefined;
    paintActivity();
    try {
      const [all, chats] = await Promise.all([call("workspace.list"), call("chat.list")]);
      for (const workspace of all) workspaces.set(workspace.id, workspace);
      for (const chat of chats) conversations.set(chat.id, { provider: chat.provider, message: {
        status: chat.running ? "streaming" : chat.lastStatus, error: { kind: chat.lastErrorKind }, progress: chat.lastProgress,
      } });
      for (const [event, data] of queued.splice(0)) update(event, data);
      ready = true;
      draw();
    } catch (error) { reportError(error); }
  }
  await load();
  await agent.ready;
  draw();
}
