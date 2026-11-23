# Lima 5.0 specification

The authoritative spec is "Lima 5.0 — Revised Complete Architecture & Development Specification" (v2.0,
superseding v1.0 of 2026-11-13). Full text: [`lima-5.0-v2.md`](lima-5.0-v2.md) — v1.0 first, then the v2.0 revision, which wins where they conflict.

Key decisions this repo implements against:
- Zen fork, macOS only (Apple Silicon first), one public 5.0 release gated by internal milestones 1–7.
- Native Swift runtime; browser chrome reaches it only through the versioned bridge (`protocols/ipc`).
- Codex, Claude and OpenCode CLIs only — no direct model API backend.
- One authorization broker for every origin; approvals bind to the exact operation.
- Shared terminals with explicit keyboard leases; one worktree per concurrently writing agent.
- Local, offline-capable encryption (Keychain-protected keys, no online key service).
- Universal Search as the command surface; the sidebar plus a bottom-anchored vertical rail as the workspace.

The Lima 5.0.1 UX specification (November 2026) refines the interface and wins where it conflicts with
the documents above. Its layout rules are recorded in [`DESIGN.md`](../../DESIGN.md#layout-rules):
- The right edge of the browser carries no Lima panel or persistent control. This retires the right-side
  inspector and the native floating rail (§3.2 of v1.0). Utilities live in the left sidebar's dock.
- Universal Search (⌘T) is the single entry point, including Quick Ask, commands and delegation.
- Commands execute once per invocation, failures are shown where the action started, and agent
  activity appears as compact marks on sidebar rows.

The Universal Search final design specification ([`universal-search.md`](universal-search.md), November 2026)
wins over all of the above for Search: one input, at most eight results in up to three adaptive categories,
deterministic ranking that keeps URL navigation and web search first, AI offered only as a confident
suggestion, and one shared light/dark token contract. Its implementation map lists the code and checks.
