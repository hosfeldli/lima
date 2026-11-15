# Lima 5.0 specification

The authoritative spec is "Lima 5.0 — Revised Complete Architecture & Development Specification" (v2.0,
superseding v1.0 of 2026-11-13). Save the full text here as `lima-5.0-v2.md`.

Key decisions this repo implements against:
- Zen fork, macOS only (Apple Silicon first), one public 5.0 release gated by internal milestones 1–7.
- Native Swift runtime; browser chrome reaches it only through the versioned bridge (`protocols/ipc`).
- Codex, Claude and OpenCode CLIs only — no direct model API backend.
- One authorization broker for every origin; approvals bind to the exact operation.
- Shared terminals with explicit keyboard leases; one worktree per concurrently writing agent.
- Local, offline-capable encryption (Keychain-protected keys, no online key service).
- Universal Search as the command surface; the sidebar plus a bottom-anchored vertical rail as the workspace.
