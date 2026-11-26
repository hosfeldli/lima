#!/usr/bin/env bash
# Run on a clean macOS CI runner after building the signed candidate.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
candidate="${1:?candidate app path required}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
readarray_compatible="$(python3 - "$root/browser/release.json" <<'PY'
import json, sys
policy = json.load(open(sys.argv[1]))["updates"]
print(f'{policy["feedURL"]} {policy["publicKey"]}')
PY
)"
read -r feed key <<< "$readarray_compatible"
curl --fail --silent --show-error --location "$feed" -o "$work/latest.json"
curl --fail --silent --show-error --location "$feed.sig" -o "$work/latest.json.sig"
swift "$root/browser/scripts/release/ed25519.swift" verify "$key" "$work/latest.json" "$work/latest.json.sig"
read -r archive checksum <<< "$(python3 - "$work/latest.json" <<'PY'
import json, sys
feed = json.load(open(sys.argv[1]))
print(f'{feed["url"]} {feed["sha256"]}')
PY
)"
curl --fail --silent --show-error --location "$archive" -o "$work/previous.zip"
echo "$checksum  $work/previous.zip" | shasum -a 256 -c -
mkdir "$work/previous"
ditto -x -k "$work/previous.zip" "$work/previous"
LIMA_TEST_PREVIOUS_APP="$work/previous/Lima.app" LIMA_TEST_CANDIDATE_APP="$candidate" \
  swift test --package-path "$root/native" --filter signedUpgradeFromPreviousRelease
