# Lima 5.0 — Complete Technical Specification & Implementation Plan

Architecture specification v1.0 · November 13, 2026

12 architectural decisions confirmed

## 1. Product definition

Lima 5.0 will replace Zen Browser with a unified, macOS-native AI workspace built on a maintained fork of Zen's Firefox-based browser.

It will combine everyday browsing, macOS productivity tools, interactive terminals, AI agents, Notes, external services, automation, and an encrypted personal context system within one installed application.

The central principle is:

Lima should operate as one coherent environment, not as a browser with a separate collection of AI utilities attached.

The most important difference from Lima 4.x is that AI becomes a persistent participant in the workspace. Agents can observe authorized activity, share terminals with users, operate across connected tools, maintain project context, and coordinate work without requiring every action to begin and end as a chat message.

### Confirmed product requirements

| Decision       | Lima 5.0 specification                                                |
| -------------- | --------------------------------------------------------------------- |
| Browser        | Lima replaces Zen; one primary browser installation                   |
| Platform       | macOS only, native-first, Apple Silicon priority                      |
| AI permissions | Broad project access, with destructive-action confirmation            |
| Terminal       | Shared terminal view with explicit keyboard ownership                 |
| Models         | Codex, Claude and OpenCode CLIs; no separate direct model API backend |
| Services       | Google, Slack, GitHub, n8n and other service APIs remain supported    |
| Encryption     | Encrypted local data with offline access                              |
| Context        | Metadata and action history, not continuous typing or screenshots     |
| Audio history  | Track titles, applications, playback times and available metadata     |
| Work rail      | Both browser-integrated and native floating/pinned modes              |
| Notes          | Existing classic notes plus new freeform canvases                     |
| Weekly reports | Fridays at 3 PM, including when browser windows are closed            |
| Release        | One public Lima 5.0 major release containing the full committed scope |

One public release does not mean one enormous untested development branch. The implementation will use internal milestones, continuously integrated feature branches, and pre-release builds, with one public 5.0 launch after all release gates pass.

## 2. Target system architecture

Lima.app

One macOS application · One browser identity · Unified UI

Browser & Workspace Layer

Zen / Gecko

Search & Rail

Notes & Panels

Browser Awareness

AI UI

Screenshot Studio

Authenticated internal IPC

Native Lima Runtime — Swift

Terminal & Agent Supervisor

Screen & Audio Services

Context & Search Engine

Notes & Encrypted Storage

Apple Integration Services

MCP & Automation Runtime

Local Background Agent & Secure Data Services

Scheduling · Notifications · Encryption · Updates · Diagnostics

### Recommended technology stack

| Component                  | Technology                                                             |
| -------------------------- | ---------------------------------------------------------------------- |
| Browser engine             | Gecko, maintained through the Zen/Firefox fork                         |
| Browser UI                 | Zen's existing frontend with native Lima integration points            |
| macOS services             | Swift 6, AppKit, SwiftUI where suitable                                |
| Embedded terminal          | SwiftTerm with a redesigned session manager                            |
| Agent communication        | Native CLI protocols, structured events, supervised PTYs               |
| Interprocess communication | Authenticated local XPC for native services; restricted browser bridge |
| Local storage              | SQLite with encrypted database and attachment storage                  |
| Search                     | SQLite FTS5, application metadata index, optional semantic index       |
| Screenshots                | ScreenCaptureKit, CoreGraphics, Vision                                 |
| Audio                      | Core Audio, AVFoundation, existing Whisper components                  |
| Notes editor               | Structured block documents with spatial layout support                 |
| Integrations               | OAuth 2.x, provider APIs, MCP                                          |
| Automation                 | Native scheduler, event triggers, webhooks                             |
| Background services        | User-scoped launchd agent                                              |
| CI/CD                      | GitHub Actions, macOS build infrastructure, signed update distribution |

These are target technology choices, not claims that all components already exist in the repository.

### Five architectural rules

1. One product, multiple isolated processes. The app may run several internal processes, but only one user-facing product is installed.
2. Native capabilities remain native. Avoid porting working Swift services to browser JavaScript solely for visual uniformity.
3. No arbitrary webpage has privileged access. Browsing content must never directly invoke local terminal or system functions.
4. All AI tools use one permission system. Whether an action originates from chat, terminal, an automation, or an external MCP client, authorization must be consistent.
5. Everything survives UI interruption. Navigating between tabs, closing a panel, or restarting the browser frontend must not corrupt Notes, terminal sessions, or persisted agent jobs.

### Repository organization

I recommend a dedicated Lima 5.0 monorepo with the existing 4.x repository preserved as a migration source and maintenance branch.

```
lima/
├── browser/
│   ├── zen-upstream/
│   ├── patches/
│   ├── chrome/
│   ├── workspace/
│   ├── rail/
│   └── browser-bridge/
├── native/
│   ├── lima-host/
│   ├── terminal-service/
│   ├── agent-supervisor/
│   ├── screen-service/
│   ├── audio-service/
│   ├── notes-service/
│   ├── context-service/
│   ├── search-service/
│   ├── integration-service/
│   └── background-agent/
├── protocols/
│   ├── ipc/
│   ├── events/
│   └── tools/
├── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── ui/
│   ├── performance/
│   └── security/
├── infrastructure/
│   ├── builds/
│   ├── monitoring/
│   └── releases/
└── docs/
```

The `zen-upstream` directory should be pinned to known revisions, with Lima-specific changes isolated into as few patch surfaces as possible. This is essential for maintaining Firefox compatibility and incorporating security updates.

## 3. Workspace, Search, and Rail specification

### 3.1 Main application layout

The browser should use four persistent UI zones.

| Region             | Purpose                                   | Behavior                              |
| ------------------ | ----------------------------------------- | ------------------------------------- |
| Navigation rail    | Tabs, projects, agents, tools             | Collapsible, keyboard navigable       |
| Browser canvas     | Webpages and primary content              | Native Zen tab and workspace behavior |
| Work side panel    | AI, terminals, Notes, activity            | Resizable, detachable, persistent     |
| Lower activity bar | Meetings, audio, reminders, running tasks | Dynamic, compact, configurable        |

The current rainbow/prismatic identity should remain, but be refined into a coherent design system with consistent spacing, outlines, typography, and interaction feedback.

The rail composer should have a distinct outline, a visibly separate background surface, and stronger active/focus states. Its input must remain anchored when switching between search, AI, and command modes.

The Lima icon should be redesigned for recognition at small sizes. Use one primary silhouette, a restrained prismatic accent, and distinct states for the menu bar, Dock, and application icon.

### 3.2 Two rail modes

Integrated rail: Visible within Lima Browser, sharing its application state and active context.

Floating rail: A native AppKit window that can remain above other applications and be pinned to a chosen monitor.

Both must use the same state store and session identifiers. Moving a rail between modes must not recreate its AI session, terminal process, or content.

Monitor pinning should support display selection, left/right alignment, automatic handling of disconnected monitors, fullscreen Spaces, and separate layouts for each display.

### 3.3 Search architecture

Search should use a federated local index with source-specific adapters.

| Source                    | Index strategy                                         |
| ------------------------- | ------------------------------------------------------ |
| Applications and commands | Metadata and aliases                                   |
| Files and folders         | Spotlight integration plus custom ranking              |
| Notes and canvases        | Full-text and block-aware search                       |
| Browser history and tabs  | Firefox profile interfaces and Lima tab state          |
| Context Shelf             | Timestamped event index                                |
| Terminal history          | Explicit command history, not raw keystroke recording  |
| Weekly reports            | Indexed summaries and linked source events             |
| Calendar and services     | Cached metadata with authorized provider refreshes     |
| MCP resources             | Discovered resources with bounded indexing permissions |

Search ranking should combine textual relevance, recent selection, frequency, current application, project association, and explicit user preferences.

Users should be able to rebuild individual indexes, exclude sources, choose retention periods, and reset learned ranking.

### 3.4 Quick Ask

Quick Ask is a separate execution mode, not merely a smaller chat window.

Requirements:

- No workspace navigation or automatic tool execution.
- Minimal context by default, with no automatic browser or file inspection.
- Direct communication with the selected CLI-backed model.
- Lowest practical reasoning effort, when supported by that CLI and model.
- A compact streaming answer, with options to copy, replace selected text, or continue in full chat.
- No automatic expansion into the full workspace unless explicitly requested.

Its performance should be measured as additional latency introduced by Lima, separately from the model provider's response time.

### 3.5 AI conversations

Full chat should include editable messages, follow-up questions without interrupting running agents, inline formatting, quoted selections, attachments, Markdown rendering, and persistent chat history.

Failed messages should remain editable and retryable. A connection failure must not replace an entire conversation with an error panel.

Agent activity should appear as structured timeline events showing what the model requested, what Lima actually executed, what changed, and what is awaiting confirmation.

## 4. Interactive terminal and AI orchestration

This is the central functional redesign.

### 4.1 Terminal session model

Define four independent objects.

| Object           | Identity and responsibilities                              |
| ---------------- | ---------------------------------------------------------- |
| Project          | Filesystem root, repository, permissions, context          |
| Terminal session | PTY, shell process, scrollback, input owner, environment   |
| Agent session    | CLI provider, conversation, capabilities, execution state  |
| Task             | Requested objective, steps, output, modified files, result |

A project may contain many terminals. A terminal may be observed by many agents, but only one actor may control its input at a time.

Agents should normally have independent terminals for concurrent work. Shared terminals are appropriate for deliberate collaboration with the user.

### 4.2 Interactive input protocol

### Shared terminal input lifecycle

1. Observe — Agent subscribes to terminal output and process state without writing.
2. Request control — Agent asks to acquire the keyboard lease.
3. User handoff — Lima shows who is taking control and allows approval or rejection.
4. Interact — Agent sends input, observes the result, and can wait for prompts or process completion.
5. Release — Agent relinquishes control voluntarily or after inactivity, cancellation, or user takeover.

The agent can send UTF-8 text, Return, Tab, arrows, control sequences, and interrupts. Input should be delivered to the PTY as keystroke-equivalent bytes where possible, not by rebuilding shell commands outside the session.

The agent must observe real output rather than assume the command succeeded.

The user must be able to interrupt agent control immediately. No injected bytes should continue after a revoked lease.

Terminal automation must understand process states such as idle, running, waiting for input, disconnected, exited, and uncertain. Output-pattern recognition may assist but must not be treated as authoritative process completion.

### 4.3 Multiple terminals and multiple agents

A terminal manager should provide tabs, splits, groups, independent scrollback, searchable history, and detached windows.

The pop-out terminal should be a full-featured resizable window, not a secondary rendering of the workspace view. It should retain session identity, support drag between groups, and preserve selection, scroll position, font size, and theme.

An agent supervisor should provide:

- Independent CLI subprocesses and lifecycle management.
- Cancellation and graceful termination, followed by controlled cleanup.
- Concurrency settings with CPU, memory, and process safeguards.
- Worker-agent assignment to projects and tasks.
- Optional worktree isolation for agents changing the same repository.
- Task dependencies and orchestration.
- Durable event logs and usage reporting.

When multiple agents modify the same project, prefer isolated Git worktrees and an explicit merge/review step. Shared filesystem writes without coordination should be discouraged.

### 4.4 CLI integration

Current Lima already has native CLI integrations; the documented OpenCode adapter uses `opencode run --format json` for requests and passes conversation context into new invocations. The next architecture should distinguish persistent interactive agent sessions from one-shot model requests. See [Lima's current OpenCode integration](https://github.com/hosfeldli/ray-placement/blob/main/docs/OPENCODE.md).

Build three first-class adapters:

| Adapter      | Required capabilities                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| Codex CLI    | Installation detection, login diagnostics, model configuration, streaming, sessions, native tool execution |
| Claude CLI   | Authentication, model aliases, interactive sessions, permission requests, streaming                        |
| OpenCode CLI | Provider/model discovery, installed runtime detection, sessions, structured events, tools                  |

Each adapter needs a capability manifest generated from the installed CLI version, not assumptions about every provider supporting identical features.

The supervisor should track executable path, executable version, authentication state when discoverable, model configuration, available features, process lifetime, output events, errors, and usage.

Model catalog refreshes should be nonblocking and cached. A catalog refresh failure must not invalidate a previously working CLI default. Unsupported or inaccessible models must produce specific diagnostics rather than generic errors.

Direct model API settings should be migrated out of the active UI. Grammar, Quick Ask, and full AI should share the selected CLI infrastructure, with grammar retaining a deterministic local mode.

### 4.5 Git-first development

When Lima creates a new coding project, initialize a local Git repository if none exists. When opening an existing project, detect its repository and preserve its configuration.

For arbitrary local work, ask the user to designate it as a project before initializing Git. Do not silently create repositories inside personal documents or system directories.

The change-tracking engine should record baseline commit, branch, worktree, modified files, diff summaries, tests, and agent attribution.

A visual change review should let the user inspect modifications while an agent is still working. It should support hunk-level review, requesting follow-up changes, and restoring an agent's changes without overwriting unrelated user edits.

No automatic commit should include detected secrets or unreviewed sensitive files. Git commits are useful recovery points but are not substitutes for filesystem snapshots or a reliable undo system.

### 4.6 Action permissions

Use one native authorization broker for terminal, browser, MCP, and AI-initiated actions.

| Action type                                               | Default                                       |
| --------------------------------------------------------- | --------------------------------------------- |
| Read authorized project files                             | Allow                                         |
| Write within authorized project                           | Allow                                         |
| Run builds and tests                                      | Allow                                         |
| Create branches and local commits                         | Allow                                         |
| Install project dependencies                              | Allow within project policy                   |
| Modify files outside authorized roots                     | Request authorization                         |
| Delete large directories or overwrite important data      | Confirm                                       |
| Force-push, delete remote branches, or publish releases   | Confirm                                       |
| Send emails, messages, or external submissions            | Confirm                                       |
| Access credentials or restricted personal records         | Separate permission                           |
| Modify protected OS settings or disable security controls | Block by default                              |
| Perform clearly destructive system operations             | Block or require a dedicated trusted workflow |

The authorization engine should evaluate the actual executable operation, target resource, effective filesystem scope, and destination—not only the natural-language command.

A model saying a command is safe is not evidence that it is safe.

Approval is therefore attached to a particular operation and its parameters. The same operation cannot silently substitute a different target after approval.

## 5. Zen integration, Apple services and MCP

### 5.1 Native browser awareness

Lima will not depend on a Firefox extension for its own browser integration. Instead, the fork's trusted browser frontend should provide a versioned interface to authorized browser state.

Supported information should include active tab, selected text, page title, URL, document structure, navigation state, media metadata, downloads, and available reader content.

Use page-scoped permissions for content inspection, especially on authenticated sites. Private browsing should be isolated from persistent context collection by default.

Browser automation should operate through the browser's trusted internal automation interface, with DOM access scoped to approved tabs. It should not use operating-system mouse simulation when a reliable browser-native action exists.

Untrusted page content must never be interpreted as instructions to the AI without being marked as external data.

### 5.2 Integration contracts

| Service             | Lima 5.0 functionality                                            |
| ------------------- | ----------------------------------------------------------------- |
| Google Calendar     | Read-only events, search, upcoming meetings, availability display |
| Google Meet         | Meeting links, join actions, active meeting awareness             |
| Gmail               | Inbox search, thread summaries, draft creation, optional sending  |
| Slack               | Search, channels, threads, messages, configurable notifications   |
| GitHub              | Repositories, branches, PRs, issues, reviews, workflow status     |
| Apple Calendar      | Event discovery and meeting information                           |
| Apple Reminders     | Read, create, update, complete reminders subject to permission    |
| Apple Mail          | Mail context and supported local mail workflows                   |
| n8n                 | Workflow discovery, triggers, executions, webhook connections     |
| Other MCP providers | Configurable server registration and scoped tools                 |

For Google Calendar, read-only behavior can be enforced with Google's narrower OAuth scopes. Apple EventKit is different: to read local calendars, the application must request full event-store access, then enforce its own no-write policy for the calendar integration. (Source: Apple Developer Documentation.)

Google Meet awareness should use calendar details and browser tab metadata. It should not claim access to private meeting transcripts or participants that the service does not expose.

All service integrations need disconnection, token revocation where supported, credential rotation, rate-limit handling, and an explicit status display.

### 5.3 MCP architecture

Lima must function in both directions.

MCP client: Connect to installed or remote MCP servers, discover capabilities, and let authorized AI agents use those tools.

MCP server: Expose Lima-owned resources to compatible external agents.

The built-in MCP server should initially expose Notes, search, projects, permitted terminal operations, context events, and automation status. Mutating tools must use the same approval broker as Lima's own agents.

Each tool should have a stable name, versioned input/output schema, authorization scope, and machine-readable failure codes.

Support stdio and Streamable HTTP as appropriate. HTTP endpoints must validate origins, authenticate callers, and bind locally unless remote exposure is deliberately configured. Those controls are part of the MCP security requirements. (Source: MCP specification, GitHub.)

MCP installation should not imply trust. A newly installed server may be untrusted code running with the user's permissions. Prefer remote services for integrations that need no local filesystem or hardware access. (Source: MCP specification, GitHub.)

### 5.4 Retiring the extension platform

Remove the custom extension marketplace, extension manifests, and extension-specific execution framework from the final UI.

Before removal, map existing bundled extensions to first-class features with stable command IDs and configurable hotkeys.

Custom user extensions should be audited and either migrated into built-in commands or exported for manual conversion into MCP integrations. Unsupported custom functionality must not silently disappear.

Core features such as the password generator, formatter, emoji picker, window management, timezone conversion, screenshot tools, and grammar correction remain available directly in Search.

## 6. Notes 5.0 and structured knowledge

### 6.1 Dual editing modes

Classic Notes and Canvas Notes should be two views over a common document system.

Classic mode supports structured writing, Markdown, lists, tables, attachments, and conventional document navigation.

Canvas mode supports arbitrary positioning of text blocks, images, sketches, diagrams, tables, embeds, and linked notes.

Users can create either format. Existing classic notes remain editable as classic pages; migration should not force every note into a canvas.

### 6.2 Document model

Each note should have a stable ID, title, metadata, block tree, links, attachments, revisions, and optional spatial coordinates.

A canvas block should carry its type, position, dimensions, z-order, content reference, and parent group.

New block types should include text, image, table, drawing, flow diagram, code, webpage reference, live data, automation, and linked note.

The renderer should support spatial indexing and viewport-based rendering so that large canvases do not require rendering every object on every frame.

### 6.3 AI operations

AI should receive structured editing tools rather than being required to manipulate the canvas through mouse movements.

Examples include `notes.create`, `notes.addBlock`, `notes.moveBlock`, `notes.connectBlocks`, `notes.generateDiagram`, `notes.summarizeSelection`, and `notes.cleanupLayout`.

The cleanup tool should detect overlapping blocks, inconsistent spacing, disconnected diagram elements, duplicates, and unaligned groups. Its proposed changes should be previewable and undoable.

Undo history must use explicit editing transactions and maintain ownership across concurrent AI/user edits. Command-Z should never invoke a view's stale editor state or operate against a destroyed document controller.

### 6.4 Connected notes and automation

A note can contain a webhook trigger, flow diagram, workflow result, website reference, or live status card.

Live websites should be isolated as browser content, never given direct access to the Notes database or privileged application bridge.

Automation results can append structured updates to a document, but should not silently rewrite the user's manual content.

Notes must remain usable entirely offline, except for explicitly connected data sources.

---

# Lima 5.0 — Revised Complete Architecture & Development Specification

Design specification v2.0 · macOS · Zen Browser fork · Native AI workspace

Updated design

## 1. Product vision

Lima 5.0 will be a macOS-native browser and AI workspace built from a fork of Zen Browser, replacing Zen as the primary browser while bringing Lima's tools directly into the browsing environment.

The product should feel like one application, even though browser rendering, AI execution, terminal management, and native macOS services run in separate processes.

The three updated design requirements are foundational:

1. Encryption is local and offline-capable. No online encryption service, remote key server, or internet requirement for unlocking Lima data.
2. Search becomes a universal command surface. It searches local information, the live web, connected services, Notes, and available Lima tools. It can execute authorized actions without opening a full workspace.
3. The sidebar is the primary productivity workspace. It holds Notes, AI conversations, agents, terminals, Context Shelf, and other tools. A compact, bottom-anchored vertical rail provides persistent navigation between these functions.

The remaining product requirements are preserved: native CLI agents, interactive shared terminals, multiple agents, native browser awareness, MCP integration, activity analysis, improved media controls, Screenshot Studio, and one complete public Lima 5.0 release.

## 2. Application layout and visual architecture

### Proposed Lima 5.0 layout

Lima Browser

Search apps, web, tools, notes or ask AI…

Browser

Active tab

Website / active content

Workspace

Project Notes

Planning, tasks and references

AI Agent

Inspecting project changes…

Ask or run an action…

Next meeting

Conceptual layout. The workspace sidebar holds the productivity surfaces, while its lower-right edge anchors a persistent vertical tool rail.

### 2.1 Sidebar design

The sidebar replaces the need for most disconnected Lima utility windows.

Its primary content surfaces are Notes, AI Chat, Agent Manager, Terminal, Context Shelf, Screenshot Studio, Integrations, and Automations.

Each surface should be accessible without navigating away from the active webpage.

The sidebar supports a compact state, a normal resizable state, and a wider workspace state. The active surface should maintain its own navigation state and scroll position when another surface is selected.

### 2.2 Bottom-anchored vertical rail

The rail is a vertical stack of utility icons attached to the lower section of the sidebar, rather than a horizontal toolbar across the bottom.

It should:

- Remain visible while the sidebar is open, with a keyboard-accessible collapsed state.
- Stack quick-access icons upward from the bottom edge.
- Open the selected tool within the sidebar without disrupting other open sessions.
- Show restrained status indicators for active agents, dictation, and pending approvals.
- Support a configurable order, favorites, icon size, and auto-hide behavior.

When the sidebar closes, the same rail can optionally remain accessible as a narrow floating native macOS utility rail.

The full rail can also be pinned to a selected monitor, including when Lima Browser is on another display. It should track monitor changes and correctly handle macOS fullscreen Spaces.

### 2.3 Window philosophy

The default interaction should be in the sidebar.

Terminal windows, Notes canvases, and other surfaces may still pop out when the user deliberately requests additional space. Pop-outs should share the underlying session rather than launch duplicate copies of the same process.

Screenshot Studio should open inside the workspace. Only the temporary screen-selection overlay should appear over other windows.

### 2.4 Visual language

Retain Lima's prismatic identity. Refine it with more consistent outlines, active-state contrast, typography, and spacing.

The rail composer should have a visibly distinct border, clear focus ring, and stable layout. Search results, AI messages, and tool outputs should never cause the input to jump or resize unexpectedly.

Animations should communicate transitions or status, not delay interactions. Respect macOS Reduce Motion and Reduce Transparency settings.

## 3. Universal Search — the central Lima interface

This is a substantial change from the previous Quick Ask design.

The search bar can now search the web and invoke Lima tools. It becomes the universal entry point for browser navigation, native macOS actions, AI, and personal knowledge.

There should still be a separate fast-answer path for questions that do not require tools.

### 3.1 Search modes

Search anything or run a command… (⌘K)

Modes: Everything · Web · Tools · Quick Ask · Agent Ask

Everything: Search local files, browser tabs, notes, history, commands, and optionally connected services.

Interactive mode selector illustrating how one search input routes different classes of requests.

### 3.2 Intent routing

Lima should support both explicit and automatic routing.

| Example input                       | Expected result                                   |
| ----------------------------------- | ------------------------------------------------- |
| `github`                            | Local application, tab, and web matches           |
| `web: latest macOS updates`         | Live web results                                  |
| `What is the capital of Norway?`    | Quick direct response, no workspace               |
| `Take a screenshot of monitor 2`    | Invoke Screenshot Studio through Lima tools       |
| `Open my project notes`             | Open the corresponding sidebar surface            |
| `Summarize this webpage`            | Ask for authorized page content, then use AI      |
| `Switch audio output to headphones` | Execute the native audio output tool              |
| `Run tests on my project`           | Start or delegate a terminal task                 |
| `What did I accomplish last week?`  | Search Context Shelf and available weekly reports |

The command prefixes should be optional. An intent classifier can identify likely actions, but explicit user selection must be available if the intent is ambiguous.

### 3.3 Search tool execution

Search should be able to invoke built-in Lima tools and user-authorized MCP tools.

A structured tool result can render inline with the query, rather than opening the workspace.

Examples are an audio device picker, screenshot launcher, password generator, file operations, terminal task status, meeting details, and a Notes creation action.

Low-risk commands can execute immediately. Destructive or externally visible actions must pass through the shared authorization broker.

The search interface should not silently send every local query to a web provider. Live web search should follow explicit intent or the user's chosen search preferences.

### 3.4 Technical search pipeline

```
Global Search Input
        |
        v
Query Normalizer
        |
        v
Intent Router
        |
        +---- Local Search Index
        |
        +---- Browser Tabs / History
        |
        +---- Web Search Provider
        |
        +---- Connected Service Search
        |
        +---- Lima Tool Registry
        |
        +---- CLI AI Provider
        |
        v
Ranking and Result Composer
        |
        v
Inline Result / Action / Sidebar
```

The engine should support parallel result providers with independently bounded execution times. A slow cloud service must not hold up local application or command results.

Custom indexing should cover app aliases, files, Notes, canvas blocks, browser metadata, authorized service metadata, activity history, and weekly summaries.

Search state must remain stable while new results arrive, preserving selection when possible.

### 3.5 Performance objectives

These are proposed engineering targets, not measured performance claims.

| Operation                   | Target                                                              |
| --------------------------- | ------------------------------------------------------------------- |
| Open local search           | p95 under 100 ms                                                    |
| Local result update         | p95 under 75 ms after keystroke                                     |
| Show cached tool catalog    | p95 under 100 ms                                                    |
| Display web search progress | Under 150 ms                                                        |
| Open sidebar tool           | p95 under 200 ms                                                    |
| Quick Ask overhead          | Minimize Lima processing; measure separately from CLI/model latency |

No expensive model classification should be required before ordinary application and file searching works.

## 4. Zen Browser migration

Lima should fork Zen Browser and become the main installed browser. The existing standalone Lima 4.x application becomes a migration source rather than a second long-term product.

### Target architecture

Lima Browser / Gecko — Tabs, sites, navigation, Search, sidebar, workspaces

↓ Versioned, permission-gated browser bridge

Native Runtime — Swift, AppKit, system services

- Agent Supervisor — Codex, Claude, OpenCode
- Data Engine — Encrypted Notes, search, context
- Integration Runtime — MCP, Apple, Google, Slack

Native Background Service & Local Keychain — Scheduling, secure storage, monitoring, notifications

The application should use a privileged browser bridge for trusted Lima UI, with a separate native IPC boundary. Ordinary websites must never inherit native filesystem, terminal, Notes, or MCP privileges.

### Migration requirements

Preserve bookmarks, passwords where migration is authorized and supported, tab/workspace preferences, and appropriate Zen profile data. Migrate Lima Notes, settings, custom commands, saved AI conversations where supported, and user-approved integrations.

A browser profile migration should have an independent rollback path from the Lima Notes/data migration.

Firefox and Zen upstream security patches should be regularly rebased or reapplied through a controlled pipeline. The fork must retain its own stable application identity, signing, profile location, updater, and release channels.

The architecture should remain macOS-only even though Gecko and Zen have broader platform support. This allows the native services to use Apple frameworks without a cross-platform abstraction layer for every feature.

## 5. AI and interactive terminal specification

### 5.1 Persistent interactive terminals

Agents should operate inside real PTY sessions, exactly as an interactive user would.

They can observe output, send keystrokes, wait, respond to prompts, interrupt processes, and continue working without requiring a new terminal process for every command.

The terminal service should preserve working directory, environment, scrollback, child processes, and process state independently of UI windows.

### 5.2 Explicit keyboard handoff

Because this is a shared terminal, user and agent input must be coordinated.

A terminal has one active input owner at a time: user or authorized agent. An agent may observe continuously but needs an input lease before typing.

The user can reclaim control immediately. Pending AI keystrokes are discarded after a lease is revoked.

Terminal status should visibly distinguish observing, controlling, waiting, running, paused, blocked, and disconnected agents.

### 5.3 Multiple terminals and agents

Agents should normally get isolated working terminals and Git worktrees when modifying the same repository concurrently.

Users can open additional shells, split terminal panes, detach terminals, or connect to an agent's existing session.

The pop-out terminal should have full terminal capabilities and preserve its active session when returned to the sidebar.

A coordinator agent can spawn workers, assign tasks, inspect results, and request changes. The coordinator must not merge conflicting changes invisibly.

### 5.4 Native CLI integrations

Maintain three primary adapters: Codex CLI, Claude CLI, and OpenCode CLI.

They need reliable executable discovery, version checks, authentication diagnostics, model discovery, streaming, cancellation, permission handling, and process recovery.

Model lists should use the CLI's actual installed capabilities, with cached results and a dependable CLI Default option. An unavailable model should never break an unrelated working conversation.

Remove direct model API backends, but retain service APIs required by Google, Gmail, Slack, GitHub, and MCP.

Quick Ask, full chat, grammar correction, and tool execution should share the CLI provider infrastructure while retaining separate policies.

### 5.5 Failure recovery

A CLI or model failure should appear as a small recoverable error attached to the affected message or task.

The conversation should not disappear, lose its draft, or become unusable.

Preserve the terminal transcript, agent state, selected model, and recoverable context. Expose specific diagnostics for authentication, missing executable, incompatible CLI version, model rejection, process crash, and connection failure.

### 5.6 Git and change tracking

For explicitly created coding projects, initialize Git when no repository exists. For existing repositories, preserve history and configuration.

Track file changes, tests, commits, worktrees, and agent ownership. Provide visual diffs and reversible changes before merge.

Broad project permissions are the default, with confirmation for destructive actions, remote publishing, external messages, and operations outside authorized project roots.

## 6. Notes 5.0

Notes should remain in the sidebar and be able to expand into a large workspace or independent canvas window.

### Classic Notes

Maintain Markdown editing, tables, checklists, images, code, links, search, and familiar notebook organization.

Existing notes should migrate without losing content or forcing a new layout.

### Canvas Notes

Introduce a freeform editor where blocks can be positioned, resized, grouped, connected, and rearranged.

Support text, diagrams, arrows, sketches, images, code blocks, web references, structured tables, flowcharts, automation blocks, and live service widgets.

The underlying format should be a structured document model with persistent block IDs and spatial coordinates, rather than Markdown alone.

### AI-enabled Notes

Provide structured tools for creating, editing, moving, connecting, grouping, and cleaning up blocks.

The AI can generate architecture diagrams, build project plans, organize a messy canvas, summarize connected material, and turn selected blocks into tasks or automations.

Every AI edit should be transactional and undoable. Fix the Command-Z crash across Notes and all other editable components with a consistent undo architecture.

### MCP Notes server

Expose Notes through Lima's own MCP server so compatible agents such as Codex, Claude, and OpenCode can search, create, and update notes.

Writes must use the same authorization, versioning, and undo policies as the internal Notes editor.

## 7. Local encryption and offline-first storage

No online key requirement

The previous requirement for an always-online encryption service is removed completely.

Lima should store data locally with encryption at rest and remain accessible offline. There should be no need to contact a remote server to decrypt Notes, search history, or Context Shelf data.

### Encryption architecture

| Component                     | Proposed method                                                 |
| ----------------------------- | --------------------------------------------------------------- |
| Local database                | SQLCipher or equivalent authenticated encrypted SQLite solution |
| Attachments and canvas assets | Per-file authenticated encryption                               |
| Data encryption keys          | Generated locally, protected by macOS Keychain                  |
| Hardware protection           | Secure Enclave-backed protection where applicable               |
| Search indexes                | Encrypted along with source data                                |
| AI transcripts                | Encrypted local persistence                                     |
| Context Shelf                 | Encrypted event records                                         |
| Temporary processing          | In-memory plaintext only as needed; controlled temporary files  |
| Recovery                      | Optional passphrase-wrapped recovery key and encrypted backup   |

Use CryptoKit for authenticated file encryption, with a separate random key for each protected object or collection where practical.

Do not implement a custom encryption algorithm.

### Offline behavior

When offline, Lima should still open Notes, search local content, manage terminals, run installed local utilities, and use previously available data.

Cloud-backed AI CLIs, web search, and connected services may be unavailable without internet. Their failure should not prevent the rest of Lima from operating.

Background notifications and reports based on local activity should also work without internet, provided the Mac and necessary user session services can run.

### Automatic migration

The update process should detect existing plaintext Lima data, create encrypted replacements, verify integrity and record counts, and move the application to the new encrypted store.

Never destroy the original before verifying the encrypted copy and preserving an appropriate recoverable backup.

Legacy caches, diagnostic logs, temporary files, and search indexes should be audited for unencrypted sensitive content.

Important boundary: Encryption of Lima-owned databases does not automatically encrypt every file Gecko writes into its browser profile, nor does it encrypt arbitrary project files edited by terminal agents. Browser-profile protection should be specified separately, with FileVault recommended for full-device at-rest protection.

### Local key recovery

The design must account for Keychain loss and device replacement. An optional recovery passphrase can protect a separately wrapped recovery key.

Without a backup or recovery key, loss of the device-bound key may make encrypted data unrecoverable. The interface should explain that before enabling stronger protection modes.

## 8. Context Shelf, computer awareness, and weekly reporting

The Context Shelf should store structured activity metadata rather than continuous recordings.

### Recorded activity

Examples include active application changes, document opens, browser navigation metadata, terminal command events, Git modifications, agent activity, meeting participation metadata, completed tasks, and music playback information.

The system should not store raw typing, password entry, private field contents, or continuous screen recordings.

Private browsing, sensitive applications, and selected projects should support exclusions.

### Music history

Store available track title, artist, album, player, playback timestamps, duration, and related metadata.

Do not store listened-to audio recordings.

### Friday weekly report

Every Friday at 3:00 PM local time, the native background agent should generate a report from the week's available activity.

Report sections should include projects worked on, code changes, meetings, notes, AI activity, tasks completed, unfinished work, and meaningful trends.

All reports should remain searchable through universal Search.

The background scheduler should use a user-scoped launchd service. If the Mac is asleep or shut down at 3:00 PM, it should generate the missed report when the device and service are next available, without generating duplicate reports.

Activity history and report generation should be independently configurable, with retention and deletion controls.

## 9. Screenshot Studio and text recognition

Screenshot Studio should be a workspace tool rather than a separate top-level window.

The workflow is: open Studio in the sidebar, invoke a temporary screen-selection overlay, capture, then return the result to Studio for annotation or AI use.

Use native macOS display and screen-capture APIs.

The capture engine must correctly handle multi-monitor layouts, negative display coordinates, Retina scaling, mixed DPI, fullscreen Spaces, large monitors, window boundaries, and permission changes.

### Visual and functional requirements

Provide smooth region-selection outlines, corner handles, magnification, pixel-accurate dimensions, selectable windows, annotations, arrows, blur/redaction, OCR regions, and clear save/copy actions.

The selection overlay should be responsive and visually polished without obscuring the target.

OCR must account for coordinate transforms between display pixels and the workspace UI.

Screenshots should not automatically enter permanent context history unless explicitly saved or attached to a task.

## 10. Audio, dictation, and media controls

### Audio controls

The vertical rail should contain a compact audio picker showing the current output device and a minimal volume control.

A detailed audio mixer can open in the sidebar and provide supported per-application and per-browser-tab controls.

Remove the duplicate volume slider from the music widget.

Dragging the music bar must only reposition the bar, not open Spotify or another music application.

### Spotify

Maintain track metadata, playback controls, and a Spotify DJ shortcut.

A DJ shortcut may need to open the supported Spotify interface if direct DJ control is unavailable through its public API. It should not depend on undocumented endpoints.

### Music-reactive effects

Provide an optional real-time visualizer that responds to detected bass transients, energy peaks, and major musical changes.

The background can transition into a laser-like effect during high-energy sections, then return to normal.

Use a bounded GPU budget, avoid unnecessary audio capture, and disable or reduce effects under Reduce Motion, battery-saving, or thermal constraints.

### Dictation and calls

Improve microphone selection, passthrough handling, capture state, and support for calls occurring on the computer.

Audio routing should distinguish microphone input, application output, system audio, and transcription capture.

Use native Core Audio and ScreenCaptureKit functionality where supported, with explicit permissions.

Bluetooth microphone mode can reduce playback fidelity on some devices; software changes cannot guarantee the same audio quality across all hardware. Lima should expose the limitation and offer the best available routing choices.

## 11. Integrations, MCP, webhooks, and automation

Lima should have first-class native integrations for authorized Google, Slack, GitHub, and Apple services.

| Integration     | Target features                                            |
| --------------- | ---------------------------------------------------------- |
| Google Calendar | Read-only event search, upcoming meetings, availability    |
| Google Meet     | Calendar-linked meeting details, quick join, tab awareness |
| Gmail           | Search, summaries, drafts, optional send actions           |
| Apple Calendar  | Native EventKit access                                     |
| Apple Reminders | Native task discovery, creation and completion             |
| Apple Mail      | Supported native mail workflows                            |
| Slack           | Search messages, channels, threads and authorized actions  |
| GitHub          | Repository state, PRs, issues, workflows and reviews       |
| n8n             | Workflow connections, execution status, triggers, webhooks |
| MCP providers   | Install, configure, authorize, run and inspect tools       |

No Firefox extension should be required for Lima's own Zen awareness.

Browser metadata may help with context, but structured service APIs should be preferred over scraping authenticated pages when an appropriate authorized API exists.

### MCP client

Provide a connection manager with server installation, transport configuration, authentication status, tool discovery, permissions, execution logs, and troubleshooting.

Support local MCP servers and approved remote services.

### MCP server

Expose Lima Notes, context search, project information, permitted terminal sessions, available tool actions, and automation status to external AI agents.

Use explicit client authorization, scoped capabilities, and audit records.

### Automations

Support scheduled, event-driven, and webhook-triggered workflows.

Automations should be constructible visually with a flow editor inside the sidebar or a larger workspace canvas.

High-impact write actions and external submissions must have the same approval policy regardless of whether they originate from a search command, chat, MCP tool, or automation.

### Retire the extension framework

Replace the custom extension marketplace with built-in features and a standardized MCP integration model.

Migrate bundled utilities to native command modules. Preserve hotkeys and appropriate user preferences.

Custom extensions without direct replacements should have an explicit export or migration path.

## 12. Build infrastructure and browser maintenance

The Zen fork should have a continuous upstream patching pipeline, not an ad hoc process that depends on manually noticing browser updates.

### Build dashboard

Create an authenticated monitoring website showing upstream Firefox/Zen revisions, Lima revision, build status, test results, security checks, artifacts, and release state.

Build stages should include upstream synchronization, patch application, compilation, tests, integration validation, signing, notarization, package verification, and staged release.

### Automatic patch pipeline

Detect relevant upstream changes, prepare a patch branch, run compatibility checks, and determine whether the patch is safe to promote.

For security updates, use an expedited workflow that still requires successful verification and rollback capability.

Failed patch application should produce a readable conflict report. The system must not silently discard Lima modifications to force an upstream rebase to succeed.

### Release requirements

Use a stable macOS signing identity and a verified update mechanism. Browser updates are especially security-sensitive.

The final Lima 5.0 release should have a tested rollback mechanism for both binaries and user data migrations.

## 13. Implementation architecture contracts

All components should communicate through versioned interfaces rather than importing each other's internal state.

| Interface                | Responsibilities                                             |
| ------------------------ | ------------------------------------------------------------ |
| `SearchService`          | Query routing, federated search, ranking and actions         |
| `BrowserContextService`  | Authorized tab, page, navigation and selection metadata      |
| `ToolRegistry`           | Built-in tools, permissions, MCP discovery                   |
| `TerminalSessionService` | PTY lifecycle, output, keystrokes, input leases              |
| `AgentSupervisor`        | CLI processes, model configuration, tasks, orchestration     |
| `ProjectService`         | Git repositories, worktrees, changes and project permissions |
| `NotesService`           | Documents, blocks, canvases, revisions and AI editing        |
| `ContextService`         | Event ingestion, retention, search and reports               |
| `AudioService`           | Devices, playback metadata, capture and visualizer           |
| `CaptureService`         | Displays, screenshots, OCR and annotations                   |
| `IntegrationService`     | OAuth, API credentials, provider synchronization             |
| `AutomationService`      | Schedules, triggers, workflows and background execution      |
| `DataSecurityService`    | Local encryption, key management, migration and recovery     |
| `UpdateService`          | Version verification, installation and rollback              |

A service should expose stable typed requests and events, with explicit error codes, deadlines, cancellation support, and version compatibility checks.

For example, an AI action from Search should flow through SearchService → ToolRegistry → Authorization Broker → relevant native service → structured result.

The browser UI should not bypass those boundaries by directly launching shell commands or accessing encrypted storage.

## 14. Prioritized implementation plan

The delivery remains one public Lima 5.0 release. Work is divided into internal development gates so that completed features can be continuously verified.

## Internal development sequence

1. Foundation and reliability

   Freeze the 5.0 architecture and service contracts. Fix the existing Notes undo crash, CLI failure recovery, model discovery, and known multi-monitor capture bugs. Establish unit, integration and UI test infrastructure.

   Exit gate: legacy workflows are regression-tested and migration contracts exist.
2. Zen fork and native bridge

   Build the Lima-branded browser, native service host, authenticated IPC, sidebar, vertical rail, browser awareness, and monitor-pinned floating mode.

   Exit gate: browser navigation and all required native service boundaries work together.
3. Universal Search and CLI overhaul

   Implement local/web/tool search, Quick Ask, agent routing, CLI discovery, persistent PTYs, explicit keyboard handoff, multi-terminal management, and agent supervision.

   Exit gate: search can run web queries and authorized Lima tools; agents can safely share and manage terminals.
4. Data platform and Notes

   Implement locally encrypted storage, offline unlocking, automatic migrations, classic Notes, spatial canvases, custom search indexing, and the Notes MCP server.

   Exit gate: existing user data migrates without loss, remains usable offline, and supports transactional undo.
5. Integrations and automation

   Add native Apple services, Google integrations, Slack, GitHub, n8n, external MCP servers, webhooks, visual automation, and the background weekly reporting service.

   Exit gate: connected services and background tasks pass authorization, error handling and recovery tests.
6. Media, screenshots and UI polish

   Complete Screenshot Studio, OCR reliability, compact audio controls, Spotify integration, music effects, dictation routing, the activity bar, and application branding.

   Exit gate: workflows pass display, hardware and accessibility test coverage.
7. Full verification and public release

   Run comprehensive regression, security, performance, integration, migration, signing, update and rollback tests. Launch build monitoring and upstream patch automation.

   Exit gate: one production-ready Lima 5.0 release with the committed feature scope complete.

### Engineering priority

| Priority                         | Workstreams                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| P0 — Architectural blockers      | Zen fork, native bridge, local encryption, CLI supervisor, stable state management     |
| P0 — Reliability                 | Terminal handoff, crash recovery, Notes undo, screenshot coordinates, failure handling |
| P1 — Core product                | Universal Search, sidebar, vertical rail, agent orchestration, Notes canvas            |
| P1 — Data and connected services | Context Shelf, MCP, Google/Apple integrations, automation                              |
| P2 — Enhanced experience         | Audio mixer, music effects, advanced canvas layouts, UI animations                     |
| Release-blocking                 | Security tests, compatibility tests, data migration, updater, rollback, performance    |

P2 means lower engineering priority, not deferred to a post-5.0 release. All approved functionality remains in the release scope.

## 15. Verification and acceptance requirements

| Area           | Required acceptance result                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| Search         | Local, web, CLI AI and tool results work from the same input                           |
| Sidebar        | Notes and AI tools remain usable without replacing the webpage                         |
| Vertical rail  | Remains accessible, configurable, and correctly anchored                               |
| Terminal       | No keystroke conflicts, lost output, or orphaned subprocesses                          |
| Agents         | Concurrent tasks and Git worktrees remain isolated                                     |
| CLI            | Missing login, model failures and disconnects recover without destroying conversations |
| Notes          | Legacy notes preserved; canvas operations and undo reliable                            |
| Encryption     | No unintended plaintext Lima data; offline access verified                             |
| Migration      | Verification, interruption recovery, and rollback tested                               |
| Browser        | Standard browsing, tabs, downloads, authentication and private mode remain functional  |
| Capture        | Mixed-resolution, multi-monitor, fullscreen and large-monitor tests pass               |
| Audio          | Device switching and music controls do not create unintended actions                   |
| Integrations   | OAuth scopes, revocation, errors and permission enforcement verified                   |
| MCP            | External agents can only access approved Lima capabilities                             |
| Weekly summary | Background report runs, or catches up after the Mac is available                       |
| Updates        | Signed, tested, rollback-capable and compatible with upstream browser security patches |

Suggested performance gates include no meaningful degradation in browser responsiveness compared with the underlying fork, no main-thread blocking from agent or tool work, bounded memory usage under concurrent agents, and measurable recovery from service crashes.

Testing must use real macOS hardware configurations in addition to automated fixtures. In particular, a multi-monitor test matrix should include differently scaled displays, fullscreen applications, monitors connected or disconnected during runtime, and an M1-class Mac.

## 16. Main feasibility risks

1. Maintaining a browser fork

Firefox security updates and Zen changes create ongoing maintenance. Keep patches narrow, automate rebase testing, and avoid modifying the browser engine when trusted frontend integration is sufficient.

2. Privileged AI execution

Agents will have significant local capabilities. Permission enforcement must be external to the model, with protected filesystem boundaries and explicit authorization for destructive actions.

3. Data migration and encryption

The existing Lima data store and the new browser profile have different security and persistence requirements. Treat them as separate migrations and test recovery before release.

4. Multi-agent performance

Firefox, multiple CLI processes, audio capture, indexing, and live Notes canvases can compete for resources. Process isolation, scheduling, and bounded concurrency are essential.

5. One complete major release

The feature scope is large. Keep the single public launch, but make each internal milestone independently testable and prevent partially completed modules from destabilizing the main development branch.

## Final technical direction

Lima 5.0 should have three defining experiences.

Search is the universal entry point. It handles local information, web search, native tool execution, Quick Ask, and full AI tasks without unnecessary navigation.

The sidebar is the persistent workspace. Notes, AI conversations, terminals, agents, connected data, and automations live alongside the webpage. Its bottom-anchored vertical rail makes switching tools immediate, with optional native floating and monitor-pinned modes.

The native runtime performs the work. Interactive terminal agents, macOS integrations, MCP tools, locally encrypted storage, screenshots, audio, and background analysis remain independent of browser rendering but feel integrated into one application.

This produces a coherent Lima 5.0 product rather than simply embedding the old Lima window inside Zen.

The design now explicitly requires offline-capable local encryption, web- and tool-enabled universal Search, and a productivity sidebar with a vertical utility rail, alongside the previously agreed complete single-release scope.
