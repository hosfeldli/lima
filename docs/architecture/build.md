# Building Lima Browser

The source-build migration is active. See [the migration and parity
checklist](source-migration.md) for the source build commands and the stable
cutover gates. This document describes the current stable packaging path.

Lima.app is a **repack** of Zen's official, notarized macOS release, not a Gecko source build. Development and
release builds run the same script (`browser/scripts/repack.sh`); a release only adds the pinned signing
identity, the update feed and locked-down debugging prefs. Releasing is described in `docs/RELEASING.md`.

## Why stable currently uses the repack

- **Same trust anchor.** Compiling Zen's source or installing Zen's binary both trust Zen's maintainers. The
  binary is built by Zen's CI and signed by Zen's Developer ID (team `9V5K9TP787`), and the repack checks that.
- **Patch latency is the security property that matters.** Firefox ships security fixes every ~4 weeks plus
  emergency releases. A Zen bump is a lock-file change and a ~15-minute CI run (`zen-bump.yml`). A source
  build is hours per architecture, needs ≥50 GB, and sits near the 6-hour limit of hosted GitHub runners.
- **Zen's 79 compiled-code patches stay intact.** Firefox artifact builds would download stock Mozilla
  binaries without them.

Lima is moving to a full source build for direct control over branding and startup.
The repack remains the stable comparison and rollback path during migration.

## What `make browser` does

1. **Pins and provenance.** Downloads the DMG pinned in `browser/lima.lock.json` and checks its SHA-256.
   Then it checks that `Zen.app` satisfies `anchor apple generic and certificate leaf[subject.OU] = "9V5K9TP787"`
   and that `spctl` reports *Notarized Developer ID*. A release build fails if notarization can't be
   confirmed; a dev build only warns, for offline work.
2. **Vendored files.** Every third-party file Lima copies in (`whisper-cli`, xterm) must match
   `browser/vendor-assets.json`.
3. **Entitlement capture.** Records the entitlements of all 25 Zen binaries (`lima_codesign.py capture`),
   so a Zen bump carries Zen's own entitlement changes forward.
4. **Rebranding.** `rebrand_omni.py` replaces Zen's strings, logos and links inside `omni.ja`.
5. **Overlay.** Lima identity in `application.ini` and `Info.plist` (`VERSION` → `CFBundleShortVersionString`,
   `CFBundleVersion` = `MMMmmmppp`), autoconfig bootstrap (`lima.cfg`), chrome modules, UI bundle, icons,
   `lima-host`, launcher, `whisper-cli`, and usage strings for the permissions the runtime asks for.
6. **Removal.** Zen's `updater.app` and `Library/LaunchServices` helpers (updater, DMG install helper) don't
   ship. Zen's updater is also disabled by policy.
7. **Signing.** Inside-out, never `--deep`, hardened runtime on every binary (`lima_codesign.py sign`):
   - Zen binaries keep Zen's entitlements, minus the ones only Zen's provisioning profile can grant
     (`application-identifier`, `com.apple.developer.*`).
   - Every executable gets `disable-library-validation`. Self-signed code has no Team ID, so library
     validation could never match XUL. The libraries are sealed by the app signature instead, and the runtime
     still blocks `DYLD_*` injection.
   - `zen` also gets Apple Events and calendars, because it is the responsible process for permission prompts.
   - `lima-host`: microphone, Apple Events, calendars. The launcher and `whisper-cli` get none.
   - Never: `get-task-allow`, `allow-dyld-environment-variables`, `disable-executable-page-protection`.
8. **Verification.** `lima_codesign.py verify` re-derives the policy and fails unless every binary has the
   hardened runtime and exactly its policy entitlements. Release builds also need the pinned certificate.

Dev builds are ad-hoc signed. macOS treats each rebuild as a new app, so it may ask for permissions again.
A release build (`make release-rehearsal` locally) uses the stable identity.

## Release-only hardening

- `lima.cfg` locks `devtools.chrome.enabled` and `devtools.debugger.remote-enabled` off and sets
  `lima.release.hardened`. With that pref set, the bridge refuses to start `lima-host` while Marionette or
  the remote agent is running. Those tools can run chrome-privileged script for whoever launched them.
- `Info.plist` carries `LimaUpdateFeedURL` and `LimaUpdatePublicKey`, which turn on the updater.

## Runtime trust boundaries (enforced by `lima-host`)

- Only a signature-verified chain gets the `browser` origin: the engine (`zen`) spawns
  `lima-host --stdio`, which spawns the daemon. See `protocols/ipc/bridge-v1.md` → *Origins and trust*.
  An agent shell can't claim the user's origin by running lima-host itself.
- `whisper-cli` runs only from the app bundle and only when it is signed like `lima-host`.
- The launchd background agent always points at the running `lima-host`, never a caller-supplied path.

## Known repack limitations

- `rebrand_omni.py` rewrites both `omni.ja` archives during the repack. It sets Lima's `brand.ftl` and
  `brand.properties`, changes `Zen` to `Lima` in every locale's strings, replaces the logos and About
  links, and clears Zen's welcome, release-notes, share-server and page-injection URLs. Entries stay
  stored, as in Zen's jars. A compiled identity is still Zen's: the engine binary `MacOS/zen` behind
  the launcher, helper names such as "Zen GPU Helper", and `AppConstants`. Only the source build (see
  [source-migration.md](source-migration.md)) changes those.
- Autoconfig (`general.config.sandbox_enabled=false`) loads Lima's chrome. That is safe only because
  `lima.cfg` sits inside the sealed bundle. A source build would register the chrome through `jar.mn`.

## Bumping Zen

`browser/scripts/bump-zen.sh [TAG]` updates `tag`, `commit`, `firefoxVersion` and the DMG `sha256` in
`browser/lima.lock.json` together. It also moves the submodule, after verifying the new DMG's team and
notarization. `zen-bump.yml` runs this daily and opens a PR that has already passed tests and a verified
repack. Then run `make run` and release.
