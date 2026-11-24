# Releasing Lima

Until 5.0.5, Lima 5 was signed with the self-signed identity Lima 4 used (`RayPlacement Local Code Signing`, SHA-256
`3dfe6a7f…2f12`, pinned in `browser/release.json`). It is not notarized, so the **first** install from the
DMG needs Control-click → Open. Updates after that are installed by Lima itself and verified against the
installed app's signature.

## The installer DMG

`release.sh` builds the DMG with dmgbuild, pinned with hashes in `browser/scripts/release/dmg-requirements.txt` and installed into a throwaway venv, so no Finder scripting is needed on CI. The window is 640×400 and holds Lima and an Applications shortcut over a drawn background: an arrow, "Drag Lima to Applications" and a line about opening it. The background comes from `browser/branding/dmg/` (regenerate with `swift browser/scripts/release/dmg_background.swift browser/branding/dmg`). Layout is in `dmg_settings.py`; the volume is named "Lima" with Lima's icon, and the image is LZFSE.

From 5.0.6, releases are signed with Developer ID (team `575W282638`), notarized and stapled, so the DMG opens without Control-click → Open.

## Moving to Developer ID

Lima's Apple Developer team is `575W282638` (`signing.developerTeam`). Release builds stamp it into
`Info.plist` as `LimaTrustedTeam`. Lima then accepts two signers for the same identifier: its pinned
certificate, or a Developer ID Application certificate Apple issued to that team. Both the updater and the
runtime's peer checks use this rule, so a runtime still running from the old build recognizes the newly
signed browser and lets it replace the runtime. Any other team is refused. The `developerID…` tests in
`UpdateTests` cover this.

The switch takes two releases:
1. **Transition** (self-signed, carries `LimaTrustedTeam`). Installs update to it as usual.
2. **Developer ID.** Set `signing.mode` to `developer-id` and `identity` to the certificate's full name,
   for example `Developer ID Application: Name (575W282638)`. Pin its `certificateSHA256`. The pipeline
   then does the following:
   - signs every binary with a secure timestamp;
   - notarizes the app (`notarytool`, App Store Connect API key) and staples it, then does the same for
     the DMG;
   - verifies with `stapler validate` and `spctl` before staging.

   CI reads `lima-devid-p12`, `lima-devid-p12-password`, `lima-notary-key`, `lima-notary-key-id` and
   `lima-notary-issuer-id` from Secret Manager. Locally, import the `.p12` into the login keychain and set
   `LIMA_NOTARY_PROFILE` or the `LIMA_NOTARY_*` variables.

After the switch, macOS treats Lima as a new signer. Users re-approve Privacy & Security permissions once,
and allow one Keychain prompt for the store key; their data is unchanged. New downloads open without
Control-click → Open.

## How a release flows

```
release.sh prepare --bump patch --push      VERSION, lima-host Info.plist, limaRuntimeVersion
release.sh tag --push                       annotated vX.Y.Z on origin/main (immutable)
gh workflow run release.yml -f tag=vX.Y.Z -f publish=true -f critical=false
  └─ build   (environment: release, no reviewers; skipped with publish_only=true)
       preflight → tests → signed repack → zip + DMG → signed feed → verify
       → private archive (GCS) → public versioned downloads (GCS) → GitHub draft
  └─ publish (environment: release-publish, no reviewers, no signing keys)
       verify staged feed + public download → upload latest.json(.sig)
       → stable/Lima.dmg → un-draft GitHub release → verify live feed
```

`zen-bump.yml` runs this whole path unattended (see *Automatic security releases*). Neither environment
requires approval. The environments separate credentials instead:
- `release` is the only environment that can read the signing certificate and the feed key from
  Secret Manager.
- `release-publish` can write to the updates bucket but holds no keys.

GCP issues either credential only to jobs dispatched from `main`. The checks below gate every release,
attended or not.

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

Any failure opens or updates a "failed" issue, which notifies you. A failure before step 3 pushes nothing,
and the next check retries the whole bump. After step 3 the pin on `main` is current, so the check compares
it with the engine in the live feed. If they differ and no release is running, a `resume` job finishes
that release:
- It bumps the version if only the Zen commit landed.
- It creates the tag if that's missing.
- It dispatches `release.yml` with `publish_only=true` if the draft is already staged, or a full release
  otherwise.

Neither job starts while a release run is queued or in progress. Commits land on `main` as `github-actions[bot]`, so pull before starting local work. Both release
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

## Recovering a failed release

Start by finding out what went live. Don't rerun the workflow blind.

```
curl -s https://storage.googleapis.com/lima-updates-940267100054/stable/latest.json | python3 -m json.tool
gh release view vX.Y.Z --json isDraft,assets --jq '{isDraft, assets: [.assets[].name]}'
```

| What you see | State | What to do |
|---|---|---|
| Feed `build` is the new release | **Live.** Installs already see it, and the feed swap is irreversible. A later step failed: the default DMG, un-drafting the GitHub release, or verifying the live feed | `gh workflow run release.yml -f tag=vX.Y.Z -f publish=true -f publish_only=true`. Publish resumes after the feed swap |
| Feed is older, and the draft has `latest.json` | Staged, not live | Same command. Rebuilding would make new bytes, which staging refuses (objects are immutable) |
| Feed is older, and there's no draft or `latest.json` | Build or staging failed | Fix the cause, then `gh workflow run release.yml -f tag=vX.Y.Z -f publish=true`. A partial stage refuses rebuilt bytes, so if that happens release the next patch version instead |
| Zen bump on `main`, but no `vX.Y.Z` tag | Tagging or dispatch failed | Wait for the next check (the `resume` job handles it), or run `zen-bump.yml` manually |

There is no un-publish. A bad live release is fixed by releasing a higher build. Close the "failed" issue
once the live feed shows the intended build.

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

### Repository settings (public since 2026-11-21)

The repo is public, so standard GitHub-hosted runners, macOS included, cost no Actions minutes. Commits
made from this checkout use the GitHub noreply address (repo-local `user.email`). Commits from before the
switch keep the original address.

- **Don't add required reviewers** to `release` or `release-publish`. Automatic security releases dispatch
  both jobs unattended, so a reviewer rule would hold every update until someone approves it.
- **Allow `github-actions[bot]` to push to `main`.** It commits each Zen bump and version bump directly. A
  branch rule that requires pull requests or blocks that bot stops automatic releases.
- **Tag ruleset (optional, recommended):** block updates and deletions of `v*` tags, but allow creation.
  The bot creates tags; nothing should move one.
- **Fork pull requests** run `ci.yml` only. They get a read-only token and no GCP credentials. GCP issues
  credentials only to jobs dispatched from `main` in the two environments.

The remaining controls are unchanged: preflight refuses tags that aren't annotated, don't match `VERSION`
or aren't on `origin/main`, and publishing needs the explicit `publish` input.

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
