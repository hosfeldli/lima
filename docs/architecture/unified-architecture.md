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
