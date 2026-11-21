#!/usr/bin/env bash
# One-time: create Lima's update-feed signing key.
#
# Writes the private key next to the existing local signing material (0600),
# pins the public key in browser/release.json, and prints the command that
# stores the private key in GCP Secret Manager for the release workflow.
# It does not upload anything itself.
#
# Rotating this key strands every install that pins the old one, so it is
# created once and never replaced casually.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
DIR="${LIMA_UPDATE_KEY_DIR:-$HOME/Library/Application Support/RayPlacement/Signing}"
KEY="$DIR/lima-update-ed25519-key"
POLICY="$ROOT/browser/release.json"

existing="$(python3 -c "import json;print(json.load(open('$POLICY'))['updates']['publicKey'])")"
[[ -z "$existing" ]] || { echo "error: release.json already pins update key $existing; refusing to rotate" >&2; exit 1; }
mkdir -p "$DIR" && chmod 700 "$DIR"
public="$(swift "$ROOT/browser/scripts/release/ed25519.swift" generate "$KEY")"
python3 - "$POLICY" "$public" <<'PY'
import json, sys
path, key = sys.argv[1:]
policy = json.load(open(path))
policy["updates"]["publicKey"] = key
open(path, "w").write(json.dumps(policy, indent=2) + "\n")
PY
cat <<EOF
Update key created.
  private: $KEY   (keep it; back it up offline)
  public:  $public   (pinned in browser/release.json)

Store it for the release workflow:
  gcloud secrets create lima-update-ed25519-key --project "\$GCP_PROJECT_ID" --replication-policy=automatic --data-file="$KEY"
  gcloud secrets add-iam-policy-binding lima-update-ed25519-key --project "\$GCP_PROJECT_ID" \\
    --member="serviceAccount:\$GCP_RELEASE_SERVICE_ACCOUNT" --role=roles/secretmanager.secretAccessor
EOF
