# Porting Orca's design to Swift

Orca (stablyai/orca, MIT, © 2026 Lovecast Inc.) is an Electron/TypeScript agent orchestrator. Lima
ports its *design* into the native runtime; no Orca code or Node runtime ships in Lima.

| Orca (src/main) | Idea | Lima home | Status |
|---|---|---|---|
| `daemon/` terminal daemon, `createOrAttach` by sessionId, history replay | PTYs live in a process that outlives the UI; UI attaches/detaches | `native/terminal-service` (spec rule 5) | planned, M3 |
| `daemon/shell-readiness` OSC 777 marker via zsh wrapper | Shell reports prompt/command boundaries itself | `LimaTerminal/ShellIntegration.swift` | **implemented** |
| `daemon/protocol/daemon-pty-owner-query-protocol` | Single input owner per PTY | `LimaTerminal/InputLease.swift` (generation-fenced leases) | **implemented** |
| `daemon/AGENTS.md` endpoint ownership (link → probe → rename) | Never delete a live peer's socket; "can't tell" ≠ dead | launchd agent socket in M2 | design adopted |
| `claude/cli-capabilities`, `codex-cli`, `opencode` | Probe installed CLI version/flags, don't assume | `LimaAgentSupervisor/CLIDiscovery.swift` | discovery implemented; feature probes M3 |
| `claude/claude-stream-json-connection`, `codex/app-server`, `opencode/acp` | Structured transports per provider | adapters in `LimaAgentSupervisor` | planned, M3 |
| `git/worktrees` | One worktree per concurrently-writing agent | `ProjectService` | planned, M3 |
| `agent-launch`, coordinator/worker | Coordinator spawns workers, reviews before merge | `AgentSupervisor` orchestration | planned, M3 |
