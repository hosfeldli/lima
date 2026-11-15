# How Lima integrates with Zen

Every Lima surface is a page at `about:lima?…` that opens in an ordinary Zen tab, so tabs, workspaces,
Essentials/pinning, split view, Glance, session restore, history and bookmarks apply to it unchanged.

| URL | Surface |
|---|---|
| `about:lima?note=<id>` | A note (classic editor or canvas, by the note's kind) |
| `about:lima?view=notes` | Notes index, organized by bookmark folders, plus trash |
| `about:lima?terminal=<id>` / `?view=terminal` | A terminal session (new sessions get a permanent `?terminal=` URL) |
| `about:lima?chat=<id>` / `?chat=new&prompt=` | An AI conversation |
| `about:lima?ask=<prompt>` | Quick Ask (no tools, no page access) |
| `about:lima?tool=<id>&input=` | A built-in command's result |
| `about:lima?view=context|studio|audio|integrations` | Other surfaces |
| `about:lima?workspace=<id>` | Redirects to the workspace's Chat (pre-sidebar links) |

## Notes are bookmarks
`LimaNotesBookmarks.sys.mjs` keeps every note as a bookmark to `about:lima?note=<id>`. The bookmark tree is
the organization: folders are note folders, the bookmark title is the note title (both directions), moving
the bookmark moves the note. Deleting a note's last bookmark moves the note to Lima's trash (content kept,
restorable from the Notes index); permanent deletion is explicit. New notes go to a "Notes" folder in the
Bookmarks Menu. Titles live in the Firefox profile (`places.sqlite`); note content stays encrypted by Lima.

## Search
`LimaUrlbar.sys.mjs` registers a provider in Zen's address bar. Notes, chats, reports, terminal history and
Lima commands appear alongside history/bookmarks; questions offer Quick Ask. Nothing is sent to a model
unless that row is chosen.

## Security model
- `about:lima` is untrusted content (not chrome), loads only in the **privileged-about** content process
  (never alongside websites) and is not linkable from websites.
- The only bridge is the `Lima` JSWindowActor: `LimaChild` installs `window.lima` solely in `about:lima`
  documents; `LimaParent` allows only the runtime namespaces the UI needs (never host lifecycle).
- Pages can't navigate between `about:lima` URLs themselves; `lima.replaceURL()` asks the parent to load
  an `about:lima` URL in the same tab.
- UI sources are ES modules bundled into one classic script at build time (`scripts/bundle_ui.py`),
  because module scripts cannot load cross-origin into an `about:` document.

## Sidebar (no rail, no dashboards)
See `sidebar-workspaces.md`. Workspaces, helper agents and the Notebook are Zen folders; creation is in
Zen's bottom ＋ and the sidebar's right-click menus; ⌘T opens Lima Search; the dock above Zen's footer holds
the now-playing pill, the dictation pill and the mic. `about:lima` with no parameters only points at these.

## Testing
`LIMA_DEV_OPEN_URL=about:lima?… build/Lima.app/Contents/MacOS/lima -profile <dir> -no-remote` opens a Lima
URL once the window settles (Zen's first-run flow replaces command-line tabs on new profiles).
`LIMA_DATA_DIR` and `LIMA_KEY_FILE` isolate the runtime's data and key from your real ones.
