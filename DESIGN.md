---
name: Lima
description: A dense working instrument for one keyboard-first power user; hairline-ruled modules headed by small utility-red tabs, with the prism reserved for agent activity.
colors:
  paper: "#ffffff"
  panel: "#f2f2f2"
  panel-2: "#e9e9e9"
  ink: "#111111"
  ink-2: "#4a4a4a"
  ink-3: "#6e6e6e"
  line: "#e0e0e0"
  line-2: "#c9c9c9"
  red: "#e60012"
  red-ink: "#c4000f"
  red-wash: "#fdeced"
  on-red: "#ffffff"
  ok: "#157a3c"
  warn: "#9a6200"
  paper-dark: "#141414"
  panel-dark: "#1c1c1c"
  panel-2-dark: "#252525"
  ink-dark: "#f2f2f2"
  ink-2-dark: "#c8c8c8"
  ink-3-dark: "#9a9a9a"
  line-dark: "#2e2e2e"
  line-2-dark: "#404040"
  red-dark: "#ff2a3a"
  red-ink-dark: "#ff5a66"
  red-wash-dark: "#3a1418"
  select-dark: "#2c1417"
  ok-dark: "#4cc27a"
  warn-dark: "#e3a83c"
  prism-rose: "#ff6b8b"
  prism-amber: "#ffb86b"
  prism-mint: "#7cf2c8"
  prism-sky: "#6bb6ff"
  prism-violet: "#b98bff"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hiragino Sans, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hiragino Sans, sans-serif"
    fontSize: "18.5px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hiragino Sans, sans-serif"
    fontSize: "15.5px"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hiragino Sans, Helvetica Neue, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body-reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hiragino Sans, Helvetica Neue, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.65
  body-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hiragino Sans, Helvetica Neue, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hiragino Sans, Helvetica Neue, sans-serif"
    fontSize: "11px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "0.01em"
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  r: "2px"
  r-2: "4px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
components:
  button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.r}"
    padding: "0 10px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.panel}"
  button-primary:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.r}"
    padding: "0 10px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.red-ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.r}"
    height: "28px"
  button-stop:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.r}"
    height: "28px"
  input:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.r}"
    padding: "5px 8px"
  module-tab:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-red}"
    typography: "{typography.label}"
    padding: "0 8px"
    height: "22px"
  module-tab-count:
    backgroundColor: "{colors.on-red}"
    textColor: "{colors.red-ink}"
    padding: "0 4px"
  badge:
    backgroundColor: "{colors.panel-2}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.r}"
    padding: "0 6px"
    height: "18px"
  badge-filled-red:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.r}"
    height: "18px"
  badge-ink:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.r}"
    height: "18px"
  list-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    padding: "4px 4px"
    height: "30px"
  list-row-selected:
    backgroundColor: "{colors.red-wash}"
  segmented-active:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-red}"
    height: "26px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.r}"
    padding: "8px 10px"
  search-panel:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.r-2}"
    width: "min(680px, 86vw)"
  search-row:
    padding: "0 12px"
    height: "34px"
---

# Design System: Lima

## Overview

**Creative North Star: "The Utility Portal"**

Lima is a working instrument packed the way contemporary Japanese portals pack a page: every work area is a white box ruled in 1px hairlines and headed by a small, solid utility-red tab. Modules butt edge to edge (shared hairlines, negative 1px margins) instead of floating as separate cards, so a single viewport carries the conversation, its timestamped steps, its helper agents and its files at once. Density is the point: 12 to 13px system sans, tight leading, tabular figures, 28px controls, 30px rows.

Color does work, never mood. Red marks the primary action, the module tabs, the current selection and errors-as-state; everything else is ink on paper with grey hairlines. The one multicolour in the system, the prism, belongs to agent activity alone: a moving ring on the tab or terminal an agent is in, a rotating ✦ while it writes, a live dot inside a module tab. Light and dark follow macOS; dark inverts the ground and brightens the red so red text stays legible.

The world rejects the category default it replaced: grey airy chat columns, one blue accent, rounded floating cards, and the earlier glass-and-aurora "Prism" look.

**Key Characteristics:**
- Hairline-ruled modules headed by small red tabs; the tab is the heading, carries counts, and doubles as live state.
- Two radii only (2px everywhere, 4px on the ⌘T overlay); flat at rest, shadows only on overlays.
- System fonts only, one fixed 1.2 ramp (11 / 12 / 13 / 15.5 / 18.5 / 22px), tabular numerals on times and counts.
- Red for action, selection and error; prism for agent activity; nothing else coloured.
- Instant for keyboard, 120 to 160ms ease-out for user-triggered reveals, no decorative loops.

## Colors

Paper, ink and hairline grey carry the page; a single saturated utility red does every job that needs attention, and a five-stop prism is held in reserve for agents.

### Primary
- **Utility Red** (light `red`, dark `red-dark`): fill for primary buttons, Send, module tabs, search group heads, the active segment, the recording mic, focus outlines and the composer caret. White on either red is about 4.6:1 or better. Dark mode deliberately moves to the brighter red so that red *text* (current step, errors, links) reads on the #141414 ground, where the light red is too dim.
- **Red Ink** (`red-ink` / `red-ink-dark`): red used as text: links, error copy, the current step row, exited-state and failure badges, the count inside a module tab, and the hover fill of a red button.
- **Red Wash** (`red-wash` / `red-wash-dark`, selection `select-dark`): the background of the selected list or search row, failure notices and the terminal lease strip.

### Tertiary: the Prism (agent activity only)
- **Prism Rose, Amber, Mint, Sky, Violet** (`prism-rose` through `prism-violet`): one gradient, `linear-gradient(110deg …)` on pages and a conic gradient for rotating marks. It appears only where an agent is acting.

### Neutral
- **Paper** (`paper` / `paper-dark`): page and module ground.
- **Panel** (`panel` / `panel-dark`): hover fill, user message bubble, code blocks, the Studio stage.
- **Panel Deep** (`panel-2` / `panel-2-dark`): grey badge, skeleton bars.
- **Ink** (`ink` / `ink-dark`): body text, the ink badge, the running-state chip, toasts (inverted), the Stop button.
- **Ink Secondary** (`ink-2`): secondary text, icons at rest. **Ink Muted** (`ink-3`): timestamps, metadata, placeholders (about 5.1:1 on paper).
- **Hairline** (`line` / `line-dark`): module borders, row rules, header strip rule. **Hairline Strong** (`line-2` / `line-2-dark`): control borders, kbd keys, canvas blocks.
- **Status Green** (`ok` / `ok-dark`) and **Status Amber** (`warn` / `warn-dark`): outlined ok badges, exit codes, ok notices.

### Named Rules
**The Red Does Work Rule.** Red appears only on a primary action, a module tab, the current selection or an error. If a red element is none of those, it is wrong.

**The Prism Is The Agent Rule.** The prism gradient appears only where an agent is acting: the ring on the tab or terminal it is in, the rotating ✦ while it writes, the live dot in a module tab or owner chip. It never decorates a header, a logo, an empty state or a button.

**The Brighter Red In The Dark Rule.** Dark mode uses the brighter red for every red role, because red text must stay legible on the dark ground; never reuse the light red there.

## Typography

**Display Font:** SF Pro Display via `-apple-system` (with Hiragino Sans, sans-serif)
**Body Font:** SF Pro Text via `-apple-system` (with Hiragino Sans, Helvetica Neue, sans-serif)
**Label/Mono Font:** `ui-monospace` (SF Mono, Menlo) for code, paths, terminal and exit codes

**Character:** Platform system sans at small sizes and firm weights (550 to 700), set tight like a timetable. The CSP forbids remote fonts; the system stack is the identity, not a fallback.

### Hierarchy
- **Display** (700, 22px, 1.25): note page title only.
- **Headline** (700, 18.5px, 1.3): first-level headings inside notes and markdown.
- **Title** (650, 15.5px, 1.3): second-level headings in notes and markdown.
- **Body** (400, 13px, 1.45): the default for every page, chat, rows and inputs; header strip titles use 650 at the same size.
- **Body Reading** (400, 14.5px, 1.65): the note page body, the one long-form reading surface.
- **Body Small** (12px): buttons, rows in Steps and Activity, notices, metadata.
- **Label** (650, 11px, 0.01em, sentence case): module tabs, badges, search group heads (10.5px in chrome), counts.
- **Mono** (12 to 12.5px, 1.5): code blocks, terminal paths, command results.

### Named Rules
**The One Ramp Rule.** Sizes come from the 1.2 ramp (11, 12, 13, 15.5, 18.5, 22px). Hierarchy is weight and the red tab, not bigger type.

**The Tabular Clock Rule.** Times, counts and numeric columns always set `font-variant-numeric: tabular-nums`.

## Layout

Pages are full-height flex columns: a 40px header strip (title, state badge, provider and path in muted text, hairline below), then the work area. The workspace chat is a two-column grid, `minmax(0, 2fr)` Chat module beside a `minmax(260px, 1fr)` column of stacked Steps, Agents and Files modules, with the composer docked at the bottom of Chat. The terminal is Orca-shaped: a 240px Files explorer, the shell, and an optional 46% file preview. Studio is a 180px tray beside the stage. Index pages pack modules with `repeat(auto-fit, minmax(340px, 1fr))` and collapse shared borders with -1px margins.

Spacing runs on a 4px base (4, 8, 12, 16, 24, 32px); page padding is 12px, module inner padding 12px, row heights 22px (tree), 30px (lists, activity), 34px (search). Reading measures are capped: chat messages 760px, user bubbles 560px, the note sheet 780px, settings-style pages 1080px.

At 760px and below the chat side column moves under Chat (max 32vh), the Studio tray becomes a horizontal strip, the explorer narrows to 180px and the note sheet tightens to 16/12px padding.

## Elevation & Depth

Flat. Depth comes from hairlines, panel fill and the red tab, never from shadow. Shadows exist only on things that float above the page.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 6px 20px rgb(0 0 0 / .12)`, dark `.5`): toasts.
- **Overlay Large** (`box-shadow: 0 16px 48px rgb(0 0 0 / .2)`, dark `.6`): reserved for large overlays on pages.
- **Search Panel** (`box-shadow: 0 18px 50px rgb(0 0 0 / .22), 0 2px 6px rgb(0 0 0 / .08)`): the ⌘T panel over a near-clear scrim (`rgb(0 0 0 / .08)`).

### Named Rules
**The Overlays Only Rule.** A shadow means "this floats over the page". Modules, rows, buttons and inputs never cast one; selection uses a 1px red ring (`0 0 0 1px`), not elevation.

## Shapes

Square-shouldered. Every control, badge, toast and key is 2px; the ⌘T panel is 4px; module tabs and modules themselves are square. Borders are 1px hairlines; modules share edges. Dots are the only circles (6 to 8px status and live dots). Icons are 24-unit outline strokes from the shared icon set, drawn at 13 to 15px in `currentColor`; the ✦ star is an SVG mask, never a text glyph.

## Components

### Buttons
Compact and literal.
- **Shape:** 2px corners, 28px tall, 1px Hairline Strong border, 12px label at 550.
- **Primary:** Utility Red fill and border, white text; hover to Red Ink. Send is the primary button in the composer; while running it becomes an ink Stop button.
- **Hover / Active:** hover fills Panel; press scales to .97; transitions 120ms `cubic-bezier(.23,1,.32,1)` on background, border and transform.
- **Ghost:** transparent until hover. **Danger:** Red Ink text on a default button. **Icon-only:** 28px square.
- **Focus:** 2px red outline, 1px offset.

### Chips (badges and state chips)
- **Style:** 18px tall, 11px at 600, 2px corners. Four kinds only: filled red (needs attention), outlined (1px inset ring in current colour: green for ok, Red Ink for failed or exited), grey (idle, neutral), ink (running).
- **Owner chip:** filled red with a prism live dot while an agent holds the terminal.

### Cards / Containers (modules)
- **Corner Style:** square.
- **Background:** Paper, 1px Hairline border, shared edges with neighbours.
- **Shadow Strategy:** none (see Elevation).
- **Internal Padding:** 0 12px 12px, with the red tab flush to the top-left corner.

### Inputs / Fields
- **Style:** 1px Hairline Strong border, 2px corners, Paper fill, 5px 8px padding, 13px.
- **Focus:** border turns red, no glow. The composer box focuses to an ink border; its caret is red.
- **Checkbox / range:** native, `accent-color` red.

### Navigation
- **Segmented control:** 28px, hairline-divided, the pressed segment filled red with white text.
- **Lists:** 30px ruled rows; hover Panel, selected Red Wash.
- **Sidebar (chrome):** Zen's own tabs and folders. Lima adds only the prism ring, the rotating ✦ and the workspace ✦ folder mark.

### Module Tab (signature)
A solid red block, 22px tall, 11px/650 white sentence-case text, flush to the module's top-left corner. It names the work area ("Chat", "Steps", "Files", "Page"), carries a count in an inverted white chip, and becomes the live state while an agent writes ("Chat · writing" preceded by a 7px rotating prism dot). The same block heads ⌘T result groups, the terminal bar, the explorer and the note toolbar.

### ⌘T Search Panel
One dense module: 680px wide, 4px corners, Hairline Strong border, the Search Panel shadow. A 46px field (16px/500 input, red caret, kbd hints), red tab group heads, 34px ruled rows with the selected row in Red Wash and its icon in red, a filled red action chip on the selected row, and a 30px footer of key hints. Loading is a static 2px red bar, not a spinner. It appears instantly.

### Steps
Timestamped rows on a 42px tabular time column; the current step is Red Ink at 600, failed steps strike through in Ink Muted.

### Motion
- Keyboard-opened surfaces (⌘T) appear instantly.
- User-triggered reveals: 120 to 160ms opacity and small translate, `cubic-bezier(.23,1,.32,1)` (toast in, music panel expand, tree twisty).
- Press feedback: scale .97 (.94 on small chrome icon buttons).
- The only continuous motion is the prism: conic rotation at 1.4s while writing, 2.6s for the tab ring, 3.5s for a working folder.
- `prefers-reduced-motion: reduce` removes every animation and transition, prism included.

## Do's and Don'ts

### Do:
- **Do** head every work area with the red module tab, and put its count and live state in that tab.
- **Do** rule modules and rows with 1px hairlines and let neighbouring modules share edges.
- **Do** keep controls at 28px, rows at 30px, and type on the 11 / 12 / 13 / 15.5 / 18.5 / 22px ramp.
- **Do** use the brighter dark-mode red for every red role in dark mode.
- **Do** set times and counts in tabular figures.
- **Do** make keyboard-opened surfaces instant and keep reveals at 120 to 160ms `cubic-bezier(.23,1,.32,1)`.

### Don't:
- **Don't** use the prism for anything but agent activity: no prism headers, logos, buttons, borders or empty states.
- **Don't** colour anything red that is not an action, a module tab, the current selection or an error.
- **Don't** round beyond 2px (4px on the ⌘T overlay) or float modules as separate shadowed cards.
- **Don't** put shadows on anything that does not float over the page.
- **Don't** load remote fonts; the system stack is the type.
- **Don't** add decorative loops, spinners or entrance animations on keyboard-opened surfaces.
- **Don't** return to grey airy chat columns, a single blue accent, glass or aurora backgrounds.
