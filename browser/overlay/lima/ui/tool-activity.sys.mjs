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
  image_open: ["Opening image", "image", "read"],
  image_generate: ["Queuing image generation", "image", "planning"],
  image_generation_status: ["Checking image generation", "image", "read"],
  image_select_subject: ["Selecting foreground", "image", "read"],
  image_remove_background: ["Applying foreground mask", "image", "write"],
  image_inspect: ["Inspecting image", "image", "read"],
  image_sample_color: ["Sampling image color", "image", "read"],
  image_color_key: ["Removing background color", "image", "write"],
  image_mask: ["Applying image mask", "image", "write"],
  image_crop: ["Cropping image", "image", "write"],
  image_resize: ["Resizing image", "image", "write"],
  image_export: ["Exporting image", "image", "test"],
  vector_trace: ["Tracing vector paths", "image", "write"],
  vector_edit_nodes: ["Editing path nodes", "image", "write"],
  vector_export: ["Verifying SVG export", "image", "test"],
  animation_tween: ["Rendering in-between frames", "image", "write"],
  animation_export: ["Verifying animation export", "image", "test"],
  lima_search: ["Searching Lima", "search", "read"],
  mcp_tool_call: ["Using an MCP tool", "integrations", "tool"],
};

export function toolActivity(raw) {
  const separator = raw.indexOf(": ");
  const qualified = separator < 0 ? raw : raw.slice(0, separator);
  let detail = separator < 0 ? "" : raw.slice(separator + 2);
  const match = /^mcp__(.+?)__(.+)$/.exec(qualified);
  const name = (match?.[2] ?? qualified.replace(/^lima_(?=workspace_|agent_|agents_|notes_|image_|vector_|animation_)/, "")).toLowerCase();
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
  if (message?.status === "queued") return { state: "waiting", label: "Waiting to start", icon: "note", motion: "waiting" };
  if (message?.status === "streaming") {
    const startedAt = message.createdAt;
    if (message.progress === "reconnecting") {
      return { state: "working", label: "Reconnecting", detail: providerName, icon: "activity", motion: "think", startedAt };
    }
    const doing = tool ?? ({ terminal: "workspace_run", tab: "workspace_read_tab" }[surface]);
    if (doing) {
      const { label, detail, icon, kind } = toolActivity(doing);
      return { state: kind === "blocked" ? "waiting" : "working", label, detail, icon, motion: kind === "blocked" ? "waiting" : kind, startedAt };
    }
    if (message.hasText ?? !!message.text?.trim()) {
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
  if (message?.status === "complete") return { state: "complete", label: "Reply ready", icon: "check", motion: "idle" };
  return { state: "idle", label: "Ready" };
}

// Past-tense verbs for the step log ("Edited Handlers.swift").
const DONE = {
  edit: "Edited", multiedit: "Edited", write: "Wrote", read: "Read", notebookedit: "Edited", apply_patch: "Patched", file_change: "Changed",
  bash: "Ran", shell: "Ran", terminal_run: "Ran", workspace_run: "Ran", grep: "Searched for", glob: "Found files", web_search: "Searched the web for",
  web_fetch: "Read", workspace_open_tab: "Opened", workspace_read_tab: "Read tab", workspace_note: "Wrote note",
};
const FILE_TOOLS = new Set(["edit", "multiedit", "write", "read", "notebookedit"]);
const COMMAND_TOOLS = new Set(["bash", "shell", "terminal_run", "workspace_run"]);

function jsonField(detail, names) {
  for (const name of names) {
    const match = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(detail);
    if (match) {
      try { return JSON.parse(`"${match[1]}"`); } catch { return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/"); }
    }
  }
  return "";
}

/** A step for the log: what it did, on what, shown by kind.
 *  { verb, kind: "file" | "files" | "command" | "pattern" | "url" | "text", target, dir, note } */
export function stepParts(raw, { cwd = "" } = {}) {
  const separator = raw.indexOf(": ");
  const qualified = separator < 0 ? raw : raw.slice(0, separator);
  const detail = separator < 0 ? "" : raw.slice(separator + 2);
  const bare = (/^mcp__(.+?)__(.+)$/.exec(qualified)?.[2] ?? qualified).replace(/^lima_/, "").toLowerCase();
  const name = { websearch: "web_search", webfetch: "web_fetch" }[bare] ?? bare;
  const json = /^[{[]/.test(detail);
  const relative = path => {
    const base = cwd.replace(/\/$/, "");
    return base && path.startsWith(base + "/") ? path.slice(base.length + 1) : path.replace(/^\/Users\/[^/]+/, "~");
  };
  if (FILE_TOOLS.has(name)) {
    const path = relative(json ? jsonField(detail, ["file_path", "path", "notebook_path"]) : detail);
    const slash = path.lastIndexOf("/");
    if (path) return { verb: DONE[name], kind: "file", target: path.slice(slash + 1), dir: slash > 0 ? path.slice(0, slash + 1) : "", full: path };
  }
  if (name === "file_change" || name === "apply_patch") {
    const files = (json ? jsonField(detail, ["path"]) : detail).split(/,\s*/).filter(Boolean).map(relative);
    if (files.length) return { verb: DONE[name], kind: "files", target: files.map(file => file.split("/").pop()).join(", "), full: files.join("\n") };
  }
  if (COMMAND_TOOLS.has(name)) {
    const command = (json ? jsonField(detail, ["command", "cmd"]) : detail).trim();
    const note = json ? jsonField(detail, ["description"]) : "";
    if (command) return { verb: DONE[name], kind: "command", target: command, note, full: command };
  }
  if (name === "grep" || name === "glob") {
    const pattern = json ? jsonField(detail, ["pattern", "query"]) : detail;
    const where = json ? relative(jsonField(detail, ["path"])) : "";
    if (pattern) return { verb: DONE[name], kind: "pattern", target: pattern, note: where ? `in ${where}` : "", full: pattern };
  }
  const { label, detail: short, server } = toolActivity(raw);
  const url = json ? jsonField(detail, ["url"]) : /^https?:/.test(detail) ? detail : "";
  if (url) {
    let shown = url;
    try { const parsed = new URL(url); shown = parsed.host.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, ""); } catch {}
    return { verb: DONE[name] ?? label, kind: "url", target: shown, full: url, note: server };
  }
  const query = name === "web_search" && json ? jsonField(detail, ["query"]) : "";
  if (query) return { verb: DONE[name], kind: "text", target: `“${query}”`, full: query };
  return { verb: label, kind: "text", target: short, note: server, full: short };
}

/** One line for a finished reply: the summary of its lima-report when it
 * has one, otherwise its prose with code blocks and Markdown marks removed,
 * so a list never shows a report's raw JSON. */
export function replyPreview(text, limit = 160) {
  const source = String(text ?? "");
  let summary = "";
  const report = /```lima-report[^\n]*\n([\s\S]*?)(?:\n```|$)/.exec(source);
  if (report) { try { summary = JSON.parse(report[1])?.summary; } catch {} }
  const prose = source.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/[#*_`>|]+/g, "").replace(/\s+/g, " ").trim();
  const line = typeof summary === "string" && summary.trim() ? summary.replace(/\s+/g, " ").trim() : prose;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
