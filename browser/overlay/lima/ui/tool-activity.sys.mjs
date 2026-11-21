const TOOLS = {
  workspace_name: ["Naming workspace", "workspace", "write"],
  workspace_new: ["Creating workspace", "workspace", "tabs"],
  workspace_open_tab: ["Opening tab", "tab", "tabs"],
  workspace_close_tab: ["Closing tab", "close", "tabs"],
  workspace_read_tab: ["Reading tab", "globe", "read"],
  workspace_list_tabs: ["Checking tabs", "list", "read"],
  workspace_run: ["Running command", "terminal", "terminal"],
  workspace_location: ["Requesting approximate location", "search", "blocked"],
  workspace_ask_user: ["Waiting for your answer", "warning", "blocked"],
  workspace_browser_plan: ["Waiting for browser approval", "warning", "blocked"],
  agent_dismiss: ["Closing finished helper", "agents", "delegate"],
  workspace_note: ["Writing note", "note", "write"],
  workspace_bookmark: ["Saving bookmark", "bookmark", "write"],
  workspace_browser: ["Using the browser", "globe", "tabs"],
  workspace_files: ["Listing files", "folder", "read"],
  workspace_info: ["Checking workspace", "workspace", "read"],
  agent_spawn: ["Starting helper", "agents", "delegate"],
  agents_status: ["Checking helpers", "agents", "delegate"],
  shell: ["Running command", "terminal", "terminal"],
  bash: ["Running command", "terminal", "terminal"],
  terminal_run: ["Running command", "terminal", "terminal"],
  terminal_read: ["Reading terminal", "terminal", "read"],
  file_change: ["Editing files", "file", "write"],
  edit: ["Editing file", "file", "write"],
  multiedit: ["Editing files", "file", "write"],
  apply_patch: ["Applying patch", "file", "write"],
  write: ["Writing file", "file", "write"],
  read: ["Reading file", "file", "read"],
  grep: ["Searching files", "search", "read"],
  glob: ["Finding files", "folder", "read"],
  web_search: ["Searching the web", "search", "read"],
  web_fetch: ["Reading web page", "globe", "read"],
  notes_list: ["Listing notes", "notebook", "read"],
  notes_get: ["Reading note", "note", "read"],
  notes_append: ["Updating note", "note", "write"],
  lima_search: ["Searching Lima", "search", "read"],
  mcp_tool_call: ["Using an MCP tool", "integrations", "tool"],
};

export function toolActivity(raw) {
  const separator = raw.indexOf(": ");
  const qualified = separator < 0 ? raw : raw.slice(0, separator);
  let detail = separator < 0 ? "" : raw.slice(separator + 2);
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified);
  const name = (match?.[2] ?? qualified.replace(/^lima_(?=workspace_|agent_|agents_|notes_)/, "")).toLowerCase();
  const key = { websearch: "web_search", webfetch: "web_fetch" }[name] ?? name;
  const browserActions = { inspect: "Inspecting page", click: "Clicking page", type: "Typing on page", scroll: "Scrolling page", screenshot: "Taking screenshot" };
  const browserAction = key === "workspace_browser" ? /"action"\s*:\s*"([a-z]+)"/.exec(detail)?.[1] : null;
  const known = browserAction && browserActions[browserAction] ? [browserActions[browserAction], "globe", "tabs"]
    : Object.hasOwn(TOOLS, key) ? TOOLS[key] : null;
  const [label, icon, kind] = known ?? [name.replaceAll("_", " ").replace(/^./, first => first.toUpperCase()), "integrations", "tool"];
  if (/^[{[]/.test(detail)) {
    const field = /"(?:url|command|title|name|path|file_path|pattern|query)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(detail);
    detail = field ? field[1].replace(/\\\//g, "/").replace(/\\"/g, '"') : "";
  }
  if (/^https?:/.test(detail)) {
    try {
      const url = new URL(detail);
      detail = url.host + url.pathname.replace(/\/$/, "");
    } catch {}
  }
  return {
    label, icon, kind,
    detail: detail.length > 64 ? detail.slice(0, 61) + "…" : detail,
    server: match?.[1] === "lima" ? "" : match?.[1] ?? "",
  };
}

export function lastVisibleTool(tools) {
  return tools?.findLast(tool => !/^(ToolSearch|TodoWrite)\b/.test(tool));
}

const FAILURE_LABELS = {
  missing_executable: "CLI unavailable", authentication: "Sign-in needed", model_rejected: "Model unavailable",
  incompatible_version: "CLI version incompatible", connection: "Connection problem", rate_limited: "Rate limited",
  permission_denied: "Permission needed", not_authorized: "Permission needed", process_crashed: "CLI stopped unexpectedly",
  deadline_exceeded: "Request timed out", cancelled: "Stopped",
};

export function isFolderPermissionError(error) {
  return /macOS denied access|Files & Folders|denied access to (?:the )?(?:folder|directory)|(?:permission denied|operation not permitted).*\b(?:folder|directory|chdir)\b|\b(?:folder|directory|chdir)\b.*(?:permission denied|operation not permitted)/i.test(error?.message ?? String(error));
}

export function failureActivity(error, fallback = "Request failed") {
  const kind = error?.kind ?? error?.code;
  const folderDenied = isFolderPermissionError(error);
  const blocked = folderDenied || ["permission_denied", "not_authorized", "authentication"].includes(kind);
  const state = kind === "cancelled" ? "idle" : blocked ? "blocked" : kind === "connection" || kind === "bridge" ? "disconnected" : "failed";
  return {
    state, label: folderDenied ? "Folder access blocked" : FAILURE_LABELS[kind] ?? fallback,
    detail: error?.message ?? "", icon: kind === "cancelled" ? "pause" : "warning",
    motion: kind === "cancelled" ? "paused" : blocked ? "blocked" : "failed",
  };
}

export function replyActivity(message, { tool, provider, surface } = {}) {
  const providerName = { claude: "Claude", codex: "Codex", opencode: "OpenCode" }[provider] ?? provider;
  if (message?.status === "streaming" || message?.status === "queued") {
    const startedAt = message.createdAt;
    if (message.progress === "reconnecting") {
      return { state: "working", label: "Reconnecting", detail: providerName, icon: "activity", motion: "think", startedAt };
    }
    const doing = tool ?? ({ terminal: "workspace_run", tab: "workspace_read_tab" }[surface]);
    if (doing) {
      const { label, detail, icon, kind } = toolActivity(doing);
      return { state: "working", label, detail, icon, motion: kind, startedAt };
    }
    if (message.text?.trim()) {
      return { state: "working", label: "Writing a reply", icon: "note", motion: "write", startedAt };
    }
    if (message.progress) {
      const label = message.progress === "thinking" ? "Working on the request" : "Provider connected";
      return { state: "working", label, detail: providerName, icon: "notebook", motion: "think", startedAt };
    }
    return { state: "starting", label: providerName ? `Waiting for ${providerName}` : "Waiting for the provider",
      detail: "Waiting for the first reply or tool call", icon: "notebook", motion: "think", startedAt };
  }
  if (message?.status === "failed") return failureActivity(message.error, "Reply failed");
  if (message?.status === "complete") return { state: "complete", label: "Completed", icon: "check", motion: "complete" };
  return { state: "idle", label: "Ready" };
}
