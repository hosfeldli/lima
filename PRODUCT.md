# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(Gecko chrome and `about:lima` pages inside a Zen Browser fork on macOS. Surfaces are HTML/CSS rendered by
Firefox; there is no native UI toolkit for them.)

## Users

One power user: a developer on their own Mac who lives in the browser, terminals and AI coding agents all day.
They switch constantly between reading pages, running commands, writing notes and directing several agents at
once, mostly by keyboard. Speed and density matter more than first-run hand-holding.

## Product Purpose

Lima 5 is the user's primary browser and AI workspace in one application: Zen's sidebar holds every Lima object
(AI workspaces, helper agents, terminals, notes) as tabs and folders, ⌘T is a universal search over the web,
tabs and Lima, and agents work visibly in the same tabs and terminals the user does. Success: the user never
leaves the browser to direct agents, take notes, run shells, dictate or control music, and can always see what
each agent is doing.

## Positioning

Agents operate in real browser tabs and a shared terminal inside the user's own browser, and the sidebar shows
where each one is working with an activity mark on the active tab. Companion hands work to those workspace agents and reports their state.

## Operating Context

- Zen Browser fork (Firefox engine) on macOS, Apple Silicon first. Regular windows use the Lima light theme.
- Agents: Claude Code, Codex and OpenCode CLIs, driven through Lima's MCP tools.
- Daily rituals: ⌘T search, workspace chat, terminal with file tree, notes (OneNote-like Notebook), dictation
  (⌃⌥D), music control from the sidebar, weekly Friday reports.
- Long sessions with many tabs; the sidebar is narrow (~240–360 px) and always visible.

## Capabilities and Constraints

- Every surface is either browser chrome injected into Zen's window (sidebar dock, folder decorations, search
  panel, menus) or an `about:lima?...` page in a normal tab.
- Pages are untrusted content: one bundled classic script, a strict CSP (scripts and styles only from
  `resource://lima-ui`), no remote fonts or network images. Fonts must be system fonts.
- Chrome CSS is a global author sheet and must stay scoped to Lima IDs/attributes.
- Must respect macOS Reduce Motion and Reduce Transparency.
- Surfaces: chat, terminal (Orca-style explorer + shell), note page, canvas note, Notebook index, activity &
  weekly reports, Screenshot Studio, audio, integrations & settings, Quick Ask, command result page, start page,
  ⌘T search panel, sidebar dock (music, dictation, mic), workspace/agent/notebook folders.

## Brand Commitments

- Product name: Lima.
- Lima uses white content surfaces, a light gray sidebar, and graphite actions. The original companion illustration reflects agent events and can be disabled.
- Zen + Orca structure is binding: everything is a tab or folder in Zen's sidebar (no dashboards or card grids);
  the terminal is Orca-style with a file tree beside the shell.
- The Lima 5 app icon depicts the folded-cap companion in a graphite-outlined terminal.

## Evidence on Hand

- Spec: `docs/spec/lima-5.0-v2.md`; architecture: `docs/architecture/sidebar-workspaces.md`.
- No testimonials, customers or marketing claims exist; none should be invented.

## Product Principles

1. The sidebar is the map: if it exists, it is a tab or a folder there.
2. One tab, one job: a page does its task and nothing decorative.
3. Show the agent's work where it happens, not in a separate dashboard.
4. Keyboard first, and fast: frequent actions are instant.
5. Keep work surfaces calm and use motion for agent activity and user actions.
