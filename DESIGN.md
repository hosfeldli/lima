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

The browser chrome and internal pages use shared tokens. The terminal reads those tokens when it attaches. White content, light gray navigation, and a graphite foreground provide hierarchy. A charcoal set of the same tokens (`[lima-theme="dark"]` in theme.css) themes windows, Lima pages, Search and the Dock badge; Theme in Settings matches macOS by default, including Auto. Section titles and hairline separators organize work surfaces. Menus, the Companion panel, and the task composer use 14 px corners. Routine controls use 8 px corners. Standard labels are 13 px and metadata is 11–12 px. [Theme tokens](browser/overlay/lima/ui/theme.css)

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

- Universal Search (⌘T, or ⌘K in a Lima tab) is the single entry point ([spec](docs/spec/universal-search.md)). One input, at most eight results in up to three categories (Best Match, Your Browser & Lima, Web Suggestions), headings only when more than one shows, and "Show more" for the rest. Row one is always the URL to open or the search with your engine; Ask Lima or Delegate Task joins it only for confident questions or tasks and never runs by itself. Tabs, bookmarks and history for one page merge into one row. `@page`, `@tabs`, `@workspace`, `@notes` and `@files` narrow a query. Enter selects, ⌘Enter opens AI Chat, Escape closes. Local results paint first; once you move the selection, nothing new appears above it.
- Ask Lima streams a Quick Ask answer inside the Search panel, bounded in height, with Copy, Continue in Chat and Close. It reads no page or file unless the user shares one. Ask Lima About Page, Summarize Selection and `@page` show a chip below the input naming exactly what is shared, with one-click removal.
- Every command runs once per invocation. Search runs it, then the result tab shows the stored result by execution ID, so opening, refreshing or restoring the tab never runs it again. Run Again, Copy Result and View Details sit under the result.
- Tab and page menus bring browser content into Lima: Add Tab to Workspace moves a page into a workspace's Tabs folder, Send Page to Agent puts the page into the Companion's draft, and Save Selection to Note quotes the selection with its source link. Sidebar actions report results and failures in a notice above the dock.
- Agent folders use the same row height, text and icon size as every other tab. A top-level workspace folder, where the coordinating agent works, is 25% larger: 37.5 px rows, 14.4 px text and a 20 px character.
- A task that needs the user says why and what to do. The chat's status line names the reason (for example, "The agent couldn't finish: Console errors not checked (no console access).") and shows the remedy with the button that resolves it: Retry, Resume, Open Settings or Review Task, plus Stop Task. The sidebar and the Companion button show a small dot, never a large warning glyph in place of the character.
- Most sites refuse to be framed, so a note's embed never relies on an iframe. Lima fetches the page's title, description and preview image natively (no cookies) and shows a card. Open Side by Side opens the live page beside the note in a Zen split. Inserting an embed is one undoable edit, and Remove deletes it (also undoable). On a canvas, the card's frame selects and drags the block.
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
| Browser and Companion | Native Zen content, workspace navigation, and the Companion panel opening from the left sidebar. The panel has the request composer ("Each request becomes its own chat"), then Chats ("Click one to follow up"): one bordered row per request with a chat icon and status dot, the request, its time, its state (Working, Needs you, Replying…, Answered, Done, Failed), the latest reply and a chevron. Sending a request opens its chat at once. A chat shows the full exchange, live task status and a reply box with provider and model pickers; ← or Escape returns to the list. Chats never move to a tab | Browser owns page loading and errors, Companion shows tab references. A reply that hit a usage limit says which provider took over | Implemented. No right-side surfaces |
| Universal Search and Quick Ask | 560 px panel in the upper fifth, up to eight rows in adaptive categories, key-hint footer, inline Quick Ask answer; empty query shows up to four recent destinations or "Search the web, open something, or ask Lima." | Commands show Running command… then close; failures stay in the panel with Retry and View Details and never show raw JSON or stack traces | Implemented |
| Command result | Stored result of one execution with Run Again, Copy Result, View Details | Command failed notice with Retry; an expired result says so instead of re-running | Implemented |
| New workspace | New workspace destination and named creation from a prompt | The handoff row shows progress, errors preserve the draft | Implemented |
| Workspace overview | Objective, directory, branch, agent rows, and links to its tabs | Keep header stable while branch and activity load, show workspace errors inline | Implemented |
| Single-agent chat | Conversation, tool rows, bottom composer, model and provider controls that apply at once (a reply in progress restarts on the new choice and says so). While a reply runs the composer shows Stop, Send Now and Queue with the hint "↩ queues it for after this reply · ⌘↩ stops the reply and sends now"; a queued message sits dimmed with a dashed outline and Send Now / Edit until it runs. Stopping puts queued text back in the box | Message not sent keeps the draft with Retry Message; Response interrupted marks a stopped reply. A usage limit continues the turn on another signed-in provider and a quiet line above the reply says so | Implemented |
| Multi-agent orchestration | One sidebar folder and own chat for each helper, Dismiss Finished Agent | Helpers start when their dependencies succeed; failures block only their dependents | Implemented |
| Agent steps | Each reply lists its steps (icon, action, file or page), green +N and red −N lines for edits with a total in the header, and 64×44 thumbnails for screenshots and images that open full size in Glance. More than eight steps fold the earlier ones. Composers show attachment chips (thumbnail or file icon, name, size, upload bar, ×) and outline the box while a file is dragged over | An attachment that didn't upload says so on its chip and blocks Send until it's removed | Implemented. Lima has no terminal: agents use their own tools |
| Downloads | A rail button with a progress ring and unseen-count badge; its panel above the rail lists recent files with name, size and site, a progress bar while downloading, and Show in Finder, Cancel, Retry and Remove. Click opens a file, files drag out to Finder or a chat, and a short toast offers Open and Show when one finishes | Failed and blocked downloads say why, with Retry | Implemented. Zen's animation and Firefox's panel are off |
| Music | One pill for Spotify, Apple Music and audio playing in a tab (YouTube or any site), whichever played last. The rail icon follows the source, DJ appears only for Spotify, and a tab source adds Show Tab | An idle source says so | Implemented |
| Notes and Canvas | White editor and precise canvas controls using shared colors. A section can be one, two or three columns (toolbar menu), separated by hairline rules. Headings after the first and --- get a quiet section line. In a table the toolbar adds − Row, − Column and Delete Table. Embeds are preview cards (title, description, image read natively) with Open Side by Side, Open in Tab and Remove; YouTube and Spotify can also play in place | Keep note layout during load and show storage errors next to the editor. An embed whose preview can't load still opens side by side | Implemented. Revision history is a target |
| Context and weekly report | Compact timeline and readable report | Empty state describes the available activity, failures stay local to the list | Implemented |
| Integrations and Settings | Provider rows: Ready, Not Installed, Sign-In Required, Unavailable; usage-limit failover switch; Full/Subtle/Off control. Personal Memory holds Your information and What the Companion remembers (editable, Update now, Forget everything, off switch). macOS permissions open a guided sheet that goes straight to the pane and ticks itself off when Accessibility is granted | Disconnected when the runtime doesn't answer; Check Again, Sign In, Open Setup, View Details. A queued memory update shows why and when it retries | Implemented |
| Updates | Lima is up to date, Downloading update…, Ready to Restart | Update Failed keeps the current version, with Retry | Implemented |
| Onboarding | A full-viewport walkthrough in an ordinary tab with eight optional steps (Meet Lima, About you, Bring your browser data, Default browser, Connect an AI, Search, Workspaces, Ready). On first launch the sidebar waits off to the left (compact mode) and slides in when the walkthrough ends or its tab closes. Each step pairs short copy with an animated scene, the Companion reacts and answers a click, a segmented progress bar jumps between steps, and ← → move. Finishing a step's task (saving details, importing, becoming default, choosing the default AI, creating a workspace) bursts confetti, ticks its progress segment and moves on. About you asks for name, email, phone, address and notes, all optional, plus the Companion-memory switch. Connect an AI lets the user pick the default among signed-in providers. Optional permissions open a guided sheet | Each step's failure stays on that step; detected setups are marked as found. Reduce Motion and the Off personality keep the same layout standing still | Implemented |
| Screenshot Studio | Light gray tray and workspace, with an empty tray before capture | Keep an existing capture visible while OCR runs, report failures in the toolbar | Implemented |
| Scheduled Tasks | A page of bordered rows grouped Repeating, One time, Paused and Finished: icon, title, cadence badge, "Next: …", the instruction (two lines), workspace, who scheduled it and how the last run went, then Run Now, Pause/Resume, Edit, Open Workspace and Delete. New Scheduled Task opens an inline form (title, what to do, repeats, time or date, workspace). The Companion shows a "N scheduled · Next: …" strip above Chats and confirms a schedule with a card (cadence, first run, instruction, workspace) before creating it | An empty page says nothing is scheduled. A run that couldn't start says why on its row; a late run says Lima wasn't open | Implemented |
| Persistent task records | One Orchestrator record per handoff shared by runtime, Companion, Task Progress and sidebar | A handoff is not completion; a verified report sets the final state, and interrupted turns are reported, not replayed | Implemented ([orchestration](docs/architecture/orchestration.md)) |
| Task Progress | A view beside Chat, Agents, Activity and Files in the workspace chat, with helpers, dependencies, history and outcome | Stop Task, Pause, Resume and Retry act on the task tree | Implemented |
| Attention popup | Count on the Companion icon, compact popup anchored to the sidebar listing requests | Requests stay until resolved | Partly implemented: the attention mark and prompts exist, the anchored popup is a target |
| Approval card | Every AI action Lima's policy would otherwise stop asks here instead (flagged commands, risky capabilities, ungranted outside-tool scopes, helper limits). Workspace or caller name, a risk tag (Can spend money, Acts on your account, Affects your Mac, Needs new access), the question, labelled facts (Site, Pages, Path, Text with passwords masked), the plan folded under What it will do; Deny, Allow for this task, Allow once | Sending…, an error stays on the card; a declined step tells the agent not to retry | Implemented |
| Shortcut registry | Keyboard Shortcuts settings with conflict detection | Shortcut Conflict names the other owner | Target |
| UX regression suite | Screenshot coverage for Search, sidebar, Companion, Chat, Terminal, Notes, Settings | Failures block release | Target. `source_smoke.py` covers identity and runtime startup |
