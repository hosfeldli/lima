#!/usr/bin/env bash
# Move Lima to a new Zen release, updating every pinned field together.
#
#   bump-zen.sh [--check] [TAG]
#
# With no TAG, uses Zen's latest published (non-prerelease) release. The new
# DMG must be signed by Zen's pinned Developer ID team and notarized before
# anything is written. --check only prints the latest tag and exits 10 when
# it differs from the pin (for the scheduled workflow).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="$ROOT/browser/lima.lock.json"
CACHE="$ROOT/browser/.cache"
UPSTREAM=zen-browser/desktop
json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval('d'+sys.argv[2]))" "$1" "$2"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

check=0
[[ "${1:-}" == --check ]] && { check=1; shift; }
current="$(json "$LOCK" "['zen']['tag']")"
team="$(json "$LOCK" "['zen']['signingTeam']")"
asset="$(json "$LOCK" "['zen']['macosDmg']['asset']")"
tag="${1:-$(gh release view -R "$UPSTREAM" --json tagName --jq .tagName)}"
[[ "$tag" =~ ^[0-9A-Za-z._-]+$ ]] || fail "unexpected Zen tag $tag"

if (( check )); then
  echo "$tag"
  [[ "$tag" == "$current" ]] && exit 0 || exit 10
fi
[[ "$tag" != "$current" ]] || { echo "Already on Zen $tag"; exit 0; }
[[ "$(gh release view "$tag" -R "$UPSTREAM" --json isPrerelease,isDraft --jq '.isPrerelease or .isDraft')" == false ]] \
  || fail "Zen $tag is a prerelease"

commit="$(gh api "repos/$UPSTREAM/commits/$tag" --jq .sha)"
mkdir -p "$CACHE"
dmg="$CACHE/zen-$tag.dmg"
rm -f "$dmg"
gh release download "$tag" -R "$UPSTREAM" -p "$asset" -O "$dmg"
digest="$(shasum -a 256 "$dmg" | awk '{print $1}')"

mount="$(mktemp -d)"
trap 'hdiutil detach -quiet "$mount" 2>/dev/null || true; rmdir "$mount" 2>/dev/null || true' EXIT
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$dmg" >/dev/null
codesign --verify --deep -R="anchor apple generic and certificate leaf[subject.OU] = \"$team\"" "$mount/Zen.app" \
  || fail "Zen $tag is not signed by team $team; if Zen changed teams, review that by hand before re-pinning"
spctl --assess --type execute -vv "$mount/Zen.app" 2>&1 | grep -q "source=Notarized Developer ID" || fail "Zen $tag is not notarized"
gecko="$(awk -F= '$1 == "Milestone" {print $2}' "$mount/Zen.app/Contents/Resources/platform.ini")"
[[ -n "$gecko" ]] || fail "could not read the Gecko milestone"
old_gecko="$(json "$LOCK" "['zen']['firefoxVersion']")"
source_digest="$(curl -fsSL --proto '=https' "https://archive.mozilla.org/pub/firefox/releases/$gecko/SHA512SUMS" |
  awk -v path="source/firefox-$gecko.source.tar.xz" '$2 == path {print $1}')"
[[ "$source_digest" =~ ^[0-9a-f]{128}$ ]] || fail "Mozilla does not list a source checksum for Firefox $gecko"

python3 - "$LOCK" "$tag" "$commit" "$gecko" "$digest" "$source_digest" <<'PY'
import json, sys
path, tag, commit, gecko, digest, source_digest = sys.argv[1:]
lock = json.load(open(path))
lock["zen"].update(tag=tag, commit=commit, firefoxVersion=gecko, firefoxSourceSha512=source_digest)
lock["zen"]["macosDmg"]["sha256"] = digest
open(path, "w").write(json.dumps(lock, indent=2) + "\n")
PY
if [[ -e "$ROOT/browser/zen-upstream/.git" ]]; then
  git -C "$ROOT/browser/zen-upstream" fetch --quiet --depth 1 origin "refs/tags/$tag:refs/tags/$tag"
  git -C "$ROOT/browser/zen-upstream" checkout --quiet "$commit"
fi
cat <<EOF
Zen $current → $tag
  commit:  $commit
  Firefox: $old_gecko → $gecko
  sha256:  $digest
Next: make browser && make run, then commit browser/lima.lock.json and browser/zen-upstream.
EOF
