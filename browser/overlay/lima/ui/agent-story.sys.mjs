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
