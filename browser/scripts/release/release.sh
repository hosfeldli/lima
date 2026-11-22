#!/usr/bin/env bash
# Lima release pipeline. Each phase is separate and resumable; only
# `prepare` edits version files, only `tag` creates a tag, and only
# `publish --yes` makes a release visible to users. See docs/RELEASING.md.
#
#   release.sh check                         version files agree
#   release.sh prepare (--bump patch|minor|major | --version X.Y.Z) [--commit] [--push]
#   release.sh tag [--push]                  annotated vX.Y.Z tag on synced main
#   release.sh preflight --tag vX.Y.Z        read-only gates
#   release.sh build     --tag vX.Y.Z        tests, signed app, zip, DMG, signed feed
#   release.sh verify    --tag vX.Y.Z        re-verify dist/<tag>
#   release.sh stage     --tag vX.Y.Z        GitHub draft + private archive + public versioned files
#   release.sh publish   --tag vX.Y.Z --yes  point the public feed at the staged build
#   release.sh rehearse                      signed local build of the working tree with a
#                                            throwaway feed key; skips git gates, never uploads
#
# Environment (CI sets these; see .github/workflows/release.yml):
#   LIMA_SIGN_KEYCHAIN     keychain with the pinned identity (local default: Lima 4 signing dir)
#   LIMA_UPDATE_KEY_FILE   Ed25519 private key for the feed (base64 raw)
#   LIMA_UPDATE_BUCKET     public GCS bucket serving the feed and downloads
#   LIMA_ARCHIVE_BUCKET    private GCS bucket keeping every release's artifacts
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPTS="$ROOT/browser/scripts"
POLICY="${LIMA_RELEASE_POLICY:-$ROOT/browser/release.json}"
LOCK="$ROOT/browser/lima.lock.json"
ED25519="$SCRIPTS/release/ed25519.swift"
LOCAL_SIGNING_DIR="$HOME/Library/Application Support/RayPlacement/Signing"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval('d'+sys.argv[2]))" "$1" "$2"; }
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
require() { for tool in "$@"; do command -v "$tool" >/dev/null || fail "missing required tool: $tool"; done; }

IDENTITY="$(json "$POLICY" "['signing']['identity']")"
CERT_SHA="$(json "$POLICY" "['signing']['certificateSHA256']")"
FEED_URL="$(json "$POLICY" "['updates']['feedURL']")"
UPDATE_PUBLIC_KEY="$(json "$POLICY" "['updates']['publicKey']")"
REPOSITORY="$(json "$POLICY" "['github']['repository']")"

version() { tr -d '[:space:]' < "$ROOT/VERSION"; }
build_number() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail "invalid version $1 (expected X.Y.Z)"
  (( BASH_REMATCH[2] < 1000 && BASH_REMATCH[3] < 1000 )) || fail "minor and patch must be < 1000"
  printf '%d%03d%03d\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
}
validate_tag() { [[ "$1" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid tag $1 (expected vX.Y.Z)"; }
dist_dir() { printf '%s/dist/%s\n' "$ROOT" "$1"; }
feed_base() { printf '%s\n' "${FEED_URL%/latest.json}"; }

# MARK: Source identity

cmd_check() {
  local v; v="$(version)"
  build_number "$v" >/dev/null
  local host; host="$(plutil -extract CFBundleShortVersionString raw "$ROOT/native/Sources/LimaHost/Support/Info.plist")"
  [[ "$host" == "$v" ]] || fail "lima-host Info.plist is $host, VERSION is $v"
  grep -q "limaRuntimeVersion = \"$v" "$ROOT/native/Sources/LimaRuntime/Runtime.swift" \
    || fail "limaRuntimeVersion in Runtime.swift does not start with $v"
  echo "Version files agree: $v ($(build_number "$v"))"
}

assert_clean_tree() {
  [[ -z "$(git -C "$ROOT" status --porcelain)" ]] || { git -C "$ROOT" status --short >&2; fail "the working tree must be clean"; }
}

# HEAD is exactly the annotated tag, the tag matches VERSION, and the commit is on main.
assert_tag_identity() {
  local tag="$1"
  validate_tag "$tag"
  [[ "${tag#v}" == "$(version)" ]] || fail "$tag does not match VERSION $(version)"
  [[ "$(git -C "$ROOT" cat-file -t "refs/tags/$tag" 2>/dev/null)" == tag ]] || fail "$tag must be an annotated tag that exists locally"
  local head tagged
  head="$(git -C "$ROOT" rev-parse HEAD)"
  tagged="$(git -C "$ROOT" rev-list -n1 "$tag")"
  [[ "$head" == "$tagged" ]] || fail "HEAD $head is not $tag ($tagged)"
  git -C "$ROOT" merge-base --is-ancestor "$tagged" origin/main 2>/dev/null || fail "$tag is not on origin/main"
  echo "Source identity: $tag = $head (on origin/main)"
}

cmd_prepare() {
  local bump="" requested="" commit=0 push=0
  while (( $# )); do
    case "$1" in
      --bump) bump="${2:?}"; shift 2 ;;
      --version) requested="${2:?}"; shift 2 ;;
      --commit) commit=1; shift ;;
      --push) commit=1; push=1; shift ;;
      *) fail "unknown prepare option $1" ;;
    esac
  done
  [[ -n "$bump$requested" && ! ( -n "$bump" && -n "$requested" ) ]] || fail "use exactly one of --bump or --version"
  assert_clean_tree
  local current; current="$(version)"
  [[ "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail "VERSION is malformed"
  case "$bump" in
    major) requested="$((BASH_REMATCH[1] + 1)).0.0" ;;
    minor) requested="${BASH_REMATCH[1]}.$((BASH_REMATCH[2] + 1)).0" ;;
    patch) requested="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.$((BASH_REMATCH[3] + 1))" ;;
    "") ;;
    *) fail "--bump takes major, minor or patch" ;;
  esac
  build_number "$requested" >/dev/null
  (( $(build_number "$requested") > $(build_number "$current") )) || fail "$requested is not newer than $current"
  printf '%s\n' "$requested" > "$ROOT/VERSION"
  plutil -replace CFBundleShortVersionString -string "$requested" "$ROOT/native/Sources/LimaHost/Support/Info.plist"
  sed -i '' -E "s/(limaRuntimeVersion = \")[^\"]*\"/\1$requested\"/" "$ROOT/native/Sources/LimaRuntime/Runtime.swift"
  cmd_check
  git -C "$ROOT" --no-pager diff --stat
  if (( commit )); then
    git -C "$ROOT" add VERSION native/Sources/LimaHost/Support/Info.plist native/Sources/LimaRuntime/Runtime.swift
    git -C "$ROOT" commit -m "Bump Lima version to $requested"
  fi
  (( push )) && git -C "$ROOT" push origin HEAD:main
  echo "Prepared $current → $requested. Next: release.sh tag --push"
}

cmd_tag() {
  local push=0
  [[ "${1:-}" == --push ]] && push=1
  assert_clean_tree
  cmd_check
  local tag head
  tag="v$(version)"
  head="$(git -C "$ROOT" rev-parse HEAD)"
  git -C "$ROOT" fetch --quiet origin main --tags
  [[ "$head" == "$(git -C "$ROOT" rev-parse origin/main)" ]] || fail "HEAD must equal origin/main; push the version commit first"
  if git -C "$ROOT" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    [[ "$(git -C "$ROOT" rev-list -n1 "$tag")" == "$head" ]] || fail "$tag already exists on another commit; tags are immutable"
    echo "$tag already points at HEAD"
  else
    git -C "$ROOT" tag -a "$tag" -m "Lima $tag" "$head"
    echo "Created $tag at $head"
  fi
  (( push )) && git -C "$ROOT" push origin "refs/tags/$tag"
  echo "Next: dispatch the release workflow for $tag (gh workflow run release.yml -f tag=$tag)"
}

# MARK: Signing

# Uses LIMA_SIGN_KEYCHAIN (CI) or the local Lima signing keychain, and proves
# it holds the pinned certificate before anything is signed.
prepare_signing() {
  if [[ -z "${LIMA_SIGN_KEYCHAIN:-}" ]]; then
    LIMA_SIGN_KEYCHAIN="$LOCAL_SIGNING_DIR/RayPlacementSigning.keychain-db"
    [[ -f "$LIMA_SIGN_KEYCHAIN" && -f "$LOCAL_SIGNING_DIR/keychain-password" ]] || fail "no signing keychain (set LIMA_SIGN_KEYCHAIN)"
    security unlock-keychain -p "$(cat "$LOCAL_SIGNING_DIR/keychain-password")" "$LIMA_SIGN_KEYCHAIN"
    # codesign only resolves identities from the search list: add it for this run, then restore.
    ORIGINAL_KEYCHAINS=()
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"; line="${line//\"/}"
      [[ -n "$line" ]] && ORIGINAL_KEYCHAINS+=("$line")
    done < <(security list-keychains -d user)
    trap 'security list-keychains -d user -s "${ORIGINAL_KEYCHAINS[@]}"' EXIT
    security list-keychains -d user -s "$LIMA_SIGN_KEYCHAIN" "${ORIGINAL_KEYCHAINS[@]}"
  fi
  export LIMA_SIGN_KEYCHAIN
  security find-identity -v -p codesigning "$LIMA_SIGN_KEYCHAIN" | grep -Fq "\"$IDENTITY\"" || fail "$IDENTITY is not a valid identity in $LIMA_SIGN_KEYCHAIN"
  local actual
  actual="$(security find-certificate -c "$IDENTITY" -p "$LIMA_SIGN_KEYCHAIN" | openssl x509 -outform der | shasum -a 256 | awk '{print $1}')"
  [[ "$actual" == "$CERT_SHA" ]] || fail "signing certificate $actual is not the pinned $CERT_SHA"
}

# MARK: Gates

published_feed_build() {
  # Prints the build currently on the public feed (0 if none), after verifying its signature.
  local work; work="$(mktemp -d)"
  if curl -fsSL --proto '=https' --max-time 30 -o "$work/latest.json" "$FEED_URL" \
     && curl -fsSL --proto '=https' --max-time 30 -o "$work/latest.json.sig" "$FEED_URL.sig"; then
    swift "$ED25519" verify "$UPDATE_PUBLIC_KEY" "$work/latest.json" "$work/latest.json.sig" >/dev/null \
      || fail "the live feed's signature does not verify with the pinned key"
    json "$work/latest.json" "['build']"
  else
    echo 0
  fi
  rm -rf "$work"
}

cmd_preflight() {
  local tag="$1"
  require git gh swift python3 codesign security hdiutil ditto shasum openssl curl plutil
  [[ "$FEED_URL" == https://*/latest.json ]] || fail "browser/release.json updates.feedURL must be an https URL ending in /latest.json"
  [[ -n "$UPDATE_PUBLIC_KEY" ]] || fail "browser/release.json updates.publicKey is empty (run browser/scripts/release/setup_update_key.sh)"
  if [[ -n "${LIMA_UPDATE_BUCKET:-}" ]]; then
    [[ "$FEED_URL" == "https://storage.googleapis.com/$LIMA_UPDATE_BUCKET/stable/latest.json" ]] \
      || fail "feedURL does not match gs://$LIMA_UPDATE_BUCKET/stable/latest.json"
  fi
  assert_clean_tree
  cmd_check
  assert_tag_identity "$tag"
  prepare_signing
  local candidate live
  candidate="$(build_number "${tag#v}")"
  live="$(published_feed_build)"
  (( candidate > live )) || fail "build $candidate is not newer than the published build $live"
  if gh release view "$tag" -R "$REPOSITORY" >/dev/null 2>&1; then
    [[ "$(gh release view "$tag" -R "$REPOSITORY" --json isDraft --jq .isDraft)" == true ]] || fail "$tag is already published"
    echo "Draft $tag exists; staging will resume it"
  fi
  local free_kb; free_kb="$(df -Pk "$ROOT" | awk 'NR==2 {print $4}')"
  (( free_kb > 10 * 1024 * 1024 )) || fail "need 10 GB free"
  echo "Preflight passed for $tag (build $candidate > live $live)"
}

# MARK: Build

write_feed() {
  local tag="$1" dist="$2" v="${1#v}"
  local zip="$dist/Lima-$v.zip"
  python3 - "$dist/latest.json" "$v" "$(build_number "$v")" "$(feed_base)/$v/Lima-$v.zip" "$(sha256 "$zip")" \
    "$(stat -f %z "$zip")" "$(json "$LOCK" "['zen']['tag']")" "$(json "$LOCK" "['zen']['firefoxVersion']")" \
    "$(git -C "$ROOT" rev-parse HEAD)" "${LIMA_CRITICAL_UPDATE:-false}" <<'PY'
import datetime, json, sys
out, version, build, url, digest, size, zen, gecko, commit, critical = sys.argv[1:]
feed = {
    "schemaVersion": 1, "channel": "stable", "version": version, "build": int(build),
    "minimumSystemVersion": "14.0", "url": url, "sha256": digest, "bytes": int(size),
    "engine": f"zen {zen} / gecko {gecko}", "commit": commit,
    "publishedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "critical": critical == "true",
}
open(out, "w").write(json.dumps(feed, indent=2, sort_keys=True) + "\n")
PY
  [[ -f "${LIMA_UPDATE_KEY_FILE:-}" ]] || fail "LIMA_UPDATE_KEY_FILE must point at the feed signing key"
  [[ "$(swift "$ED25519" public "$LIMA_UPDATE_KEY_FILE")" == "$UPDATE_PUBLIC_KEY" ]] || fail "LIMA_UPDATE_KEY_FILE is not the key pinned in browser/release.json"
  swift "$ED25519" sign "$LIMA_UPDATE_KEY_FILE" "$dist/latest.json" > "$dist/latest.json.sig"
  swift "$ED25519" verify "$UPDATE_PUBLIC_KEY" "$dist/latest.json" "$dist/latest.json.sig" >/dev/null
}

cmd_build() {
  local tag="$1"
  if [[ "${LIMA_RELEASE_SKIP_PREFLIGHT:-0}" == 1 ]]; then echo "Preflight already ran in this job"; else cmd_preflight "$tag"; fi
  step "Running native tests"
  swift test --package-path "$ROOT/native"
  build_artifacts "$tag"
  echo "Built $tag in $(dist_dir "$tag"). Next: release.sh stage --tag $tag"
}

build_artifacts() {
  local tag="$1" v="${1#v}"
  prepare_signing
  local dist out
  dist="$(dist_dir "$tag")"
  out="$ROOT/build/release"
  rm -rf "$dist" "$out"
  mkdir -p "$dist"

  step "Building signed Lima.app"
  LIMA_RELEASE_POLICY="$POLICY" LIMA_RELEASE=1 LIMA_SIGN_IDENTITY="$IDENTITY" LIMA_BUILD_DIR="$out" "$SCRIPTS/repack.sh"
  [[ "$(plutil -extract CFBundleVersion raw "$out/Lima.app/Contents/Info.plist")" == "$(build_number "$v")" ]] || fail "built app has the wrong CFBundleVersion"

  step "Packaging"
  ditto -c -k --sequesterRsrc --keepParent "$out/Lima.app" "$dist/Lima-$v.zip"
  local stage; stage="$(mktemp -d)"
  ditto "$out/Lima.app" "$stage/Lima.app"
  ln -s /Applications "$stage/Applications"
  cp "$ROOT/browser/branding/install-lima.html" "$stage/Install Lima.html"
  cp "$out/Lima.app/Contents/Resources/lima.icns" "$stage/.VolumeIcon.icns"
  if command -v SetFile >/dev/null 2>&1; then SetFile -a C "$stage"; fi
  hdiutil create -quiet -volname "Lima $v" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dist/Lima-$v.dmg"
  rm -rf "$stage"
  codesign --force --timestamp=none --sign "$IDENTITY" --keychain "$LIMA_SIGN_KEYCHAIN" "$dist/Lima-$v.dmg"
  cp "$out/zen-entitlements.json" "$dist/zen-entitlements.json"

  step "Signing update feed"
  write_feed "$tag" "$dist"
  (cd "$dist" && shasum -a 256 "Lima-$v.zip" "Lima-$v.dmg" latest.json latest.json.sig zen-entitlements.json > SHA256SUMS)
  cmd_verify "$tag"
}

cmd_rehearse() {
  local work; work="$(mktemp -d)"
  swift "$ED25519" generate "$work/update-key" > "$work/public"
  python3 - "$POLICY" "$work/policy.json" "$(cat "$work/public")" <<'PY'
import json, sys
source, out, key = sys.argv[1:]
policy = json.load(open(source))
policy["updates"]["publicKey"] = key
policy["updates"]["feedURL"] = policy["updates"]["feedURL"] or "https://storage.googleapis.com/lima-rehearsal/stable/latest.json"
open(out, "w").write(json.dumps(policy, indent=2))
PY
  echo "Rehearsal: working tree $(git -C "$ROOT" rev-parse --short HEAD)$([[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo '+dirty'), throwaway feed key"
  LIMA_RELEASE_POLICY="$work/policy.json" LIMA_UPDATE_KEY_FILE="$work/update-key" "$0" _rehearse-build "v$(version)"
  rm -rf "$work"
}

cmd_verify() {
  local tag="$1" v="${1#v}" dist work
  dist="$(dist_dir "$tag")"
  [[ -f "$dist/SHA256SUMS" ]] || fail "no build in $dist"
  (cd "$dist" && shasum -a 256 -c SHA256SUMS >/dev/null) || fail "dist checksums do not match"
  swift "$ED25519" verify "$UPDATE_PUBLIC_KEY" "$dist/latest.json" "$dist/latest.json.sig" >/dev/null || fail "feed signature"
  [[ "$(json "$dist/latest.json" "['build']")" == "$(build_number "$v")" ]] || fail "feed build does not match $tag"
  [[ "$(json "$dist/latest.json" "['sha256']")" == "$(sha256 "$dist/Lima-$v.zip")" ]] || fail "feed digest does not match the zip"
  [[ "$(json "$dist/latest.json" "['url']")" == "$(feed_base)/$v/Lima-$v.zip" ]] || fail "feed URL is not beside the feed"
  # Verify what users will actually receive: the app as extracted from the archive.
  work="$(mktemp -d)"
  ditto -x -k "$dist/Lima-$v.zip" "$work"
  python3 "$SCRIPTS/lima_codesign.py" verify "$work/Lima.app" "$dist/zen-entitlements.json" --certificate-sha256 "$CERT_SHA"
  [[ "$(plutil -extract LimaUpdatePublicKey raw "$work/Lima.app/Contents/Info.plist")" == "$UPDATE_PUBLIC_KEY" ]] || fail "app carries the wrong update key"
  [[ "$(plutil -extract LimaUpdateFeedURL raw "$work/Lima.app/Contents/Info.plist")" == "$FEED_URL" ]] || fail "app carries the wrong feed URL"
  grep -q 'lockPref("lima.release.hardened", true)' "$work/Lima.app/Contents/Resources/lima.cfg" || fail "release prefs are missing"
  rm -rf "$work"
  codesign --verify --strict "$dist/Lima-$v.dmg"
  echo "Verified $tag: checksums, signed feed, signed app (pinned certificate), DMG"
}

# MARK: Distribution

gcs_put_immutable() {
  # Upload once; a rerun accepts an identical existing object and refuses a different one.
  local file="$1" destination="$2"
  if gcloud storage cp --if-generation-match=0 "$file" "$destination" 2>/dev/null; then return; fi
  local existing; existing="$(mktemp)"
  gcloud storage cp "$destination" "$existing" >/dev/null
  cmp -s "$file" "$existing" || { rm -f "$existing"; fail "$destination already exists with different content"; }
  rm -f "$existing"
  echo "Already uploaded: $destination"
}

cmd_stage() {
  local tag="$1" v="${1#v}" dist
  dist="$(dist_dir "$tag")"
  : "${LIMA_UPDATE_BUCKET:?LIMA_UPDATE_BUCKET is required}" "${LIMA_ARCHIVE_BUCKET:?LIMA_ARCHIVE_BUCKET is required}"
  require gh gcloud
  cmd_verify "$tag"
  assert_tag_identity "$tag"

  step "Archiving privately to gs://$LIMA_ARCHIVE_BUCKET/releases/$tag"
  for file in "$dist"/*; do gcs_put_immutable "$file" "gs://$LIMA_ARCHIVE_BUCKET/releases/$tag/$(basename "$file")"; done

  step "Uploading versioned downloads to gs://$LIMA_UPDATE_BUCKET/stable/$v"
  gcs_put_immutable "$dist/Lima-$v.zip" "gs://$LIMA_UPDATE_BUCKET/stable/$v/Lima-$v.zip"
  gcs_put_immutable "$dist/Lima-$v.dmg" "gs://$LIMA_UPDATE_BUCKET/stable/$v/Lima-$v.dmg"
  gcs_put_immutable "$dist/SHA256SUMS" "gs://$LIMA_UPDATE_BUCKET/stable/$v/SHA256SUMS"

  step "Staging GitHub draft $tag"
  if gh release view "$tag" -R "$REPOSITORY" >/dev/null 2>&1; then
    [[ "$(gh release view "$tag" -R "$REPOSITORY" --json isDraft --jq .isDraft)" == true ]] || fail "$tag is already published"
  else
    local notes=(--generate-notes)
    [[ -f "$ROOT/docs/releases/$tag.md" ]] && notes=(--notes-file "$ROOT/docs/releases/$tag.md")
    gh release create "$tag" -R "$REPOSITORY" --draft --verify-tag --title "Lima $v" "${notes[@]}"
  fi
  gh release upload "$tag" -R "$REPOSITORY" --clobber "$dist"/*
  for file in "$dist"/*; do
    local name digest
    name="$(basename "$file")"
    digest="$(gh api "$(gh release view "$tag" -R "$REPOSITORY" --json assets --jq ".assets[] | select(.name == \"$name\") | .apiUrl")" --jq '.digest // empty')"
    [[ "$digest" == "sha256:$(sha256 "$file")" ]] || fail "GitHub copy of $name has digest $digest"
  done
  echo "Staged $tag. The public feed is unchanged until: release.sh publish --tag $tag --yes"
}

# Works from the staged draft alone, so the publish job needs no signing keys.
cmd_publish() {
  local tag="$1" confirmed="$2" v="${1#v}" work
  (( confirmed )) || fail "publishing updates every Lima install; re-run with --yes"
  : "${LIMA_UPDATE_BUCKET:?LIMA_UPDATE_BUCKET is required}"
  require gh gcloud curl swift
  validate_tag "$tag"
  local draft live resumed=0
  draft="$(gh release view "$tag" -R "$REPOSITORY" --json isDraft --jq .isDraft)"
  work="$(mktemp -d)"
  gh release download "$tag" -R "$REPOSITORY" -D "$work" -p latest.json -p latest.json.sig -p SHA256SUMS
  swift "$ED25519" verify "$UPDATE_PUBLIC_KEY" "$work/latest.json" "$work/latest.json.sig" >/dev/null || fail "staged feed signature"
  [[ "$(json "$work/latest.json" "['build']")" == "$(build_number "$v")" ]] || fail "staged feed is not $tag"
  live="$(published_feed_build)"
  # A publish that failed after the feed swap left installs seeing this
  # release. Resume the remaining idempotent steps instead of refusing.
  if (( live == $(build_number "$v") )); then
    curl -fsSL --proto '=https' -H 'Cache-Control: no-cache' -o "$work/live.json" "$FEED_URL"
    cmp -s "$work/live.json" "$work/latest.json" || fail "the live feed has build $live but is not the staged $tag feed"
    resumed=1
    echo "The live feed already serves $tag; resuming the steps after the feed swap"
  else
    [[ "$draft" == true ]] || fail "$tag is not a staged draft"
    (( $(build_number "$v") > live )) || fail "$tag is not newer than the live feed"
  fi

  step "Checking the public download"
  curl -fsSL --proto '=https' -o "$work/download.zip" "$(json "$work/latest.json" "['url']")"
  [[ "$(sha256 "$work/download.zip")" == "$(json "$work/latest.json" "['sha256']")" ]] || fail "public zip does not match the signed feed"

  local cache=(--cache-control="no-cache, max-age=0")
  if (( ! resumed )); then
    step "Publishing the feed"
    gcloud storage cp "${cache[@]}" --content-type=text/plain "$work/latest.json.sig" "gs://$LIMA_UPDATE_BUCKET/stable/latest.json.sig"
    gcloud storage cp "${cache[@]}" --content-type=application/json "$work/latest.json" "gs://$LIMA_UPDATE_BUCKET/stable/latest.json"
  fi
  # lima.liamhosfeld.com/download redirects here: always the newest published DMG.
  gcloud storage cp "${cache[@]}" --content-type=application/x-apple-diskimage \
    "gs://$LIMA_UPDATE_BUCKET/stable/$v/Lima-$v.dmg" "gs://$LIMA_UPDATE_BUCKET/stable/Lima.dmg"
  if [[ "$draft" == true ]]; then
    gh release edit "$tag" -R "$REPOSITORY" --draft=false --latest
  fi

  step "Verifying the live feed"
  curl -fsSL --proto '=https' -H 'Cache-Control: no-cache' -o "$work/live.json" "$FEED_URL"
  curl -fsSL --proto '=https' -H 'Cache-Control: no-cache' -o "$work/live.json.sig" "$FEED_URL.sig"
  cmp -s "$work/live.json" "$work/latest.json" || fail "the live feed is not the staged feed (CDN cache?)"
  swift "$ED25519" verify "$UPDATE_PUBLIC_KEY" "$work/live.json" "$work/live.json.sig" >/dev/null
  rm -rf "$work"
  echo "Published Lima $v. Installs pick it up within six hours."
}

# MARK: Dispatch

command="${1:-help}"; shift || true
tag=""; yes=0; rest=()
while (( $# )); do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift 2 ;;
    --yes) yes=1; shift ;;
    *) rest+=("$1"); shift ;;
  esac
done
need_tag() { [[ -n "$tag" ]] || tag="v$(version)"; validate_tag "$tag"; }
case "$command" in
  check) cmd_check ;;
  prepare) cmd_prepare "${rest[@]+"${rest[@]}"}" ;;
  tag) cmd_tag "${rest[@]+"${rest[@]}"}" ;;
  preflight) need_tag; cmd_preflight "$tag" ;;
  build) need_tag; cmd_build "$tag" ;;
  verify) need_tag; cmd_verify "$tag" ;;
  stage) need_tag; cmd_stage "$tag" ;;
  publish) need_tag; cmd_publish "$tag" "$yes" ;;
  rehearse) cmd_rehearse ;;
  _rehearse-build) cmd_check; build_artifacts "${rest[0]}"; echo "Rehearsal artifacts in $(dist_dir "${rest[0]}") (not for distribution)" ;;
  help|-h|--help) sed -n '2,22p' "$0" ;;
  *) fail "unknown command $command (see release.sh help)" ;;
esac
