# Building Lima Browser

## Local development: repack (`make browser`)
Downloads the Zen release pinned in `browser/lima.lock.json`, verifies its SHA-256, and produces
`build/Lima.app` with:
- `Contents/MacOS/lima` — launcher that execs Zen's engine with `-app Resources/browser/application.ini`
  (Gecko compiles app identity into the binary, so this is how Lima gets its own name, remoting
  identity and profile: `~/Library/Application Support/Lima Browser`, separate from Zen and from
  Lima 4.x's `~/Library/Application Support/Lima`).
- `Resources/lima.cfg` + `defaults/pref/lima-autoconfig.js` — autoconfig bootstrap mapping
  `resource://lima/` and loading `LimaStartup.sys.mjs`.
- `Resources/lima/` — Lima chrome (rail, panel, bridge).
- `Contents/MacOS/lima-host` — native runtime, spawned by the bridge.
- `distribution/policies.json` — disables Zen's updater so it can't overwrite Lima.
Signed ad-hoc unless `LIMA_SIGN_IDENTITY` is set.

Why not Firefox artifact builds: Zen 1.24.2b carries 79 patches to compiled code (widget/cocoa, layout,
dom). Artifact builds download stock Mozilla binaries, so those patches would be missing.

## Known repack limitations
- Fluent strings (`brand.ftl`) live in Zen's optimized `omni.ja`, so the macOS menu-bar app name,
  window titles and About dialog still say "Zen". Fixed by the source build's branding.
- Autoconfig is a dev-only loading mechanism; source builds register Lima chrome via `jar.mn`.

## Release: source build (next step)
Zen cross-compiles macOS on Linux runners (`configs/macos/mozconfig`, `ZEN_CROSS_COMPILING`) and uses
Command Line Tools SDKs, so full Xcode is not strictly required. Lima's source pipeline will:
copy `browser/zen-upstream` → `browser/work`, rewrite `surfer.json` branding (name, appId, binaryName),
add Lima branding assets, register `browser/overlay/lima` as a chrome package, then
`surfer download && surfer import && surfer build`. Plan for ≥50 GB disk; use CI, not this Mac.

## Bumping Zen
Update the submodule to the new tag, then `zen.tag`, `zen.commit`, `firefoxVersion` and the DMG
`sha256` in `browser/lima.lock.json` together. Re-run `make browser` and `make run`.
