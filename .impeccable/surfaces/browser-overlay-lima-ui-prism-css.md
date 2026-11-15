---
version: 1
slug: "browser-overlay-lima-ui-prism-css"
primary_target: "browser/overlay/lima/ui/prism.css"
related_targets: ["browser/overlay/lima/lima.css","browser/overlay/lima/ui"]
---

# Lima surfaces (chrome + about:lima pages)

Scope: every Lima surface — sidebar decorations and dock, ⌘T search panel, Zen menus, and the about:lima pages
(chat, terminal, note, canvas, notebook index, activity/reports, studio, audio, settings, quick ask, run, start).
Mode: Operate. One power user, keyboard-first, all day, light and dark following macOS.

## Direction contract

THESIS: A dense working instrument, not a calm chat app: every Lima page packs its job into hairline-ruled
modules headed by small utility-red tabs, the way Japanese portals out-pack a Western grid. It refuses the
category default of grey airy chat columns with one blue accent and rounded floating cards.

OWN-WORLD: White paper ground (#FFFFFF) with #F2F2F2 panel fill, #111111 ink, #7A7A7A secondary, #E0E0E0 hairlines,
utility red #E60012 for primary actions, module tabs, current selection and errors-as-state; dark mode inverts to
#141414 ground, #1E1E1E panels, #F2F2F2 ink, #2E2E2E hairlines, same red. System sans (SF Pro / Hiragino) at
12–13px body, tight leading, tabular figures; badges filled-red / outlined-red / grey / black; 2px radii, no
shadows except overlays. The prism stays the only multicolour, and only for agent activity.

STORY: The user sees where each agent is and what it did at a glance, reads dense results without scrolling,
and acts with one red button or a key.

FIRST VIEWPORT: Workspace chat: a 36px header strip (workspace name, agent state badge, provider/model), then a
two-column module grid: left 2fr "Chat" module (red tab) holding the conversation, right 1fr column stacked
"Steps" (timestamped tool rows, current row red-marked), "Agents" (helper rows with state badges) and "Files";
composer docked at the bottom of the Chat module with a red Send button.

FORM: Japanese contemporary high-density site (challenger, user-chosen over the assigned Fahrplan);
seed:6e63ceb515fb2bc9. Signature move: the small red module tab heading every work area, which doubles as the
module's live state (tab text turns to "Chat · writing" with the binding prism dot). Motion grammar: instant
state swaps, 120–160ms opacity/transform on user-triggered reveals only; agent prism is the one continuous motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
