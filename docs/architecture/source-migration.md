# Lima source build migration

## Status (2026-11-21): incomplete, no source-built app exists

The owner first asked to finish this migration, then chose the automated repack for releases. Security
updates have to ship as soon as Zen publishes them, without anyone at the Mac. A source build can't ship a
Firefox fix before Zen's release, because it waits on Zen's rebase. It also takes hours per architecture.
The repack now applies Lima's branding as well (`docs/architecture/build.md`). This section records where
the source build actually stopped, so it can be resumed.

**What ran (arm64, `browser/work/zen-300f9292ddba-arm64`, Zen `300f9292ddba`, Firefox 160.0.1):**
- Preparation completed: verified source archive, Surfer import with the Lima identity edits, Gecko
  toolchain bootstrap, and Zen's en-US strings copied in. `mach configure` passed with the Lima identity:
  app name `lima`, bundle ID `dev.lima.browser`, vendor and profile `Lima` / `Lima Browser`, remoting `lima`.
- The compile ran about 74 minutes with three jobs. It reached `toolkit/xre` and `uriloader`, then stopped
  when the disk filled up (1.6 GB free; the object directory was 10 GB). This was not a compiler error.
- No `mach package` ran and no `build/source/Lima.app` exists. The owner asked for the work directory to be
  deleted to free 16 GB, so a resume starts over from `make source-prepare`.

**Never exercised, because no app was built:**
- `prepare_source.py engine` against a finished tree, `build-source.sh package`, `verify_source_bundle.py`,
  and the source-mode paths in `repack.sh` (no launcher, `MacOS/lima` as the engine).
- `CodeTrust` and `lima_codesign.py` with a compiled `MacOS/lima`. Unit tests cover the layout rule only.
- `source_smoke.py` on a compiled bundle, including `check_bundle`'s scan for Zen names.

**Open parity gates (none passed):**
- **Architectures:** arm64 never finished. x86_64 (Intel) was never attempted. Hosted Intel runners and
  the 6-hour job limit make it impractical in CI.
- **Locales:** only en-US is wired in. Other locales need Zen's `download-language-packs.sh` step.
- **Rollback into the existing profile:** the compiled app reports Gecko's version (160.0.1) where the
  repack reports 5.0.1. Opening a source-built profile with the repack again triggers Gecko's downgrade
  warning. Profile and keychain continuity with a real 5.0.1 profile is untested.
- **Signed update from 5.0.1**, DRM/Widevine and codecs, macOS permissions, and performance: as in the
  acceptance table below.

**To resume:** free at least 35 GB, or set `LIMA_SOURCE_WORK` to a larger volume. Then run
`LIMA_SOURCE_JOBS=3 make browser-source`, and work through the handoff and acceptance gates below.

## Goal

Build Lima against its pinned Zen fork and the matching Firefox source, with
Lima branding and startup integrated into Gecko. Preserve the current browser
profile, every verified Lima capability, and the signed update chain. Switch the
public stable channel only after both macOS architectures and an upgrade from
the current signed release pass the parity gates below.

## Build design

- `browser/lima.lock.json` pins the Zen Git commit, Firefox version and source
  archive SHA-512. `bump-zen.sh` updates those together with the signed upstream
  DMG metadata. The DMG remains available for the current stable build and as a
  comparison baseline.
- `make source-prepare` clones the pinned Zen checkout into `browser/work/`,
  verifies the Mozilla source archive, applies Zen’s pinned Surfer patches, and
  generates Lima’s branding and BrowserGlue integration. Zen’s en-US strings are copied
  into the engine with `scripts/copy_language_pack.py en-US`. These steps leave
  the real profile and the Zen submodule untouched.
- `make browser-source` bootstraps compiler toolchains, performs a full Gecko
  build, and packages the result as `build/source/Lima.app`. The source build
  uses the existing Lima bundle assembler for the native runtime, browser
  overlays, installer assets, and hardened code signing. Its engine comes
  from the compiled bundle.
- Compiled BrowserGlue initializes Lima. Compiled packages omit the AutoConfig
  bootstrap and suppress Zen’s welcome and update prompts. The packaging gate
  checks the compiled bootstrap and refuses a source manifest that disagrees
  with the lock or the requested hardening mode.
- The compiled engine carries the Lima identity itself, so source bundles drop
  the repack's `-app` launcher. `prepare_source.py zen` rewrites Zen's inputs
  before import, and every anchor must match or preparation fails:

  | Identity | Compiled value |
  | --- | --- |
  | Executable (`MOZ_APP_NAME`, `CFBundleExecutable`) | `Contents/MacOS/lima`; no `MacOS/zen` |
  | Bundle ID (`<distribution-id>.<appId>`) | `dev.lima.browser` |
  | Name, vendor, display name, helpers | `Lima`, `Lima GPU Helper`, … |
  | Profile, remoting name | `Lima Browser`, `lima` |
  | Gecko application ID | Firefox's, unchanged, for add-on compatibility |
  | Source repo, `about:credits`, About links | `hosfeldli/lima` |
  | Update host | `lima.liamhosfeld.com` (the Gecko updater stays disabled) |
  | Icons, About logo and wordmark | Rendered from `browser/branding/lima-app-icon.svg` |
  | Fluent strings | `Zen` → `Lima` in every message value, all locales |
  | Donate links, Zen share server, mods allowlist | Removed or emptied |

  Internal names such as `zen.*` prefs, `Zen*` modules and `zen-*` CSS stay.
  Profiles and Zen's patches depend on them, and they are not user-visible.
- `CodeTrust` trusts `Contents/MacOS/lima` as the engine when the bundle has
  no `MacOS/zen`. `lima_codesign.py` gives the engine entitlements to whichever
  binary came from the compiled bundle.
- The compiled `Services.appinfo.version` is Gecko's (`160.0.1`) rather than
  the repack's `5.0.1`. Opening a source-built profile with the repack again
  therefore triggers Gecko's downgrade warning. Test rollback with a profile
  copy.
- Only en-US is packaged. Zen's other locales need its l10n download step
  (`scripts/download-language-packs.sh`), which is not wired in yet.
- The manual GitHub Actions source workflow builds one architecture per run
  and uploads an ad-hoc candidate after native and browser smoke tests. The
  current release workflow stays on the verified repack. No cloud workflow
  was dispatched for the local migration work.

## Local handoff

1. Check `df -h .`, `git submodule status`, and the Zen Rust version in
   `browser/zen-upstream/rust-toolchain.toml`. Mozilla and Zen both document a
   30 GB starting disk budget. Use current Xcode Command Line Tools, GNU tar,
   Node 22+, rustup and Python 3.11+.
2. Run `make browser-source`. The default is two compiler jobs for this 8 GB
   Apple Silicon Mac. Set `LIMA_SOURCE_JOBS` only after checking memory pressure.
   `LIMA_SOURCE_WORK` can point to a larger APFS volume.
3. For a partially finished import, rerun `make source-prepare`. For a
   finished compile, `LIMA_BUILD_DIR="$PWD/build/source" browser/scripts/build-source.sh package`
   reruns packaging. Keep generated files under the source work directory.
4. Run `make lint`, `make test`, and
   `python3 browser/scripts/source_smoke.py build/source/Lima.app`. Use an
   isolated profile for preview and upgrade rehearsal.
5. For current local diagnostics, read `/tmp/lima-source-build.log`. The
   source archive is in `browser/.cache/`. Never commit build logs, profiles,
   signing keys, or generated Firefox source.

The initial cleanup removed 22 obsolete Lima app bundles, 14 isolated QA
directories, and reproducible npm and SwiftPM caches. It preserved the running
preview, existing profile directories, and a signed 5.0.1 comparison app.
Available space reached 30 GiB before source extraction. GNU tar was installed
with Homebrew. The source archive was fetched from Mozilla and its SHA-512
matched Mozilla’s checksum manifest.

## Acceptance gates

| Area | Required evidence |
| --- | --- |
| Provenance and packaging | A complete compiled engine on arm64 and x86_64. Record the Zen commit and source checksum, check bundle identity, code signatures and helper entitlements. |
| Browser profile | Start the candidate over a copy of a real-shaped 5.0.1 profile with tabs, pinned folders, bookmarks, cookies, site/container preferences, history and restart state. Reopen the same profile after update and exercise rollback. |
| Startup and branding | Fresh and restored macOS windows show Lima in the menu, About panel, icons, and onboarding. Keep user folders visible. No Zen welcome or update prompt. |
| Browser functions | Tabs, splits, Essentials, downloads, extensions, passwords/passkeys, permissions, media playback and distribution locales. Verify codec and Widevine availability explicitly. |
| Workspace and Notes | Create, move and archive workspaces. Verify Companion, streaming, approvals, Notes, terminal/PTY, Git changes, browser actions and helper isolation. |
| macOS integrations | Compare microphone and dictation, Spotify/audio, Accessibility, Screen Recording, Gmail/Calendar, location and signing/TCC behavior. Use test accounts or approved fixtures. |
| Stable updater | Install against a disposable profile from the existing signed stable build with current feed identity. Check actual restart, rollback, version ordering and backup preservation. |
| Performance | Compare cold startup, memory, scrolling and basic browsing against the repack. The candidate uses optimized Gecko without upstream PGO/LTO. Measure the effect before stable cutover. |

The browser smoke test covers core startup and native Notes through a fresh
profile. It does not substitute for signed update, account integration, DRM,
or architecture parity. Keep the stable channel on the existing verified build
until the remaining gates are exercised.
