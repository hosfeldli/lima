#!/usr/bin/env bash
# Disposable signing material on a GitHub-hosted release runner.
#
#   ci_signing.sh prepare   fetch secrets from GCP Secret Manager (via OIDC),
#                           build a temporary keychain, prove the pinned certificate
#   ci_signing.sh cleanup   delete the keychain and every secret file (always runs)
#
# Secret Manager holds the only private material; GitHub stores no secrets:
#   lima-signing-p12            PKCS#12: the pinned self-signed certificate and key
#   lima-signing-p12-password   its password
#   lima-update-ed25519-key     feed signing key (base64 raw Ed25519)
# With signing.mode "developer-id" in browser/release.json, instead of the first two:
#   lima-devid-p12, lima-devid-p12-password   Developer ID Application certificate and key
#   lima-notary-key, lima-notary-key-id, lima-notary-issuer-id
#                               App Store Connect API key used to notarize
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo "error: ci_signing.sh runs only on GitHub Actions runners" >&2; exit 1; }
DIR="${RUNNER_TEMP:?}/lima-signing"
KEYCHAIN="$DIR/lima-release.keychain-db"
case "$DIR" in "${RUNNER_TEMP%/}"/*) ;; *) echo "error: signing directory must be inside RUNNER_TEMP" >&2; exit 1 ;; esac

prepare() {
  local identity fingerprint mode
  identity="$(python3 -c "import json;print(json.load(open('$ROOT/browser/release.json'))['signing']['identity'])")"
  fingerprint="$(python3 -c "import json;print(json.load(open('$ROOT/browser/release.json'))['signing']['certificateSHA256'])")"
  mode="$(python3 -c "import json;print(json.load(open('$ROOT/browser/release.json'))['signing']['mode'])")"
  umask 077
  mkdir -p "$DIR"
  trap 'cleanup; exit 1' ERR INT TERM
  local p12_secret=lima-signing-p12 password_secret=lima-signing-p12-password
  if [[ "$mode" == developer-id ]]; then p12_secret=lima-devid-p12; password_secret=lima-devid-p12-password; fi
  gcloud secrets versions access latest --secret="${LIMA_SECRET_P12:-$p12_secret}" --out-file="$DIR/signing.p12"
  gcloud secrets versions access latest --secret="${LIMA_SECRET_P12_PASSWORD:-$password_secret}" --out-file="$DIR/p12-password"
  gcloud secrets versions access latest --secret="${LIMA_SECRET_UPDATE_KEY:-lima-update-ed25519-key}" --out-file="$DIR/update-key"
  if [[ "$mode" == developer-id ]]; then
    gcloud secrets versions access latest --secret=lima-notary-key --out-file="$DIR/notary-key.p8"
    gcloud secrets versions access latest --secret=lima-notary-key-id --out-file="$DIR/notary-key-id"
    gcloud secrets versions access latest --secret=lima-notary-issuer-id --out-file="$DIR/notary-issuer"
  fi
  chmod 600 "$DIR"/*

  local password keychain_password
  password="$(cat "$DIR/p12-password")"
  [[ -n "$password" ]] || { echo "error: the P12 password secret is empty" >&2; exit 1; }
  keychain_password="$(openssl rand -hex 32)"
  security create-keychain -p "$keychain_password" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$keychain_password" "$KEYCHAIN"
  local existing=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"; line="${line//\"/}"
    [[ -n "$line" ]] && existing+=("$line")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$KEYCHAIN" "${existing[@]+"${existing[@]}"}"
  security import "$DIR/signing.p12" -f pkcs12 -k "$KEYCHAIN" -P "$password" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$KEYCHAIN" >/dev/null
  rm -f "$DIR/signing.p12" "$DIR/p12-password"

  security find-certificate -c "$identity" -p "$KEYCHAIN" > "$DIR/certificate.pem"
  local actual
  actual="$(openssl x509 -in "$DIR/certificate.pem" -outform der | shasum -a 256 | awk '{print $1}')"
  [[ "$actual" == "$fingerprint" ]] || { echo "error: secret certificate $actual is not the pinned $fingerprint" >&2; exit 1; }
  if [[ "$mode" == developer-id ]]; then
    # Apple's chain: the Developer ID intermediate may be missing on a fresh runner.
    curl -fsSL --proto '=https' -o "$DIR/DeveloperIDG2CA.cer" https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
    security import "$DIR/DeveloperIDG2CA.cer" -k "$KEYCHAIN" >/dev/null 2>&1 || true
  else
    # A self-signed certificate is only a valid codesigning identity once trusted.
    # The runner is destroyed after the job, so this trust never outlives it.
    sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$DIR/certificate.pem"
  fi
  security find-identity -v -p codesigning "$KEYCHAIN" | grep -Fq "\"$identity\"" || { echo "error: $identity is not usable" >&2; exit 1; }

  {
    echo "LIMA_SIGN_KEYCHAIN=$KEYCHAIN"
    echo "LIMA_UPDATE_KEY_FILE=$DIR/update-key"
    if [[ "$mode" == developer-id ]]; then
      echo "LIMA_NOTARY_KEY_FILE=$DIR/notary-key.p8"
      echo "LIMA_NOTARY_KEY_ID=$(cat "$DIR/notary-key-id")"
      echo "LIMA_NOTARY_ISSUER=$(cat "$DIR/notary-issuer")"
    fi
  } >> "${GITHUB_ENV:?}"
  trap - ERR INT TERM
  echo "Prepared ephemeral signing for $identity ($fingerprint)"
}

cleanup() {
  security delete-keychain "$KEYCHAIN" >/dev/null 2>&1 || true
  rm -rf -- "$DIR"
  echo "Removed ephemeral signing material"
}

case "${1:-}" in
  prepare) prepare ;;
  cleanup) cleanup ;;
  *) echo "usage: ci_signing.sh prepare|cleanup" >&2; exit 64 ;;
esac
