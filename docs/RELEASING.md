# Releasing Lima

Lima 5 is signed with the self-signed identity Lima 4 used (`RayPlacement Local Code Signing`, SHA-256
`3dfe6a7f…2f12`, pinned in `browser/release.json`). It is not notarized, so the **first** install from the
DMG needs Control-click → Open. Updates after that are installed by Lima itself and verified against the
installed app's signature.

## How a release flows

```
release.sh prepare --bump patch --push      VERSION, lima-host Info.plist, limaRuntimeVersion
release.sh tag --push                       annotated vX.Y.Z on origin/main (immutable)
gh workflow run release.yml -f tag=vX.Y.Z -f publish=true -f critical=false
  └─ build   (environment: release, approval)
       preflight → tests → signed repack → zip + DMG → signed feed → verify
       → private archive (GCS) → public versioned downloads (GCS) → GitHub draft
  └─ publish (environment: release-publish, second approval, no signing keys)
       verify staged feed + public download → upload latest.json(.sig) → GitHub release
```

The phases also run locally, one at a time: `release.sh preflight|build|verify|stage|publish --tag vX.Y.Z`.

Each phase protects something specific:
- **preflight**: refuses a dirty tree, a tag that isn't annotated, doesn't match `VERSION` or isn't on
  `origin/main`, a signing keychain without the pinned certificate, and a build number not above the
  live feed's.
- **build**: verifies the app *as extracted from the update zip*, which is what users actually receive.
- **stage**: uploads immutable objects (`--if-generation-match=0`). A rerun accepts identical bytes and
  refuses different ones. The public feed doesn't change.
- **publish**: requires `--yes`. It downloads the staged feed, verifies its signature and the public zip's
  digest, then swaps `latest.json` last, then re-reads and verifies the live feed.
- There is no un-publish. Clients never install a lower build, so a bad release is fixed by releasing a
  higher one.

Security releases (a Zen bump that changes Firefox): pass `critical=true`. Lima then shows a high-priority
"includes security fixes" bar.

## Automatic security releases

Zen ships Firefox's security fixes, so `zen-bump.yml` releases a new Zen tag without waiting for a person.
Every three hours a Linux job compares Zen's latest release with the pin. When they differ, a macOS job:

1. Runs `bump-zen.sh`, which verifies Zen's Developer ID team, notarization and DMG digest.
2. Runs the native tests, repacks Lima (including the Lima rebranding of Zen's `omni.ja`), and runs
   `source_smoke.py` headless against the result.
3. Commits the bump, then runs `release.sh prepare --bump patch --push` and `release.sh tag --push`.
4. Dispatches `release.yml` with `publish=true`. It sets `critical=true` when the Firefox version changed.

Any failure opens or updates a "failed" issue, which notifies you. The scheduled check retries every three
hours. Commits land on `main` as `github-actions[bot]`, so pull before starting local work. Both release
environments must stay free of required reviewers, or the unattended release stops for approval.
Rebranding edits that no longer match Zen's files are reported as warnings in the job summary. They
never block a security update. Only a missing Lima `brand.ftl` fails the build.

## How installs update

1. Lima checks shortly after startup and every six hours. **Settings → Updates** also offers a manual check.
2. `lima-host` fetches `latest.json` and `latest.json.sig` and verifies the Ed25519 signature against the key
   compiled into the app's `Info.plist`. It rejects anything that isn't a strictly newer build, isn't https,
   or isn't on the feed's host.
3. It downloads the zip, checks size and SHA-256 against the signed feed, and extracts it. The new app must
   satisfy the installed app's designated requirement (same identifier, same pinned certificate) with strict
   and nested-code validation.
4. **Restart to update** passes the active Gecko profile directory to `lima-host apply-update`. The helper waits
   for the browser to quit, verifies the replacement, and exchanges the app bundles on the same volume. It
   verifies the installed app before reopening the original profile. A failed verification restores the old
   bundle. The previous app is stored under `~/Library/Application Support/Lima Browser/Updates/previous`.
   The log is `~/Library/Logs/Lima/update.log`.

## Infrastructure (configured 2026-11-21)

| Piece | Where |
|---|---|
| Download page | https://lima.liamhosfeld.com: Cloud Run service `stem-portfolio-host` in `stem-471602`/`us-east1`, from `site/` (`site/deploy.sh`). `/download` redirects to `stable/Lima.dmg` |
| DNS (Wix) | `lima` A `216.239.32.21`, `.34.21`, `.36.21`, `.38.21`. Optional AAAA `2001:4860:4802:32::15`, `:34::15`, `:36::15`, `:38::15`. These are fixed Cloud Run domain-mapping addresses, so no load balancer is involved |
| Update feed and downloads | `gs://lima-updates-940267100054` (public read, CORS for the site): `stable/latest.json(.sig)`, `stable/Lima.dmg`, `stable/X.Y.Z/` |
| Private archive | `gs://lima-release-archive-940267100054/releases/vX.Y.Z/` |
| CI identity | Pool `github`, provider `lima`. It only accepts `hosfeldli/lima` workflows dispatched from `main` in environment `release` or `release-publish` |
| `lima-release` SA | Usable only from the `release` environment. Reads `lima-signing-p12`, `lima-signing-p12-password`, `lima-update-ed25519-key`; creates (never overwrites) objects in both buckets |
| `lima-publish` SA | Usable only from `release-publish`. `objectUser` on the updates bucket; no secrets |
| Update key | Public key pinned in `browser/release.json`. Private key in Secret Manager and at `~/Library/Application Support/RayPlacement/Signing/lima-update-ed25519-key`; back it up offline |

The repo is private on GitHub Free, so **environments can't require reviewers and tag rulesets aren't
available**. Anyone with write access can dispatch a release. The compensating controls:
- GCP only issues credentials to `main`-dispatched jobs in the two environments.
- Preflight refuses tags that aren't annotated, don't match `VERSION` or aren't on `origin/main`.
- Publish needs the explicit `publish` input.

On GitHub Pro (or a public repo), add yourself as a required reviewer on both environments and a ruleset
blocking updates and deletions of `v*` tags.

Settings → Actions: allow GitHub Actions to create pull requests, so `zen-bump.yml` can open PRs.

## Rehearsing locally

`make release-rehearsal` builds a signed release of the working tree with your local Lima 4 keychain and a
**throwaway** feed key. It skips the git gates and uploads nothing. It then runs the updater integration
tests against real signed builds:
- a release accepts its own update;
- an ad-hoc build is rejected;
- the installer refuses a tampered bundle and swaps in a good one with a rollback copy.

Its output (`dist/vX.Y.Z`) is not for distribution: the feed key is not the pinned one.

## Workflow hardening

- Every action is pinned to a commit SHA, and checkouts use `persist-credentials: false`.
- Top-level `permissions: {}`, with only what each job needs.
- Inputs pass through `env`, never interpolated into scripts. There is no `pull_request_target`.
- Signing material exists only on the runner, comes from Secret Manager through OIDC, and is deleted before
  any upload step.
