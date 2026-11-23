# Lima Universal Search — Final Design Specification

Adopted 2026-11-23. This document wins over earlier Search descriptions in `lima-5.0-v2.md`, the 5.0.1 UX
specification and `DESIGN.md` where they conflict. Section 14 maps each requirement to the code that
implements it and the check that covers it.

## 1. Purpose

Universal Search is Lima's single entry point for navigating the web, locating information, opening application
surfaces, executing commands, and requesting AI assistance.

It must combine the directness of a browser address bar with the functionality of a command launcher.

The user should never have to decide which search tool, AI mode, or application section to open before entering
a request.

**Primary principle: Type once, select once, get the result.**

## 2. Visual structure

Use one compact, floating surface positioned horizontally in the center of the browser and vertically near the
upper fifth of the window.

Recommended dimensions:

- Width: 560 px, responsive to smaller windows.
- Search field height: 48 px.
- Result row height: 36–42 px.
- Initial visible results: maximum 7–8.
- Corner radius: 14 px.
- Horizontal padding: 14–16 px.
- Footer height: approximately 28 px.
- Maximum expanded height: approximately 65% of the browser viewport.

The surface contains only three regions:

1. **Input:** One search field with the Lima icon, current query, and optional context chip.
2. **Results:** A compact list containing the most relevant actions and matches.
3. **Footer:** Minimal keyboard shortcut hints.

Do not add separate AI tabs, filter bars, category pills, model selectors, agent controls, or a secondary toolbar.

The underlying webpage remains visible and never resizes when Search opens.

## 3. Visual styling

Use Lima's shared design tokens instead of hardcoded Search-specific colors.

The current light theme should use white surfaces, subtle gray dividers, graphite text, and soft selection fills.

A dark theme should reuse the identical layout with appropriately mapped charcoal and neutral tokens.

Use system fonts, regular-weight result labels, smaller muted descriptions, and consistent monochrome icons.

The selected result should have one subtle full-width background highlight.

Avoid colorful icon containers, nested cards, heavy shadows, thick borders, and prominent category headers.

Use a 100–150 ms entrance transition involving slight opacity and vertical movement, with motion disabled under
Reduce Motion.

The companion character should not appear inside the search surface; a small Lima mark is sufficient.

## 4. Search behavior

Search must recognize user intent while remaining predictable.

**Web navigation** — A valid URL should be the first selectable result, with Enter opening it directly.

**Ordinary search** — Normal words and phrases should default to the configured web search engine.

**Local navigation** — Matching tabs, bookmarks, Notes, workspaces, conversations, applications, files, and
commands should appear as native search results.

**AI questions** — An Ask Lima result should appear when the query resembles a question or explicitly references
Lima.

**Agent tasks** — Requests involving research, creation, editing, automation, or multiple operations should offer
delegation without automatically starting an agent.

**Commands** — Recognized commands should appear as executable results, with an input form only if required
parameters are missing.

**Explicit targeting** — Support references such as @page, @tabs, @workspace, @notes, and @files for users who
want to specify context.

Do not introduce separate search modes or a required prefix for ordinary actions.

## 5. Result presentation

Each result should contain:

- One recognizable icon.
- A primary title.
- One optional secondary line explaining its destination or action.
- A trailing action hint on the selected row.

Group results only when grouping materially improves comprehension.

Use at most three visible categories at a time:

- Best Match.
- Your Browser & Lima.
- Web Suggestions.

Hide empty categories and remove unnecessary headings when only one category is present.

Prioritize exact matches, navigation intent, current workspace relevance, and recent user activity.

Deduplicate matching results across open tabs, history, bookmarks, and workspace content.

Show the most relevant eight results initially, with an explicit path to additional matches when needed.

Remote suggestions should arrive after local results without moving the user's current selection.

Never let an AI suggestion unexpectedly replace an ordinary website result.

## 6. Empty search state

Opening ⌘T with no query should show a clean input and a maximum of four relevant recent destinations.

Prefer recent workspaces, recently used tabs, Notes, and unfinished user work.

Do not show a large grid of suggested prompts, generic AI examples, news, weather, or promotional content.

If no useful recent items exist, show only the input and a short hint:

"Search the web, open something, or ask Lima."

## 7. Keyboard interactions

- ⌘T opens Search and focuses the input.
- Repeating ⌘T while Search is open should retain focus in the input.
- Up and Down select results.
- Enter performs the selected action.
- ⌘Enter opens the query in AI Chat.
- Escape closes Search or returns from an expanded answer to results.
- Tab navigates accessible controls without trapping keyboard focus.
- Clicking outside Search dismisses it.
- Opening an ordinary result restores browser focus to the destination.

Existing user-customized browser shortcuts must take precedence where appropriate.

Selection must remain stable when new asynchronous results arrive.

## 8. AI answers inside Search

Simple AI answers should display directly inside the existing floating panel.

Replace the result list with a compact answer containing:

- The question.
- A streaming answer.
- Copy.
- Continue in Chat.
- Close.

Allow the answer region to scroll without growing beyond the panel's maximum height.

Do not turn Search into a complete conversation interface.

Long tasks should hand off to the existing Companion and workspace system rather than execute inside the popup.

Never send page content, selected text, or files to an AI without an explicit, visible context attachment.

## 9. Command execution

Simple commands should execute immediately after selection.

Commands that modify data or require approval should present the existing authorization flow.

Each command invocation must execute only once, regardless of UI updates or result-tab restoration.

Preserve the query and show a short inline success or failure message when appropriate.

Failures should offer Retry and View Details without replacing the search input or losing the user's query.

Do not display raw logs, JSON, or technical stack traces inside normal search results.

## 10. Contextual Search

When Search is opened from a webpage selection, page action, or workspace, show one compact context chip below
the input.

Examples:

- Current page.
- Selected text.
- Three selected tabs.
- Workspace: My Project.

The chip must identify what information will be shared and offer a one-click removal action.

Context attachment should not change ordinary web navigation or command execution.

## 11. Performance

The panel should appear immediately without waiting for the native runtime or AI provider.

Render local matches first and fetch other sources asynchronously.

Target:

- Search opening: p95 under 100 ms.
- Local result update: p95 under 75 ms after lookup begins.
- Keyboard selection: immediate and visually stable.
- No blocking layout changes when remote suggestions arrive.
- No loss of typed input when an individual source fails.

Search must remain useful when the native runtime, network, or AI provider is unavailable.

## 12. Explicit changes to the current implementation

1. Reduce the default visible result count from the current multi-group list to approximately eight
   high-confidence results.
2. Replace the fixed five-group presentation with adaptive grouping that displays only useful categories.
3. Remove unnecessary category headings when results can be understood without them.
4. Establish deterministic result-ranking rules that always preserve URL navigation and ordinary web-search
   behavior.
5. Consolidate duplicate tab, history, and bookmark results into one navigational match.
6. Improve empty-query ranking to prioritize the user's last meaningful browser and workspace destinations.
7. Add progressive access to additional results instead of expanding the initial Search panel into a long list.
8. Replace word-trigger-based AI prioritization with confidence-based suggestions that never silently run an
   agent.
9. Introduce compact intent and context cues without creating additional visible search modes.
10. Apply one shared light/dark theme-token contract to Search, its result rows, inline answers, and command
    statuses.
11. Add comprehensive keyboard, screen-reader, error-recovery, and asynchronous result-ordering tests.
12. Benchmark Search behavior with large browsing histories, many open tabs, and concurrent AI tasks.

## 13. Acceptance criteria

The redesign is successful when:

- A user can open a website using only ⌘T, typing, and Enter.
- A user can search the web without accidentally invoking AI.
- A user can locate a tab, Note, workspace, file, or command with the same interaction.
- A user can request a short AI answer without leaving Search.
- A user can delegate a complex task without adding new permanent interface controls.
- Search never steals focus after dismissal or rearranges a keyboard-selected result.
- The surface retains the same visual language as the rest of Lima.
- The browser remains responsive while AI services are slow or unavailable.

**Final direction: One input, a handful of relevant results, one clear action, and no unnecessary interface
chrome.**

## 14. Implementation map

Code: `browser/overlay/lima/LimaSearchPanel.sys.mjs` (panel, sources, actions),
`browser/overlay/lima/ui/search-ranking.sys.mjs` (ranking and layout, no Gecko dependencies),
`browser/overlay/lima/lima.css` (Universal Search block), `browser/overlay/lima/ui/theme.css` (tokens).
Checks: `node --test browser/tests/search-ranking.test.mjs`, `node browser/tests/search-bench.mjs`, and the
`search` and `searchSpeed` checks in `browser/scripts/source_smoke.py`.

### Ranking rules

| Rule | Implementation |
|---|---|
| Row one is decided synchronously from the query: an explicit URL opens first; otherwise "Search with &lt;engine&gt;" is first | `bestRows()`; `navigationURL()` accepts `http(s)`, `localhost`, IPv4 and dotted hosts with a letter TLD, never other schemes |
| Row icons say where Enter goes: the web-search row and suggestion rows show the search engine's icon; an explicit URL shows that site's favicon; open tabs show their tab icon | `engine.getIconURL(16)`; `pageIcon()` reads the local Places favicon for the page or its origin, so typing an address never contacts the site; a missing or broken image falls back to the monochrome glyph (globe for URLs) |
| At most one AI suggestion joins Best Match, after the ordinary result, at confidence ≥ 0.6 | `aiIntent()` scores question form, trailing `?`, explicit "Lima", task verbs, length and multi-step phrasing; single words, URLs and short phrases score 0 |
| With a context chip, Ask Lima about it follows an explicit URL and precedes web search | `bestRows()`; URL navigation and commands are unchanged by context |
| Local score = text match (exact 100, prefix 80, word prefix 62, substring 45, URL 30) + kind (tab 14, workspace 12, bookmark 9, note/command 8, app 7, chat 6, file 5) + current Zen workspace 8 + recency ≤ 10 + frecency ≤ 8 | `matchScore()`, `scoreItem()`; ties keep arrival order |
| Tabs, bookmarks and history for one page (scheme, `www.`, fragment and trailing slash ignored) become one row; the open tab wins and the subtitle names the other sources | `dedupe()`, `normalizeURL()` |
| Eight rows show; "Show N more results" expands to 40 inside the scrolling list | `ResultSet.layout()`, `INITIAL_LIMIT`, `EXPANDED_LIMIT` |
| Two rows are reserved for web suggestions while they load, so their arrival fills space below local rows | `ResultSet.layout()` (`WEB_RESERVE`) |
| Once the user moves the selection (keys or pointer) the visible rows freeze; later local results go to the overflow and web suggestions only append at the bottom | `ResultSet.freeze()` |
| Headings appear only when more than one category is visible | `layout().headings` |
| Empty query: at most four destinations from workspaces, recently used tabs, notes and chats in the last 30 days; running work first | `recentDestinations()`, `Panel.empty()` |

### Behavior and status

| Spec | Status |
|---|---|
| §2 layout: 560 px, 20 vh from the top, 48 px field, 38 px rows, 14 px radius, 15 px padding, 28 px footer, 65 vh max | Implemented |
| §2 no AI or agent controls in the surface; footer is hints only (↑↓ Select, ↩ Open, ⌘↩ AI Chat, esc Close) | Implemented. The earlier Quick Ask and Companion footer buttons were removed; ⌘⇧↩ still sends the query to the Companion as a draft |
| §3 tokens: Search uses only `--lima-*` tokens. `[lima-theme="dark"]` maps them to charcoal and neutrals; the panel follows the `lima.theme` pref (`light`, `dark`, `system`; default `light`) | Implemented for Search. Lima pages and Zen chrome remain light-only |
| §3 130 ms opacity + 6 px entrance, off under Reduce Motion | Implemented |
| §4 explicit targets `@page`, `@tabs`, `@workspace`, `@notes`, `@files` anywhere in the query; a small scope cue beside the input names the target | Implemented. `@page` attaches the current page's title and URL as a visible chip |
| §5 icon, title, secondary line, trailing `↩ action` on the selected row | Implemented |
| §7 repeating ⌘T keeps the query and focuses the input; Escape returns from an answer, then closes; outside click closes; focus goes to the destination browser | Implemented |
| §7 user-customized shortcuts take precedence | Partly: ⌘T only replaces Zen's New Tab while `lima.search.replaceNewTab` is true. The Keyboard Shortcuts registry is still a target (see `DESIGN.md`) |
| §8 inline streaming answer with Copy, Continue in Chat and Close; region scrolls inside the panel | Implemented |
| §9 commands run once per execution ID; inline "Running command…"; failures keep the query with Retry and View Details; errors are reduced to one sentence without JSON or stack frames | Implemented (`friendlyError()`) |
| §10 one chip below the input naming what is shared, with a one-click remove | Implemented for Current page and Selected text. "Selected tabs" and "Workspace" chips are targets: no entry point opens Search with them yet |
| §11 open and local-update timings | `LimaSearchPanel.metrics(win)` records open and first-local-paint times; the smoke test fails if opening takes 100 ms or more. The benchmark ranks 1,000 tabs + 50,000 history rows per keystroke under 20 concurrent simulated AI streams and fails above a 75 ms p95 |
| §11 useful without runtime, network or AI | Each source has its own deadline (1.5 s, web 2.5 s); Best Match never waits for any source |
| §12.11 tests | Ranking, dedupe, grouping, overflow, async ordering and freeze rules: Node tests. Keyboard selection, `aria-activedescendant`, combobox/listbox roles, URL-first, no AI rows for plain words, ⌘T re-press, Escape and focus return: `source_smoke.py` in the real browser. A polite live region announces result counts once results settle. Error-recovery UI (Retry after a failed command) has no automated check yet |
