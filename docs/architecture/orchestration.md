# Companion, Orchestrator and agents

Companion communicates, the Orchestrator coordinates, and agents execute.

| | Companion (`ui/assistant.js`) | Orchestrator (`LimaRuntime/Orchestrator.swift`) | Agents (workspace and helper chats) |
| --- | --- | --- | --- |
| Talks to the user | Primary | Through the Companion and Task Progress | Their own chat tab |
| Plans | Routes: answer, local action, or task | Owns tasks, dependencies and outcomes | Local plans for their assignment |
| Spawns helpers | Never | Records, gates and budgets them | Requests them with `task_delegate` |
| Verifies | Shows the result | Checks the report against the recorded turn | Supplies evidence in `lima-report` |

## Routing (Companion)

`assistant.plan` picks the lightest path. A general question gets a direct answer ("Here's the answer."). A standalone note or tab folder is created directly ("I'll handle that directly."). Lima commands run from Search. Everything else becomes a task, sent to an existing workspace when one fits ("I'll send this to your existing workspace."). A new workspace is created only when the user asks or no workspace fits, never because a request sounds complex.

## Tasks (Orchestrator)

`task.submit` creates one persistent root task per destination. Its `requestId` makes the submission idempotent, so a reload or a repeated click returns the same task. A task record holds:

- the user's request verbatim, the objective, success criteria, constraints, and a description of the shared context (for example, "3 browser references included")
- the assignment: workspace, conversation, agent name and provider
- dependencies on sibling tasks, and the parent task for helpers
- the state: `accepted`, `planned`, `queued`, `waiting`, `running`, `paused`, `blocked`, `verifying`, `completed`, `completed_with_warnings`, `failed`, `canceled`
- an append-only event history (the last 200 events) and the authoritative outcome

Records are encrypted in the `tasks` collection and broadcast as `task.updated`. The Orchestrator lives in the native runtime, so closing the Companion, reloading a tab or navigating away never loses or duplicates a task.

### Instruction package

Each agent receives one message with:
- the task ID and objective, plus the original request when it differs
- the success criteria and constraints
- results from prerequisite tasks, and routed messages
- for a coordinator, the outcomes of earlier tasks in the same workspace, and an instruction to plan first and delegate only distinct work
- reference text, marked as untrusted data rather than instructions
- the report contract

The report contract is a final fenced `lima-report` block containing `status`, `summary`, `actionsTaken`, `artifacts`, `verification`, `remainingIssues` and `nextSteps`.

### Completion is verified

An agent's "done" is not success. When the turn the task waits on completes, the Orchestrator:

1. Parses the last `lima-report` block. A missing report completes with a warning that the result is unverified.
2. Treats a `verification` claim with no tool run recorded in that turn as a warning, not as evidence.
3. Maps a report status of `blocked` or `failed` to that state.
4. For a coordinator whose helpers are still working, waits. When every helper has settled, it asks the coordinator once to integrate their results, then evaluates the final report. Unfinished or failed helpers become unresolved issues.
5. Writes one outcome: what completed, what changed, what was verified, what is unresolved, and the next steps.

### Dependencies, budget and isolation

- A helper with `depends_on` waits until every prerequisite succeeds, then starts with its prerequisites' summaries and artifacts.
- A failed or stopped prerequisite blocks its dependents. It never cancels unrelated work.
- At most `maxActive` tasks run at once (default 3, `task.concurrency`, 1–8). The rest queue with "Waiting for available capacity".
- A task can have at most 8 active helpers. A repeated objective reuses the existing helper instead of spawning another.
- An implementation helper that starts while another one is changing the same Git project gets its own worktree on branch `lima/<task>`. The coordinator integrates the changes.
- If the requested provider isn't installed, another installed provider runs the helper, and the task history records the switch.

### Failures, stopping and restarts

- **Transient failures** (connection, rate limit, crashed process, unknown) retry at most twice. The retry tells the agent to inspect what already took effect before repeating anything.
- **Failures that need the user** (sign-in, missing CLI, permission, rejected model, version) block the task with the reason. **Anything else** fails it.
- **Stop Task** stops the task and every descendant. Stopping one helper leaves its siblings and unrelated tasks running. Completed artifacts are kept. A canceled agent's late reply never revives its task.
- **Pause** stops the current turn. **Resume and Retry** send a resume instruction to continue from the latest verified point without replaying commands or clicks.
- **After a restart**, a turn that was interrupted is reported as "Agent session interrupted" and waits for Resume. It is never silently replayed.

### Messages between agents

`task_message` sends a typed message (`finding`, `question`, `blocked`, `dependency_ready`, `artifact`, `completed`, `failed`). The Orchestrator delivers it to the sender's dependents and coordinator. `task_inbox` reads delivered messages, and messages also go into a dependent's instruction package when it starts. Every message records its sender and task.

## Agent tools

Workspace agents get `task_delegate`, `task_status`, `task_message` and `task_inbox`, alongside the existing workspace tools. Inside an active task, `agent_spawn` also goes through the Orchestrator. Authorization is unchanged: every tool call passes the runtime's broker, whichever agent or provider makes it.

## Where it appears

All of this stays within the existing layout, with nothing on the right:
- **Companion:** each handoff shows its live state, the latest event, how many agents are working or queued, and the outcome. Its actions are Open Workspace or Review Result, Stop Task, and Retry or Resume. Reopening the Companion restores tasks from the last six hours.
- **Workspace chat:** the Task Progress view, next to Chat, Agents, Activity and Files, shows the latest task, its helpers and their dependencies, the event history, the outcome, and Stop Task, Pause and Resume.
- **Sidebar:** folders carry the task state in their tooltip, and a blocked task shows the attention mark.

## Tests

`native/Tests/LimaRuntimeTests/OrchestratorTests.swift` drives the Orchestrator with deterministic mock agents. It covers:
- idempotent submission and the instruction package
- unverified and unsupported completion claims
- dependency gating, and failed prerequisites
- bounded retries and hierarchical cancellation
- the concurrency budget
- pause and resume, and restart recovery
- routed messages and report parsing

Live provider runs remain manual.

## Not yet built

- Automatic re-planning when a discovery changes the approach. Today the coordinator agent adapts its own plan.
- Usage and memory budgets beyond the concurrency limit.
- Choosing a provider per subtask by capability, beyond the installed-provider fallback.
- Per-task "Allow for This Task" approvals.
- Metrics on completion rate and unnecessary spawns.
