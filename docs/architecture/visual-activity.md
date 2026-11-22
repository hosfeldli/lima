# Lima visual activity

Lima uses white work surfaces, a soft-gray sidebar, graphite text, and compact controls. The folded-cap companion and its accessories provide the visual identity. Keep the Companion at the left edge and use existing Chat and Terminal tabs for details. A status change must leave the webpage and the user's selection in place.

| Surface | Default treatment |
| --- | --- |
| Companion button | 24 px mascot, short handoff or completion cue, accessible activity label |
| Workspace sidebar | Compact mascot, tab activity marker, soft red attention mark for unresolved requests |
| Companion and Chat | 52 px Companion illustration, 64–76 px Chat illustrations, labeled activity, tool rows, recent task steps |
| Agent list and Terminal | Smaller illustrated status, explicit ownership in Terminal |
| Welcome | 132 px illustration and replayable example of delegation |
| macOS Dock | Small badge during active AI work, with a static badge in Subtle and Reduce Motion |

## Runtime and rendering

`LimaVisualActivity.sys.mjs` is the browser-chrome owner of the shared projection. Its reducer in `ui/visual-state.sys.mjs` tracks conversations, workspace focus, terminal leases, open prompts, and Orchestrator tasks by identity. The Browser actor shares the projection with regular Lima pages. Rendering an illustration never changes runtime state or authorization.

- A disconnected runtime pauses activity cues. Pending questions and approvals take precedence when connected. An actionable child request also marks its ancestors in the sidebar.
- The Orchestrator owns planning, queued, waiting, paused, verifying, failed, and settled task status. Running tasks can use a verified surface, a visible provider tool call, or streaming text for more specific feedback.
- An open terminal animates agent input only while the agent holds the keyboard and the shell reports a running command. A prompt or user takeover stops that gesture. Browser focus adds a marker to the corresponding tab without expanding its folder or navigating the user's browser.
- A reply marked complete can display “Reply ready.” Only a live Orchestrator transition to verified `completed` plays the brief celebration. Reopening a task or reconnecting restores its status without replaying success. Warnings keep their own status.
- The bridge loads the compact task projection alongside workspace, prompt, and terminal snapshots when it connects. Live events received during hydration are applied after those reads. Chrome keeps the projection when content pages unmount.

## Motion and accessibility

**Companion Animations** in Settings → General defaults to Full. Subtle limits the mascot to brief expression cues. Off keeps the illustration, activity labels, and approval markers visible. macOS Reduce Motion disables decorative motion. Closed, obscured, and offscreen surfaces pause their mascot loops. Text streaming updates the active reply instead of rebuilding the whole conversation for each delta.

Browser click and typing markers are an independent opt-in in Settings → General. Normal browsing shows agent activity in the tab and sidebar. The welcome handoff example stays inside its own page. Its final gesture points users to the Companion button through a brief cue on the button itself.

## Verification

Run `node --test browser/tests/visual-state.test.mjs` and `make test`. The reducer tests cover streaming, independent agents, approval precedence, verified completion, reconnect, tab focus, and terminal ownership. In a disposable dev profile, check the Companion, a Workspace Chat, and General settings with Full, Subtle, Off, and macOS Reduce Motion. For a multi-agent performance review, profile a sustained run with visible and hidden workspaces before changing animation timings or adding new asset dependencies.
