# Unified capability architecture & Prism design system

## Problem (as of commit 2e20d04)
Lima's functions are defined in five places that drift apart:
- `ToolRegistry` (native, Search) — 20 tools
- `MCPServer.tools` — 11 hand-written tools
- `LimaWindow.TOOLS` — 8 rail entries
- `LimaUrlbar` — its own action→URL mapping and icon table
- each `about:lima` page — its own header, buttons, empty states and result rendering

Authorization is applied per entry point (some via the broker, some via ad-hoc origin checks), and
nothing records that a function ran, so there is no single activity timeline.

## Design

### 1. One capability manifest (native, `LimaRuntime/Capabilities.swift`)
Every function Lima can perform is a **capability**:

```
Capability {
  id            "audio.output"              stable, versioned by the manifest
  title         "Switch Audio Output"
  summary       one line, used by every surface
  category      create | navigate | system | media | capture | ai | data | developer
  icon          glyph name in the Prism icon set
  keywords      search terms
  input         optional { name, placeholder, required }
  surfaces      { rail, search, palette, home, mcp }
  risk          ActionKind  → authorization broker decides allow/confirm/block
  mcpScope      grant required for external agents (nil = not exposed)
  presentation  inline | page        (where the result renders)
}
```

One runtime entry point executes them all:

```
capabilities.run(id, input)  ─┬─ authorize(risk, origin, mcpScope)   ← single policy point
                              ├─ run record: capability.started event
                              ├─ handler(input) → TypedResult
                              └─ capability.finished event + Context Shelf activity
```

A surface passes `executionId` (a fresh UUID per user invocation). A repeated
`capabilities.run` with the same ID returns the first run's result, or waits
for it, and never executes again. `capabilities.execution(executionId)`
returns `{ status: completed | failed, result | error }` for display only, or
null once the execution has aged out (the last 50 are kept in memory) or Lima
restarted. Search runs a command, then opens
`about:lima?run=<id>&execution=<executionId>`. The Run page shows that stored
result, so opening, refreshing or restoring the tab never repeats a command
with side effects. Run Again starts a new execution.

`TypedResult` is a closed set rendered identically everywhere:
`text · list · table · markdown · image · devices · open(url) · notice`.

### 2. Every surface is a projection of the manifest
| Surface | Reads | Today | After |
|---|---|---|---|
| Rail | `surfaces.rail` | hard-coded list | generated |
| Zen address bar | `surfaces.search` + content index | own mapping | generated, shared icons |
| ⌘K palette (new, any Lima tab) | everything | — | capabilities + content + recents |
| Home dashboard (new) | `surfaces.home` + live state | — | generated quick actions + live widgets |
| MCP | `mcpScope != nil` | hand-written | generated `lima_<id>` tools + content tools |
| Activity timeline (new) | run events | — | every run, from every surface |

### 3. Prism design system (`ui/prism.css`, `ui/components.js`)
- **Tokens**: surfaces (`--surface-0…3`), text, border, the prismatic accent as a gradient token,
  radii, spacing (4-pt), type scale, elevation, motion durations. Light/dark, reduced motion and
  reduced transparency all handled at token level.
- **Shell**: every page = `PageShell(icon, title, subtitle, status, actions, content)` with an
  ambient aurora backdrop, glass header, prismatic hairline.
- **Components**: Button, IconButton, Badge, Card, Tile, List, Empty, Skeleton, Toast, Toggle,
  ResultView (renders every `TypedResult`), CommandPalette.
- **Icons**: one inline-SVG set keyed by capability `icon`, shared by pages, rail and address bar.

## Hypotheses (and how each is checked)
| # | Hypothesis | Check |
|---|---|---|
| H1 | One manifest can drive every entry point with no per-surface definitions | No tool lists remain outside the manifest; tests assert each `search`/`mcp` capability is reachable from Search and listed by MCP |
| H2 | Authorizing at the capability layer gives identical policy for every origin | Test: same risky capability from `browser` vs `mcp` yields the same broker decision; MCP additionally needs its scope |
| H3 | Every run is observable | Test: `capabilities.run` emits started/finished and records activity |
| H4 | A shared shell + ResultView makes all pages visually consistent | Screenshot each surface after the refactor |
| H5 | Palette stays within the spec's local-search budget (p95 < 100 ms) | Palette shows measured round-trip; runtime test bounds `search.query` latency over 2,000 docs |

## Results (verified)
H1–H3 and H5 hold in the native suite (64 tests). H4 was checked by screenshots of Home, Workspaces,
workspace dashboard, notes, chat and terminal after the refactor.

## AI workspaces
> Superseded by `sidebar-workspaces.md`: the dashboard, Workspaces index, Home and rail described below were removed.

A workspace binds four things and keeps them visible:

| Part | Where it lives | Shown as |
|---|---|---|
| Directory | `~/Lima Workspaces/<name>` or an existing folder in your home directory (no automatic `git init`) | header path, Files card |
| Terminal | daemon PTY with `cwd` = directory, keyboard leased to the workspace agent (typing takes it back) | Terminal tab + live mirror |
| Agent | conversation with `cwd` = directory, CLI gets Lima's MCP server bound by a per-workspace token; Claude edits confined to cwd (`acceptEdits`) | Agent tab + dashboard |
| Tabs & bookmarks | desired state in the runtime, reconciled by the browser | Zen tab folder `✦ <name>`; bookmarks `Lima Workspaces/✦ <name>/…` |

Agents act through `workspace_open_tab`, `workspace_bookmark` (folder paths build structure),
`workspace_run` (visible terminal, broker-classified, waits for its own prompt), `workspace_files`,
`workspace_new`. The token confines an agent to its own workspace; deleting a workspace is user-only and
keeps the directory. Terminals that ended (e.g. after a runtime restart) are recreated on demand.

New things are created as a **Tab, Folder or AI Workspace** from the rail's ＋, and Lima adds
"New AI Workspace / Note / Canvas / Terminal / AI Chat" to Zen's own new-tab command bar.

## UI simplification (after review)
- Rail: Home, Workspaces, Notes, Chat, Terminal + ＋ (was 11 glyphs). Everything else is in ⌘K.
- Merged: Agents → Workspaces (CLI status strip); Context Shelf → Activity (Commands · Activity · Reports).
- Home: search box, Continue (recency-merged workspaces/notes/chats/terminals), six actions. Removed the
  stats panel, chart and 2,000-event load.
- Run page: one input, one result.
- Visual cost: static backdrop (no blur filter, no animation), blur only on header and palette, no
  perpetual shimmer/drift.
