# Browser bridge protocol v1

Transport: lima-host child process spawned by trusted chrome (`LimaBridge.sys.mjs`) via Subprocess pipes.
Framing: 4-byte little-endian length + UTF-8 JSON (max 4 MiB). Host exits on stdin EOF.

Request  `{ "v": 1, "id": "7", "method": "agents.discover", "params": {...} }`
Response `{ "v": 1, "id": "7", "ok": true, "result": ... }` or `{ ..., "ok": false, "error": { "code", "message" } }`
Event    `{ "v": 1, "event": "chat.updated", "data": ... }`

| Method | Params | Result |
|---|---|---|
| `host.hello` | — | protocol, hostVersion, pid, methods |
| `host.ping` | — | pong, time |
| `agents.discover` | — | `CLICapabilityManifest[]` |
| `auth.evaluate` | `{ operation: ActionOperation, projectRoots: [path] }` | `AuthorizationResult` |

Error codes: `bad_request`, `unsupported_protocol_version`, `unknown_method`, `not_authorized`,
`confirmation_required`, `deadline_exceeded`, `internal_error`. Source of truth: `native/Sources/LimaProtocol`.

## Workspace handoff and discovery

- Assistant delegation is a browser-origin request. The method assistant.delegate accepts text, an optional workspace id, an optional provider and model for newly created workspaces, and optional user-selected browser references. Its result contains a workspace and its conversation. The user instruction is stored in the workspace conversation.
- The browser-side assistantTabs operation lists HTTP(S) tabs from regular browser windows. assistantReadTab validates the chosen tab identifier and URL before reading a bounded excerpt from a loaded page.
- chat.resources accepts the conversation id from the Lima interface. It returns skill names, configured MCP names, settings locations, and file names. It returns no configuration values.
- workspace.browserAction accepts an owned URL, an action, and bounded input fields. For a browser-only helper the assigned page takes precedence over tool arguments. The browser validates the loaded origin and returns observations or screenshot data. That helper identity is authorized only for workspace.browserAction and workspace.browserPlan.
- Lima has no terminal. Workspaces get no shell; agents run commands with their CLI's own shell tool in the workspace directory, under the permissions Lima gives that CLI. The `terminal.*`, `workspace.run`, `fs.changes` and `fs.gitFile` methods, the `terminal_*` and `workspace_run` MCP tools and the `terminal:control` grant are gone. Old Terminal tabs open Home.

Live browser events are delivered to identified browser connections. Tool clients receive their own request responses. Each browser connection has a bounded, ordered writer that closes an unresponsive peer independently of runtime work.

Terminal state may include shellReady, userEditing, and activeCommand. Terminal startup returns the error from starting the requested shell or entering its directory.

### Tasks (Orchestrator)

`task.submit` (browser origin) accepts `text`, an optional workspace `id`, `name`, `provider`, `model`, `mascot`, `references`, `referenceCount`, and a `requestId` that makes the submission idempotent. It returns `{ task, workspace }`. `task.list` (optional `workspaceId`, `limit`) and `task.get` return `{ task, children }` trees. `task.cancel`, `task.pause` and `task.resume` take an `id`, and `task.concurrency` sets `maxAgents`. These methods accept only the browser origin. Workspace agents call `task.delegate` (`name`, `objective`, `role`, `dependsOn`, `successCriteria`, `provider`, `browserUrl`), `task.status`, `task.message` (`kind`, `text`) and `task.inbox`, all bound to their own workspace by token. Every change is broadcast as `task.updated` with the public record, which omits reference text and routed messages. See docs/architecture/orchestration.md.

`task.visualState` is a read-only browser method used on connection. It returns `{ id, workspaceID, state, role, updatedAt, startedAt, recovering }` records for active assigned tasks and each workspace's latest settled task. The browser bridge emits local `host.connected` and `host.disconnected` signals for resynchronization. These signals are generated in chrome. See [visual activity](../../docs/architecture/visual-activity.md).

Workspace-scoped `image.*` calls use revision IDs and idempotency keys for mutations. Browser callers supply `workspace_id`. Authenticated agents inherit their workspace from the connection. `image.changed` reports committed revision changes, and `image.preview` returns a reduced-size PNG to the browser. See [Image Studio](../../docs/architecture/image-studio.md) for supported operations.

`image.generate` returns a persistent `operation_id` for the local provider job. `image.generation_status` reports verified assets as they are imported. The `vector.*` and `animation.*` families use the same workspace authorization, stable document and object IDs, and exact source revisions. `vector.render` and `animation.render_preview` return image bytes only to Lima's browser interface.

`workspace.reveal` (browser origin only) shows a workspace's project folder in Finder for the sidebar's Reveal Project Folder.

Workspace deletion returns archivePath for a top-level workspace, directoryKept when its source stays in place, and recoveryPath when a verified archive exists alongside a staged recovery copy.

### Workspace requests

`assistant.plan` selects existing workspace IDs or proposes a new workspace based on the task and browser catalog. The Companion confirms existing destinations before calling `assistant.delegate`. Tab extraction is read-only and excludes private windows.

`workspace.askUser`, `workspace.requestPermissions`, `workspace.requestApproval` (`kind` `approval` or `login`, optional `site`, `url`, `risk`, `grant`), `workspace.location`, and `workspace.browserPlan` suspend the requesting tool while the UI displays a request. A request never expires: if the agent's turn ends or its tool call nears its 600-second limit, the call is released with `deadline_exceeded` but the card stays until the user answers, and the answer is then sent to the workspace chat as a message (continuing a task blocked on the user). A task that ends its turn blocked on the user (`needsUser`) gets the same kind of card; a reply in that chat also answers it, so the task continues and the card closes. `prompt.opened` and `prompt.closed` update the sidebar and Companion. A helper agent's prompt carries `parentWorkspaceId` and also appears in its parent workspace's chat. The browser answers with `workspace.promptReply`. An approved browser session is bound to the workspace, assigned tab URL, exact same-origin path allowlist, and declared actions for five minutes. The orchestrator authorizes routine plans and can provision a workspace tab on demand. A higher-risk plan appears in the Companion and workspace approval tray. Explicit decisions are encrypted locally and keyed to the exact site, paths, actions, goal, and plan across all workspaces. Plans that can spend money or change an account (bets, payments, orders, transfers, account deletion, sending messages, publishing, password changes) always show an approval prompt with the full request, and the decision is never remembered. Helpers may use an assigned HTTPS tab or a loopback test page. Live updates, query changes, and navigation between approved paths preserve the session. Clicks may supply an inspected label to recover a moved control. Inspection supplies a same-origin path for visible links. `agent.dismiss` closes a finished direct helper's workspace tabs and folder.

No browser step is refused outright. When `workspace.browserAction` reaches a sensitive step — a control that can spend or move money (bets, Play/Roll/Deal on wagering pages, purchases, deposits, transfers), one that acts on the account (send, publish, delete, sign in, form submits, file inputs, downloads), a password or payment field, or a page outside the plan's paths — the page returns `needsApproval` and the runtime shows the user an approval card. Approved, the step runs (`confirmed`) and the tool returns its normal result; declined, it returns `{ approved: false, reason }`. Approval cards carry `facts` (labelled values such as Site, Path, Text; passwords are masked), `risk` (`money`, `account`, `system` or `access`) and `allowTask`. `workspace.promptReply` accepts `scope`: `once` approves this plan or step; `task` (Allow for this task) also lets later sensitive steps in the same session run without asking. Sessions renew for five minutes on each use, up to 30 minutes, or four hours for a task approval. Sessions belong to a workspace family (a lead workspace and its helpers): `workspace.browserPlan` returns an active family session that already covers the site, paths and actions without asking again. A money plan is only covered by a task approval.

`workspace.requestPermissions { summary?, items: [{ id, request, detail?, kind: approval|login|browser, risk?, url?, paths?, actions? }] }` (1–8 items) is how an agent asks, at the start of a task, for everything it expects to need. One card lists the items, with Approve all. Once it's approved, items are kept for the workspace family for four hours: `workspace.requestApproval { grant: id }` returns `{ approved: true, preapproved: true }` without a card, and `workspace.browserPlan` authorizes a plan inside an approved browser item's site, paths and actions. A high-risk browser item is listed but not granted (`asksAgain`), and sensitive in-page steps still ask. A lead workspace closing drops its family's grants.

Structured questions accept one to eight fields with unique IDs, labels, and a type of `text`, `date`, `time`, `number`, `select`, or `checkbox`. The browser submits an object keyed by field ID in `workspace.promptReply.values`. Dates and times use local form values (`YYYY-MM-DD` and `HH:mm`) and numbers and checkboxes use JSON numbers and booleans. Omitted fields preserve the plain-text prompt and its `answer` response.

No AI action outside the browser is refused outright either. Anything Lima's policy would stop asks the user on the same approval card, with a short brief in its facts. Approved, the call continues; declined, it fails with `not_authorized` and a message telling the agent not to retry. The cases are:

- a capability above the `allow` level;
- an outside AI tool (MCP) using a scope it hasn't been granted (`notes:write`, `workspaces:create`, capability scopes, and the read grants) or a capability not exposed to MCP; "Allow for this task" grants the scope to that one MCP session (one `lima-host mcp` process, identified by the `session` it sends to `host.identify`) until Lima quits, never to other MCP clients, and Integrations still grants it permanently;
- a helper starting another agent, which then joins the lead workspace;
- a browser-only helper calling beyond its tab;
- `workspace.files` outside the workspace folder.

Requests from outside tools have no workspace: their `workspaceId` starts with `external-` and `workspaceName` names the caller (for example "Outside AI tool"). They appear in the Companion. A `approvalDigest` from `auth.approve` is still accepted in place of a card. Identity checks are not actions and still refuse: who may answer approvals, which workspace a token belongs to, and browser-only methods.

`workspace.location` asks the user to share an approximate location for a stated purpose. Approval starts a one-shot browser geolocation request if Location Services are enabled in Lima Settings. The agent receives rounded coordinates and an accuracy estimate. Lima does not save the location to the user's profile.

`personalMemory.get` and `personalMemory.save` are browser-only. The regular Lima Settings page can read or replace the encrypted record containing `name`, `email`, `phone`, `homeAddress`, `notes`, `shareNotes`, and `shareProfile`. An empty object clears the saved record. The sharing switches default to off and control what is sent to the selected provider when Companion prepares a response. There is no MCP method for accessing this record.
The Lima walkthrough (`about:lima?view=welcome`) may also call `personalMemory.get` and `personalMemory.save` for its optional About you step, which sends both sharing switches as the user leaves them.

`companionMemory.get`, `companionMemory.update` (`enabled`, `summary`) and `companionMemory.run` are browser-only (Settings; the walkthrough may get and update). They return `{ enabled, summary, status: "ready" | "queued" | "off", updatedAt, coveredThrough, nextAttemptAt, lastError }` and every change broadcasts `companionMemory.updated` with the same object. This record is separate from Personal Memory: the Companion writes it. Once a day the daemon folds the user's chat requests and recorded activity titles since `coveredThrough` (at most seven days) into at most 30 bullets with the default provider. The daemon checks at startup, every 15 minutes, and on wake, so a day missed while the Mac was off runs at the next check. A failed request keeps the window queued and retries after 15 minutes, doubling to 6 hours. `assistant.plan` includes the summary while memory is on, except in private windows. There is no MCP method for this record.

Companion requests are conversations created with `chat.create { companion: true }`. They stay in the Companion: `chat.list` and search leave them out, and `chat.list { companion: true }` lists only them (summaries carry `taskIDs`, `createdAt` and `preview`, the latest reply shortened to 120 characters). `chat.record { id, role, text, taskIds? }` (browser-only, Companion conversations only) appends a finished message without running a turn. The Companion records the request and what it did (an answer, a note it created, a handoff with its task IDs), so `chat.send` follow-ups get the whole exchange as context and fail over between providers like any chat.

`system.appearance` returns `{ dark }` from the macOS setting, and the runtime broadcasts `system.appearance` when it changes, including Auto switching. Lima sets the chrome's color scheme itself, so `prefers-color-scheme` there can't tell. The `lima.theme` preference (`system` by default, or `light` or `dark`; Settings → General → Theme) themes browser windows (`lima-theme` on the window root), Lima pages, Search and the Dock badge. Pages get the resolved theme in `agentPreferences.theme` and the `ui.theme` event, and set it with the `themeChanged` browser message. Private windows keep Zen's look.

`chat.send` and `workspace.instruct` take `mode`. While a reply is running, `queue` (the default) adds the message with status `queued`; queued messages run in order after the reply. `interrupt` stops the reply, which keeps what it wrote with a `cancelled` error ("Interrupted by your next message.", or is removed if it wrote nothing), and runs the message at once, ahead of anything still queued. `chat.interrupt { id, messageId }` does the same for a message already queued, and `chat.unqueue { id, messageId }` takes one back out before it runs. `chat.cancel` stops the reply, drops queued messages and returns `{ unsent: [text] }` for the composer to restore. In AI Chat and Companion chats, ↩ queues and ⌘↩ interrupts; a queued message shows Send Now and Edit.

### Scheduled tasks

A scheduled task hands an instruction to a workspace's agent once or on repeat, as an Orchestrator task each time (`requestId` `schedule:<id>:<run time>`, context "Scheduled · <summary>"). `when` is `{ kind: "once", at: "2027-01-22T09:00" }` (ISO 8601, local unless it carries a zone, or milliseconds) or `{ kind: "daily" | "weekdays" | "weekends", time: "08:00" }`, `{ kind: "weekly", days: ["mon", "thu"], time }`, `{ kind: "monthly", day: 15, time }` (a short month uses its last day). Times are wall-clock in the zone the task was created in. Records carry `summary` ("Every day at 8:00 AM"), `state` (`scheduled`, `paused`, `done`), `repeats`, `nextRunAt`, `nextRunLabel`, `createdBy` and the last 20 `runs` (`at`, `due`, `manual`, `taskID`, `workspaceID`, `error`).

- `schedule.create { title?, instruction, when, workspaceId?, workspaceName?, provider?, model?, mascot? }`. With no workspace, the first run creates one named `workspaceName` and later runs reuse it. A past time or an unparseable `when` is a `bad_request` that says what to fix. From an agent the task belongs to its own top-level workspace and needs an approval card (`risk: "schedule"`, "Runs on its own later") with When, Runs in and Each time; outside tools get the same card.
- `schedule.list { workspaceId? }`: everything for the browser; an agent sees its workspace's; others ask.
- `schedule.update { id, title?, instruction?, when?, paused? }`, `schedule.delete { id }` and `schedule.run { id }` (start a run now; the schedule is unchanged) are the user's; an agent asking gets an approval card.
- Events: `schedule.updated` (the record) and `schedule.deleted` (`{ id }`).

The runtime checks every 20 seconds. Lima must be running for a task to start; an occurrence that came due while it wasn't runs once when it is (missed repeats collapse into one run), and the instruction tells the agent it started late. Each run is claimed before the handoff, so a crash never runs the same occurrence twice. `assistant.plan` returns `schedule` (`title`, `instruction`, `when`, `summary`, `nextRunLabel`, `note`, `workspaceId` or `newName`) for requests that name a later time or a repeat; the Companion shows it for confirmation and creates it with `schedule.create`. The planner gets the current local time to work out dates, such as the day a 60-day booking window opens. Workspace agents get `workspace_schedule`, `workspace_schedules` and `workspace_unschedule`. Scheduled Tasks (`about:lima?view=schedules`, also in Search) lists Repeating, One time, Paused and Finished tasks with Run Now, Pause/Resume, Edit, Open Workspace and Delete, and creates tasks by hand.

Attachments: `chat.attach { id, name, type, data, upload?, done? }` (browser only) uploads a file in base64 chunks of up to 2 MB. The first chunk returns `{ upload }`, and the chunk with `done: true` returns `{ name, path, size, type }`. Files go in the workspace's `.lima-attachments/` folder (inside the agent's sandbox), or in Lima's `chat-media/<chat>/attachments/` for other chats. Names are sanitized, and the limit is 50 MB per file. `chat.send` and `workspace.instruct` take `attachments: [{ path, type }]`, and only files Lima saved for that chat are accepted. The CLI gets the paths after the message. Composers attach dropped and pasted files, and a paste over 4,000 characters or 80 lines becomes `Pasted text.txt`.

Steps: an assistant message's `steps` parallel `tools`, with `added` and `removed` lines for edits and `images` for pictures a tool returned. Edits are Claude Edit, MultiEdit and Write, OpenCode edit and write, and Codex `file_change` diffs. Images come from tool results, such as screenshots and pictures read. Images are stored in `chat-media/<chat>/` and read with `chat.media { id, mediaId }` as `{ type, data }`. Chat shows each step with +/− counts and thumbnails, and a thumbnail opens `about:lima?view=media&chat=…&media=…` in Glance (browser message `openGlance`, Lima media URLs only).

`chat.configure` takes effect at once. A reply that is still streaming is cancelled and restarts on the new provider or model, with the transcript as context; the new reply's `notice` says so ("Restarted this reply on Codex."). Otherwise the next turn uses it. AI Chat tabs and Companion chats both show provider and model pickers.

Lima never opens Zen's own site. Page and frame loads to `zen-browser.app` and its subdomains are cancelled in the parent process before they reach the network. A tab opened only for one of them closes.

`system.openSettings` (`pane`: `accessibility`, `files`, `location`, `automation`, `microphone`, `screen`) opens that macOS Privacy & Security pane with NSWorkspace, so the browser no longer shows Firefox's "open this link?" prompt. `system.permissions` returns what Lima can check without prompting (`accessibility`). Both are browser-only.

`agents.failover` returns whether provider failover is on (default `true`); `{ "enabled": bool }` changes it from Settings. With failover on, a chat turn or Quick Ask that fails with `rate_limited` before any text arrived continues with another signed-in provider: the user's default first, then Claude Code, Codex, OpenCode. The failed reply is replaced. The new assistant message carries `notice` ("Claude Code reached its usage limit, so Lima switched to Codex.") and the conversation's `provider` changes; a workspace's provider follows its agent conversation. Without another ready provider, the failure stays on the message as before, and the Orchestrator's usage-limit wait applies.

## Origins and trust

Every caller that isn't Lima's own interface passes `SecurityPolicy` before a method runs:
- An outside tool (MCP) reading personal content needs the matching read grant: `notes.list` and `notes.get` need `notes:read`, `search.query` needs `search:read`, `context.recent` and `context.reports` need `context:read`. Without the grant the user is asked, like any other ungranted scope. A fresh install grants no scopes.

The MCP server (`lima-host mcp`) runs each `tools/call` on its own runtime connection, so a call waiting on an approval never blocks `ping`, other calls or `notifications/cancelled` (a cancelled call is interrupted and gets no response). It validates arguments against each tool's input schema before dispatch (JSON-RPC `-32602` on a missing or mistyped argument) and negotiates `protocolVersion` from `2025-06-18`, `2025-03-26` and `2024-11-05`, answering with the newest for any other. Numeric limits are whole numbers clamped to each method's range.
- Some methods belong to the user. Any other caller, a workspace agent included, gets an approval card that names who asked and the method, with risk `access`, `system` or `account`. These are: the recovery-key export, screenshots (`capture.*`), Companion memory, chats (`chat.*`), activity history settings and deletion, Quick Ask, opening apps and System Settings, Messages, integration setup, updates, failover, Search index maintenance, Lima 4 import, MCP grants and the audio output. Declined, the call fails with `not_authorized`. Handlers keep their own narrower checks.

- A client states its origin in `host.identify`. `browser` is granted only to a peer whose code signature
  satisfies the daemon's own designated requirement (checked on the socket's audit token). The `--stdio`
  relay claims it only after verifying that its parent is the bundle's engine, signed by the same
  certificate: the compiled `Contents/MacOS/lima`, or `Contents/MacOS/zen` in a repacked bundle that has one; the grammar helper only when its parent is the daemon. Other claims fail with
  `not_authorized`. Debug builds accept any peer when `LIMA_TRUST_ANY_PEER=1`.
- `host.shutdown` requires the browser origin or a signature-verified lima-host peer (build replacement).
- The socket directory must be owned by the user with mode 0700, or neither side uses it.
- The runtime stops 10 seconds after Lima's last browser connection closes (quit or crash), unless the background launch agent is installed or `LIMA_KEEP_DAEMON` is set. Scheduled tasks run only while Lima is open; a missed run starts when it reopens.

## Updates

All `update.*` methods are browser-origin only. Development builds report phase `disabled`.

| Method | Params | Result |
|---|---|---|
| `update.status` | — | `{ phase, currentBuild, version?, build?, critical?, checkedAt, error, canRollBack, lastInstall? }` |
| `update.check` | — | status. Fetches `LimaUpdateFeedURL` and `.sig`, verifies the Ed25519 signature against `LimaUpdatePublicKey`, then downloads, digest-checks, extracts and code-signature-checks a strictly newer build (phase `ready`) |
| `update.install` | `{ browserPid }` | status (`installing`). Starts `lima-host apply-update`, which waits for that pid to exit, swaps the bundle, re-verifies it (restoring the old copy on failure), keeps the old copy for rollback and relaunches Lima |
| `update.rollback` | `{ browserPid }` | status. Reinstalls the copy kept by the last update |

Event `update.status` carries the same object whenever the phase changes. Phases: `disabled`, `idle`,
`checking`, `available`, `downloading`, `ready`, `installing`, `failed`.

## Note images, folders and the archive

`notes.image.add { source, alt?, width? }` turns an HTTPS image address (or a local preview) or a file path (absolute, `~/…`, or relative to the calling workspace's directory) into an encrypted note attachment. Lima fetches it once without cookies, checks that it decodes as an image, re-encodes it as PNG (dropping metadata, longest side at most 2400 px, at most 25 MB in) and returns `{ id, markdown, bytes }`, where `markdown` is `![alt|width](lima-attachment:id)`. In note Markdown, `|width` after the alt text sets an image's width: a percentage such as `50%` or pixels such as `320`.

Notes are bookmarks, so folders and the archive are bookmark folders under Notes; these methods ask the browser (`workspace.browserRequest` kinds `notesOutline`, `notesOrganize`, `notesArchive`, `notesUnarchive`). `notes.folders` (notes:read) returns `[{ folder, archive, notes: [{ id, title }] }]` by folder path. `notes.organize { id, folder }` moves a note into a folder path such as `Recipes/Desserts`, creating folders (up to four levels). `notes.archive { id }` moves a note to Notes/Archive and remembers where it came from; `notes.unarchive { id }` puts it back (or in Notes if that folder is gone). All three need notes:write.

Fenced `calculator` blocks render number inputs and rows computed from them: `{ title?, inputs: [{ id, label, value, min?, max?, step?, unit? }], rows: [{ id?, label, value, unit?, decimals? }], note? }`. A row's `value` is a formula: numbers, input ids and earlier row ids, `+ - * / % ^`, parentheses, and `round(x, digits)`, `ceil`, `floor`, `min`, `max`, `abs`, `sqrt`. A small parser evaluates it; nothing else runs.

## Workspace chats

A workspace's main chat is `conversationID`. `workspace.chats { id }` lists its chats (`{ id, title, main, running }`, main first); `workspace.newChat { id }` opens another with the same provider, folder and tools (not for helpers; at most twelve); `workspace.closeChat { id, chatId }` deletes one that isn't the main chat. Each broadcasts `workspace.chats { id }`. Messages to the main chat go through `workspace.instruct`; the others use `chat.send`. Browser only.

## Workspace folders

`workspace.makeFolder { path }` (a workspace agent's own workspace, or `id` from the browser) creates a folder and any missing parents inside the workspace directory and returns `{ path, absolutePath, created }`. The path is relative (such as `src/components`, at most 12 levels); absolute paths, `~`, `.`/`..` and any existing level that resolves outside the workspace through a symbolic link are refused, as is a file in the way. New folders are recorded in activity.

## Effort, tab folders and value blocks

`chat.configure` and `chat.create` accept `effort`: `low`, `medium` or `high` (or `default` for the CLI's own). The conversation keeps it and every turn passes it on: Claude Code as `--effort`, Codex as `model_reasoning_effort`. OpenCode has no such setting and ignores it. Quick Ask always runs at low effort.

`workspace.openTab` accepts `folder`, a folder path at the top of the workspace beside Tabs (up to three levels, such as `Docs` or `Research/API`), and `workspace.organizeTabs { tabs: [{ url, folder, title? }] }` (1–60) files pages and notes (`about:lima?note=<id>`) into those folders; an empty folder moves a page back to Tabs and a note to the workspace's top level, and `notes.organize` also files a workspace's tab for that note into the folder of the same name, and `title` adds a tab the user opened that the workspace doesn't track yet. It returns `{ folders, notFound }`. The browser builds the folders inside the Tabs folder and moves a tab only when its folder changes, so a tab the user dragged elsewhere stays there. `workspace.listTabs` reports each tab's `folder`.

Notes support value blocks: `{{name := 120}}` defines an adjustable number, shown as a light grey block, and `{{expression}}` shows a live result computed with the calculator formula rules from defined names and the input and row ids of calculators in the same note. Calculators can read defined names too. Typing @ in a note opens a picker of these values. MCP `notes_update` replaces a note's Markdown as one undoable agent edit.

