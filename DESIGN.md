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

## Layout rules

Lima is a clean browser first. Its AI workspace lives in the left sidebar.

- **The right edge stays free of Lima.** No inspector, drawer, assistant panel, code review drawer, agent timeline, notes panel, activity strip, floating utility column or second navigation rail. Web content keeps its full width and is never resized for Lima.
- **The left sidebar is the navigation.** Browser tabs, workspaces, agents, notes, the Companion and utilities all live there, using Zen's folders, splits and session restore rather than copies of them.
- **The center shows one task at a time:** a web page, or a Chat, Terminal or Note tab.
- **Overlays are temporary and centered.** Search and Quick Ask cover the page only while open, dismiss cleanly, and never change its layout. The Companion panel opens from the sidebar on the left.
- **Agent activity and approvals are compact indicators** on existing sidebar rows. Details, code review and multi-agent coordination belong in the workspace's own tabs.
- **Browsing is never interrupted.** An agent changing what it works on never switches the selected tab.
- **Every operation is visible and recoverable.** Failures show where the action started, with the draft, tab and results kept, and with Retry where it applies. Nothing fails only to a log or loads indefinitely.

## Navigation and execution

- Universal Search (⌘T, or ⌘K in a Lima tab) is the single entry point. It finds websites, tabs, history, notes, workspaces and commands, and offers Ask Lima and Delegate Task for questions and tasks. Enter selects, ⌘Enter opens AI Chat, Escape closes. Local results paint first, and remote ones join without moving the selection.
- Ask Lima streams a Quick Ask answer inside the Search panel, bounded in height, with Copy, Continue in Chat and Close. It reads no page or file unless the user shares one. Ask Lima About Page and Summarize Selection show a chip naming exactly what is shared.
- Every command runs once per invocation. Search runs it, then the result tab shows the stored result by execution ID, so opening, refreshing or restoring the tab never runs it again. Run Again, Copy Result and View Details sit under the result.
- Tab and page menus bring browser content into Lima: Add Tab to Workspace moves a page into a workspace's Tabs folder, Send Page to Agent puts the page into the Companion's draft, and Save Selection to Note quotes the selection with its source link. Sidebar actions report results and failures in a notice above the dock.
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

Status is "Implemented" where the behavior ships, and "Target" where it is specified but still needs product work. Motion-disabled states use the same layout and controls throughout.

| Screen | Normal and empty | Loading and failure | Status |
| --- | --- | --- | --- |
| Home | Centered companion and shared composer, with recent workspaces when available | Keep the composer stable during handoff, show the failure beside the preserved draft | Implemented |
| Browser and Companion | Native Zen content, workspace navigation, and the Companion panel opening from the left sidebar | Browser owns page loading and errors, Companion shows tab references | Implemented. No right-side surfaces |
| Universal Search and Quick Ask | Centered palette, result rows with action labels, shortcut hints, inline Quick Ask answer | Commands show Running command… then close; failures stay in the panel with Retry and View Details | Implemented |
| Command result | Stored result of one execution with Run Again, Copy Result, View Details | Command failed notice with Retry; an expired result says so instead of re-running | Implemented |
| New workspace | New workspace destination and named creation from a prompt | The handoff row shows progress, errors preserve the draft | Implemented |
| Workspace overview | Objective, directory, branch, agent rows, and links to its tabs | Keep header stable while branch and activity load, show workspace errors inline | Implemented |
| Single-agent chat | Conversation, tool rows, bottom composer, model and provider controls | Message not sent keeps the draft with Retry Message; Response interrupted marks a stopped reply | Implemented |
| Multi-agent orchestration | One sidebar folder and own chat for each helper, Dismiss Finished Agent | Starting and working states become completed or failed from the helper’s reply | Implemented. Dependency view in the parent chat is a target |
| Terminal and Git | Live shell beside Files and Changes, diff preview on selection | Ownership bar only during a handoff: Agent is requesting keyboard access, Agent has terminal control, Terminal control returned to you | Implemented. Stage Selected and Revert Selected are targets |
| Notes and Canvas | White editor and precise canvas controls using shared colors | Keep note layout during load and show storage errors next to the editor | Implemented. Revision history is a target |
| Context and weekly report | Compact timeline and readable report | Empty state describes the available activity, failures stay local to the list | Implemented |
| Integrations and Settings | Provider rows: Ready, Not Installed, Sign-In Required, Unavailable; Full/Subtle/Off control | Disconnected when the runtime doesn't answer; Check Again, Sign In, Open Setup, View Details | Implemented |
| Updates | Lima is up to date, Downloading update…, Ready to Restart | Update Failed keeps the current version, with Retry | Implemented |
| Onboarding | Five optional steps in an ordinary tab: Meet Lima, Connect an AI, Try Search, Create a Workspace, You're Ready | Each step's failure stays on that step; detected setups are skipped | Implemented |
| Screenshot Studio | Light gray tray and workspace, with an empty tray before capture | Keep an existing capture visible while OCR runs, report failures in the toolbar | Implemented |
| Persistent task records | One record per task shared by runtime, Companion, chat and sidebar, with Planning through Canceled states | A handoff is not completion; the agent's result sets the final state | Target. Today the Companion and sidebar derive state from the workspace chat |
| Attention popup | Count on the Companion icon, compact popup anchored to the sidebar listing requests | Requests stay until resolved | Partly implemented: the attention mark and prompts exist, the anchored popup is a target |
| Shortcut registry | Keyboard Shortcuts settings with conflict detection | Shortcut Conflict names the other owner | Target |
| UX regression suite | Screenshot coverage for Search, sidebar, Companion, Chat, Terminal, Notes, Settings | Failures block release | Target. `source_smoke.py` covers identity and runtime startup |
