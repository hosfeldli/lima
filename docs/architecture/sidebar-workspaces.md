# Sidebar-first Lima (Zen + Orca)

Supersedes the dashboard/card UI from `unified-architecture.md` (§ AI workspaces, UI simplification).
Rule: **every Lima object is a tab or a folder in Zen's sidebar, and every tab does one job.** There are no
dashboards, card grids or Home page.

## What lives in the sidebar

```
✦ Launch research            ← AI workspace = Zen folder. The ✦ is the folder icon; click it → Chat.
  ✦ Chat                     ← the workspace agent's conversation (one job: talk to the agent)
  ⌨ Terminal                 ← Orca-style: file tree of the workspace directory | shared terminal
  ▸ Tabs                     ← sub-folder: web pages the agent opened (and any you drop in)
  ▸ Agents                   ← sub-folder, appears when the agent spawns helpers
    ✦ pricing-scout          ← temporary agent = sub-folder: its Chat, and (on demand) its Terminal + pages
▸ Notebook                   ← OneNote: sections are sub-folders, pages are note tabs
```

Creation is in one place, twice: Zen's bottom **＋** (`zenCreateNewPopup`) and **right-click** on the sidebar
(empty area, a folder, or a tab): New Tab · New Note · New Terminal · New AI Workspace (· from Folder…).
Right-clicking a folder creates the item inside that folder.

## Where the AI is working

The runtime tracks one focus per workspace/agent and broadcasts `workspace.activity {id, surface, url}`:

| Agent is… | surface | Sidebar shows |
|---|---|---|
| reading/opening a page (`workspace_open_tab`, `workspace_read_tab`) | `tab` + url | that tab gets the copper edge indicator |
| running a command (`workspace_run`) | `terminal` | the indicator moves to the Terminal tab |
| writing a reply (stream deltas, no tool) | `chat` | the Chat tab shows a copper status dot |
| done | `idle` | nothing animates |

Rules: a tool call moves focus to its surface; text deltas move it back to chat; turn end → idle. Reduce Motion
keeps the indicators and pauses decorative motion.

## Agents (Orca's coordinator/worker, made visible)

`agent_spawn(name, task)` creates a **temporary** child workspace: same directory as its parent (no new folder),
its own conversation, and a terminal/tab folder only when it first needs one. `agents_status` lets the parent
check on them; the user checks by clicking the agent's Chat. A finished agent can be dismissed from its folder's
context menu (its conversation is kept, the folder goes away).

## The agent operates on tabs

`workspace_list_tabs` / `workspace_read_tab(url)` are answered by the browser, not guessed by the runtime:
the runtime emits `workspace.browserRequest {requestId, workspaceId, kind, …}` and the chrome replies with
`workspace.browserReply`. Page text comes from a content actor (`LimaPage`) that runs only on the parent's
request, so a page can never call into Lima.

## Search (⌘T)

⌘T, Zen's "New Tab" and ＋ → New Tab open **Lima Search**, a floating panel over the current page (the 4.x
launcher's layout: Lima mark, 46 px field, 28 px result rows, accent "↩ Open" pill, key-hint footer).
Sources, in parallel and never blocking each other: URL/navigation, Lima index (notes, chats, apps, commands,
files), open tabs, **web suggestions from the default engine** (only when the browser's search-suggestion pref
is on) and "Search the web". Clicking the Lima mark (or ⌘↵) opens an AI chat tab with the typed text.

## Notes (OneNote)

Notebook folder in the sidebar mirrors the note bookmark tree (sections = folders, pages = notes). A note tab is
one page: title, created date/time, and a WYSIWYG body (headings, lists, to-dos, bold/italic/code, links) that
round-trips to the encrypted Markdown store. Agents write summaries with `workspace_note(title, markdown)`; the
note appears in the workspace folder and the Notebook.

## Dictation and music (ported from 4.x)

- Dictation: ⌃⌥D (4.x default) or the mic in the sidebar dock. Records 16 kHz mono in the runtime, transcribes
  on-device with the same `whisper-cli` + `ggml-small.en-tdrz` model 4.x shipped; the text goes into the focused
  note (or a new "Dictation" note), as in 4.x where dictation landed in Notes. The dock shows the recording pill
  (level, timer, stop/cancel) exactly while recording/transcribing.
- The calendar start reminder also offers a short meeting note. Its microphone button asks the user to confirm
  Apple Speech Recognition before recording. Apple may process that audio off-device.
- Music: the 4.x now-playing pill lives at the bottom of the sidebar: artwork, title/artist, play/pause; expand
  for progress and previous/next/DJ; scroll on it to change volume. One volume control, and clicking or dragging
  the pill never opens Spotify (spec v2 §10).

## Hypotheses → checks

| # | Hypothesis | Check |
|---|---|---|
| S1 | Every workspace/agent object is reachable from the sidebar alone | Marionette: create workspace, spawn agent, verify folder tree; no `?workspace=`/`?view=workspaces` pages remain |
| S2 | Indicator follows the agent | Runtime test: tool calls/deltas/turn-end produce tab→terminal→chat→idle; Marionette: attributes move between tabs |
| S3 | Agents can operate on real tabs | Runtime test of browser round-trip; live run: agent reads a page in its Tabs folder |
| S4 | ⌘T opens Lima Search, and web + Lima results both arrive | Marionette: synthesize ⌘T, type, inspect rows |
| S5 | Dictation matches 4.x | Whisper transcription test on a generated WAV; mic capture depends on macOS permission |
