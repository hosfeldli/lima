import { replyPreview, stepParts, toolActivity } from "./tool-activity.sys.mjs";

/* The story of an agent's work, for the workspace page: each request you made
 * becomes a chapter, the agent's steps become a few beats (consecutive steps
 * of the same kind grouped, with examples), and the chapter ends with how it
 * turned out. Pure: tested in Node. */

const BEATS = {
  read: { icon: "globe", done: n => n === 1 ? "Looked something up" : `Looked into ${n} things`, live: "Reading" },
  tabs: { icon: "tab", done: n => n === 1 ? "Used the browser" : `Took ${n} steps in the browser`, live: "Working in the browser" },
  write: { icon: "note", done: n => n === 1 ? "Made a change" : `Made ${n} changes`, live: "Writing" },
  terminal: { icon: "terminal", done: n => n === 1 ? "Ran a command" : `Ran ${n} commands`, live: "Running a command" },
  test: { icon: "check", done: n => n === 1 ? "Checked the result" : `Ran ${n} checks`, live: "Checking results" },
  blocked: { icon: "warning", done: () => "Asked you", live: "Waiting for you" },
  delegate: { icon: "agents", done: n => n === 1 ? "Brought in a helper" : `Coordinated ${n} helper steps`, live: "Working with helpers" },
  planning: { icon: "spark", done: () => "Started a long job", live: "Planning" },
  tool: { icon: "integrations", done: n => n === 1 ? "Used a tool" : `Used ${n} tools`, live: "Using a tool" },
};

const quiet = raw => /^(ToolSearch|TodoWrite)\b/.test(raw);

/** Beats for one reply's steps. */
export function beats(tools, { cwd = "", live = false } = {}) {
  const out = [];
  for (const raw of (tools ?? []).filter(tool => !quiet(tool))) {
    const { kind } = toolActivity(raw);
    const part = stepParts(raw, { cwd });
    const beat = out.at(-1);
    const target = part.target ? String(part.target).slice(0, 48) : "";
    if (beat && beat.kind === (BEATS[kind] ? kind : "tool")) {
      beat.count += 1;
      if (target && !beat.examples.includes(target) && beat.examples.length < 3) beat.examples.push(target);
    } else {
      out.push({ kind: BEATS[kind] ? kind : "tool", count: 1, examples: target ? [target] : [] });
    }
  }
  return out.map((beat, index) => {
    const spec = BEATS[beat.kind];
    const current = live && index === out.length - 1;
    return { ...beat, icon: spec.icon, live: current, sentence: current ? spec.live : spec.done(beat.count) };
  });
}

/** Chapters for the last `limit` requests in a conversation, oldest first. */
export function storyChapters(messages, { cwd = "", limit = 3 } = {}) {
  const list = messages ?? [];
  const chapters = [];
  list.forEach((message, index) => {
    if (message.role !== "user") return;
    const reply = list[index + 1]?.role === "assistant" ? list[index + 1] : null;
    const live = reply?.status === "streaming" || reply?.status === "queued";
    const ask = String(message.text ?? "").replace(/\s+/g, " ").trim();
    let outcome = null;
    if (reply?.status === "complete") outcome = { state: "done", text: replyPreview(reply.text, 220) || "Finished." };
    else if (reply?.status === "failed") {
      outcome = reply.error?.kind === "cancelled"
        ? { state: "stopped", text: reply.error?.message || "Stopped." }
        : { state: "failed", text: reply.error?.message || "Couldn’t finish." };
    }
    chapters.push({
      id: message.id,
      ask: ask.length > 180 ? `${ask.slice(0, 179)}…` : ask,
      live,
      beats: reply ? beats(reply.tools, { cwd, live }) : [],
      outcome,
      startedAt: reply?.startedAt ?? reply?.createdAt ?? message.createdAt,
    });
  });
  // Orchestrator hand-offs read as instructions; keep them but shorten.
  return chapters.slice(-limit).map(chapter => ({ ...chapter, ask: chapter.ask.replace(/^Lima orchestrator:\s*/i, "") }));
}

/** What the agent made: pages and notes in the workspace, files it changed. */
export function madeThings(workspace, messages, { cwd = "" } = {}) {
  const files = new Map();
  for (const message of messages ?? []) {
    for (const raw of message.tools ?? []) {
      const part = stepParts(raw, { cwd });
      if ((part.kind === "file" || part.kind === "files") && /^(Edited|Wrote|Created|Changed|Patched)/i.test(part.verb ?? "")) {
        for (const path of String(part.full).split("\n")) if (path && files.size < 12) files.set(path, path.split("/").pop());
      }
    }
  }
  const tabs = (workspace?.tabs ?? []).filter(tab => /^https?:/.test(tab.url));
  const notes = (workspace?.tabs ?? []).filter(tab => tab.url.startsWith("about:lima?note="));
  return { pages: tabs.slice(0, 12), notes: notes.slice(0, 12), files: [...files].map(([path, name]) => ({ path, name })) };
}

/** What one finished reply changed, as cards the chat can open: notes it
 * wrote, files it edited, pages it opened, schedules and sidebar changes.
 * Built from the reply's own tool steps, never from what the model wrote. */
export function replyResults(message, { cwd = "" } = {}) {
  const notes = new Map();
  const files = new Map();
  const pages = new Map();
  let arranged = false;
  let scheduled = false;
  for (const raw of message?.tools ?? []) {
    const separator = raw.indexOf(": ");
    const qualified = separator < 0 ? raw : raw.slice(0, separator);
    const name = (/^mcp__(.+?)__(.+)$/.exec(qualified)?.[2] ?? qualified).replace(/^lima_/, "").toLowerCase();
    const detail = separator < 0 ? "" : raw.slice(separator + 2);
    if (/^notes?_(update|append|create|new|add_image|organize)$|^note_new$/.test(name)) {
      for (const match of detail.matchAll(/"(?:id|noteId)"\s*:\s*"([0-9A-Fa-f-]{36})"/g)) if (notes.size < 6) notes.set(match[1].toUpperCase(), name.includes("new") || name.includes("create") ? "Created" : "Updated");
      const title = /"title"\s*:\s*"([^"]{1,80})"/.exec(detail)?.[1];
      if (title && !notes.size) notes.set(`title:${title}`, "Created");
    }
    if (name === "workspace_open_tab") {
      const url = /"url"\s*:\s*"(https?:[^"]+)"/.exec(detail)?.[1];
      if (url && pages.size < 6) pages.set(url, /"title"\s*:\s*"([^"]{1,80})"/.exec(detail)?.[1] ?? url.replace(/^https?:\/\/(www\.)?/, ""));
    }
    if (name === "workspace_arrange" || name === "workspace_organize_tabs") arranged = true;
    if (name === "workspace_schedule") scheduled = true;
    const part = stepParts(raw, { cwd });
    if ((part.kind === "file" || part.kind === "files") && /^(Edited|Wrote|Created|Changed|Patched)/i.test(part.verb ?? "")) {
      for (const path of String(part.full).split("\n")) if (path && files.size < 8) files.set(path, path.split("/").pop());
    }
  }
  return {
    notes: [...notes].map(([id, verb]) => ({ id: id.startsWith("title:") ? null : id, title: id.startsWith("title:") ? id.slice(6) : null, verb })),
    files: [...files].map(([path, name]) => ({ path, name })),
    pages: [...pages].map(([url, title]) => ({ url, title })),
    arranged, scheduled,
  };
}

/** A reply's steps as phases: runs of steps doing the same kind of thing
 * ("Worked on opentable.com", "Read 5 files", "Ran 2 commands"), so a long
 * run reads as what happened rather than as an execution log. Each phase
 * keeps its steps (in order) for anyone who wants the detail. */
export function stepPhases(steps, { cwd = "" } = {}) {
  const phases = [];
  for (const step of steps ?? []) {
    const raw = step.tool ?? "";
    const separator = raw.indexOf(": ");
    const qualified = separator < 0 ? raw : raw.slice(0, separator);
    const name = (/^mcp__(.+?)__(.+)$/.exec(qualified)?.[2] ?? qualified).replace(/^lima_/, "").toLowerCase();
    const part = stepParts(raw, { cwd });
    let kind;
    let site = "";
    if (part.kind === "url") {
      try { site = new URL(part.full).host.replace(/^www\./, ""); } catch { site = String(part.target).split("/")[0]; }
      kind = `web:${site}`;
    } else if (/^(read|grep|glob|ls|notebookread)$/.test(name)) kind = "read";
    else if (/^(edit|multiedit|write|notebookedit|apply_patch|file_change)$/.test(name)) kind = "edit";
    else if (part.kind === "command") kind = "run";
    else if (/web_search|search/.test(name)) kind = "search";
    else if (/^notes?_|workspace_note|note_new/.test(name)) kind = "notes";
    else if (/^workspace_(arrange|organize_tabs|layout|open_tab|close_tab|bookmark|make_folder|name)$/.test(name)) kind = "organize";
    else if (/^(agent_spawn|agents_status|agent_dismiss|task_delegate|task_status|task_message|task_inbox)$/.test(name)) kind = "delegate";
    else if (/ask|approval|permissions|location/.test(name)) kind = "ask";
    else kind = "other";
    const last = phases.at(-1);
    if (last && last.kind === kind) last.steps.push(step);
    else phases.push({ kind, site, steps: [step] });
  }
  const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  for (const phase of phases) {
    const n = phase.steps.length;
    const files = new Set(phase.steps.map(step => stepParts(step.tool ?? "", { cwd }).full).filter(Boolean)).size;
    phase.title = phase.kind.startsWith("web:") ? `Worked on ${phase.site}`
      : { read: `Read ${count(files || n, "file")}`, edit: `Edited ${count(files || n, "file")}`, run: `Ran ${count(n, "command")}`,
          search: "Searched", notes: "Worked on notes", organize: "Organized the workspace", delegate: "Coordinated helpers",
          ask: "Checked with you", other: count(n, "step") }[phase.kind];
    phase.icon = phase.kind.startsWith("web:") ? "globe"
      : { read: "file", edit: "pencil", run: "terminal", search: "search", notes: "note", organize: "folder", delegate: "agents", ask: "chat", other: "spark" }[phase.kind];
  }
  return phases;
}
