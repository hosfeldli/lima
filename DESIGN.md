# Lima 5 interface

Lima uses the density of an agent development environment and the navigation of a browser. The original folded-cap character appears in Home and in agent status. Web content, code, documents, and terminal output use ordinary browser and editor behavior. Orca’s tabbed terminal and persistent session model informed the layout. [Orca terminal reference](https://orca.dev/docs/terminal)

## Foundations

| Role | Token |
| --- | --- |
| Browser content and page backgrounds | #FFFFFF |
| Sidebar and file explorer | #F2F2F2 |
| Surface | #F7F7F7 |
| Elevated surface | #EAEAEA |
| Border | #DEDEDE |
| Primary text | #242424 |
| Secondary text | #515151 |
| Muted text | #646464 |
| Primary action | #383838 |
| Active selection | #E3E3E3 |

The browser chrome and internal pages use shared tokens. The terminal reads those tokens when it attaches. White content, light gray navigation, and a graphite foreground provide hierarchy. Section titles and hairline separators organize work surfaces. Menus, the Companion panel, and the task composer use 14 px corners. Routine controls use 8 px corners. Standard labels are 13 px and metadata is 11–12 px. [Theme tokens](browser/overlay/lima/ui/theme.css)

The macOS app mark places the folded-cap character at a white terminal with a graphite outline. Packaging renders the same drawing into the macOS icon sizes. The internal page character uses an inline SVG with independent layers for posture, expression, and activity. [macOS app mark](browser/branding/lima-app-icon.svg)

## Navigation and execution

- Home and Companion share a task handoff composer. An explicit creation instruction starts a named workspace. A selected workspace receives the objective in its own chat. A new workspace uses the last selected provider and its remembered model.
- Companion shows workspace state and opens the actual agent tab. Its open-tab picker indexes regular browser windows. A handoff includes the tabs the user selects. Already loaded pages can contribute a bounded text excerpt.
- A workspace lists its objective, directory, branch, agents, browser pages, and notes in Overview. Files and Changes share the terminal explorer. Zen owns tab navigation, tab groups, splits, and browser session restore.
- Chat displays the chronological transcript, tool names, and current operation. The slash menu offers discoverable skills, MCP inventory, and settings. At-sign suggestions include file references. Settings inventories display names and locations with no configuration values.
- Browser-only helpers use the assigned loopback page through a limited tool catalog. Their session has a separate directory and runs Claude Code with its built-in tools disabled. The runtime allows that identity only the scoped browser action.
- Git change rows open a diff with separate staged and working-tree sections. Staging controls target the selected path. The surrounding terminal, tabs, and editor remain in place.

## Motion and illustration

The folded-cap character breathes and blinks at rest. Thinking adds a head tilt. Reading and browsing glance from side to side. Writing and terminal work use two paw taps. Testing tilts toward a checklist before the next check. A handoff moves the character and note together. A failed or blocked action briefly startles the character. Completion triggers a single hop with small pencil-stroke rays. A live label and task glyph follow the same execution events, and active work displays elapsed time. The shell status stays above the output.

Full uses character motion. Subtle keeps the drawing stationary. Off removes the decorative character while keeping operational icons and text. macOS Reduce Motion turns CSS motion off and retains state cues. Hidden documents pause their character animation.

## Screen and state specifications

The status column marks the surfaces implemented in this pass and the design targets that still need product work. Motion-disabled states use the same layout and controls throughout.

| Screen | Normal and empty | Loading and failure | Status |
| --- | --- | --- | --- |
| Home | Centered companion and shared composer, with recent workspaces when available | Keep the composer stable during handoff, show the failure beside the preserved draft | Implemented |
| Browser and inspector | Native Zen content, workspace navigation, and a collapsible left Companion panel | Browser owns page loading and errors, Companion shows tab references | Left panel implemented, resizable right inspector specified |
| New workspace | New workspace destination and named creation from a prompt | The handoff row shows progress, errors preserve the draft | Implemented |
| Workspace overview | Objective, directory, branch, agent rows, and links to its tabs | Keep header stable while branch and activity load, show workspace errors inline | Implemented |
| Single-agent chat | Conversation, tool rows, bottom composer, model and provider controls | Active tool and stop control while running, failed turn shows retry state | Implemented |
| Multi-agent orchestration | One row and own chat for each helper, browser access identified in the runtime | Starting and working states become completed or failed from the helper’s reply | Independent sessions implemented, side-by-side orchestration specified |
| Terminal and Git | Live shell beside Files and Changes, diff preview on selection | Scrollback persists during tab switches, inline notices handle Git and shell failures | Implemented |
| Notes and Canvas | White editor and precise canvas controls using shared colors | Keep note layout during load and show storage errors next to the editor | Existing editors use shared styling |
| Universal Search and results | Stable light command palette, result rows, and native result view | Empty query keeps input focused, errors remain within the result surface | Existing surfaces use shared styling |
| Context and weekly report | Compact timeline and readable report | Empty state describes the available activity, failures stay local to the list | Existing surfaces use shared styling |
| Automation builder and history | Compact workflow tree and event timeline, with a first-run empty state | Stage-level progress, error details, and retry actions | Design target |
| Integrations and Settings | Service status, provider settings, and Full/Subtle/Off control | Show connection errors per service and retain settings controls | Shared theme and appearance control implemented |
| Screenshot Studio | Light gray tray and workspace, with an empty tray before capture | Keep an existing capture visible while OCR runs, report failures in the toolbar | Existing Studio uses shared styling |
| Floating utility rail | Single compact strip with native utility actions | Show short action status on the originating control | Browser rail styled, native floating rail is a design target |
| Onboarding and migration | Single choice per step with a small illustration | Preserve progress and display the specific operation that failed | Existing settings migration retained, new onboarding specified |
| Offline and recovery | Preserve the surface and current draft | Show the affected operation and retry or reconnect where supported | Scoped state treatments implemented, unified offline view specified |
