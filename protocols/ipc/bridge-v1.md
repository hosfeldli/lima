# Browser bridge protocol v1

Transport: lima-host child process spawned by trusted chrome (`LimaBridge.sys.mjs`) via Subprocess pipes.
Framing: 4-byte little-endian length + UTF-8 JSON (max 4 MiB). Host exits on stdin EOF.

Request  `{ "v": 1, "id": "7", "method": "agents.discover", "params": {...} }`
Response `{ "v": 1, "id": "7", "ok": true, "result": ... }` or `{ ..., "ok": false, "error": { "code", "message" } }`
Event    `{ "v": 1, "event": "terminal.output", "data": ... }`

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
- terminal.attach returns info, base64 scrollback, and its ending byte offset. terminal.output includes the starting offset of that chunk. A frontend can deduplicate output that arrived while it was attaching.
- fs.gitFile is a browser-origin operation that takes terminalId, path, an optional previous path for renames, and a diff, stage, or unstage action. Paths must belong to the terminal repository.

Live browser events are delivered to identified browser connections. Tool clients receive their own request responses. Each browser connection has a bounded, ordered writer that closes an unresponsive peer independently of runtime work.

Terminal state may include shellReady, userEditing, and activeCommand. Terminal startup returns the error from starting the requested shell or entering its directory.

### Tasks (Orchestrator)

`task.submit` (browser origin) accepts `text`, an optional workspace `id`, `name`, `provider`, `model`, `mascot`, `references`, `referenceCount`, and a `requestId` that makes the submission idempotent. It returns `{ task, workspace }`. `task.list` (optional `workspaceId`, `limit`) and `task.get` return `{ task, children }` trees. `task.cancel`, `task.pause` and `task.resume` take an `id`, and `task.concurrency` sets `maxAgents`. These methods accept only the browser origin. Workspace agents call `task.delegate` (`name`, `objective`, `role`, `dependsOn`, `successCriteria`, `provider`, `browserUrl`), `task.status`, `task.message` (`kind`, `text`) and `task.inbox`, all bound to their own workspace by token. Every change is broadcast as `task.updated` with the public record, which omits reference text and routed messages. See docs/architecture/orchestration.md.

`workspace.reveal` (browser origin only) shows a workspace's project folder in Finder for the sidebar's Reveal Project Folder.

Workspace deletion returns archivePath for a top-level workspace, directoryKept when its source stays in place, and recoveryPath when a verified archive exists alongside a staged recovery copy.

### Workspace requests

`assistant.plan` selects existing workspace IDs or proposes a new workspace based on the task and browser catalog. The Companion confirms existing destinations before calling `assistant.delegate`. Tab extraction is read-only and excludes private windows.

`workspace.askUser`, `workspace.location`, and `workspace.browserPlan` suspend the requesting tool while the UI displays a request. `prompt.opened` and `prompt.closed` update the sidebar and Companion. The browser answers with `workspace.promptReply`. An approved browser session is bound to the workspace, assigned tab URL, exact same-origin path allowlist, and declared actions for five minutes. The orchestrator authorizes routine plans and can provision a workspace tab on demand. A higher-risk plan appears in the Companion and workspace approval tray. Explicit decisions are encrypted locally and keyed to the exact site, paths, actions, goal, and plan across all workspaces. Actions reserved for direct user control return an explicit error. Helpers may use an assigned HTTPS tab or a loopback test page. Live updates, query changes, and navigation between approved paths preserve the session. Clicks may supply an inspected label to recover a moved control. Inspection supplies a same-origin path for visible links. `agent.dismiss` closes a finished direct helper's workspace tabs and folder.

Structured questions accept one to eight fields with unique IDs, labels, and a type of `text`, `date`, `time`, `number`, `select`, or `checkbox`. The browser submits an object keyed by field ID in `workspace.promptReply.values`. Dates and times use local form values (`YYYY-MM-DD` and `HH:mm`) and numbers and checkboxes use JSON numbers and booleans. Omitted fields preserve the plain-text prompt and its `answer` response.

`workspace.location` asks the user to share an approximate location for a stated purpose. Approval starts a one-shot browser geolocation request. The agent receives rounded coordinates and an accuracy estimate. The location is unavailable to browser-only helpers.

## Origins and trust

- A client states its origin in `host.identify`. `browser` is granted only to a peer whose code signature
  satisfies the daemon's own designated requirement (checked on the socket's audit token). The `--stdio`
  relay claims it only after verifying that its parent is the bundle's engine, signed by the same
  certificate: the compiled `Contents/MacOS/lima`, or `Contents/MacOS/zen` in a repacked bundle that has one; the grammar helper only when its parent is the daemon. Other claims fail with
  `not_authorized`. Debug builds accept any peer when `LIMA_TRUST_ANY_PEER=1`.
- `host.shutdown` requires the browser origin or a signature-verified lima-host peer (build replacement).
- The socket directory must be owned by the user with mode 0700, or neither side uses it.

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
