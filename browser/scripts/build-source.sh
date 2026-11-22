#!/usr/bin/env bash
# Compile the pinned Zen/Gecko source. Generated work stays under browser/work.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BROWSER="$ROOT/browser"
LOCK="$BROWSER/lima.lock.json"
UPSTREAM="$BROWSER/zen-upstream"
WORK="${LIMA_SOURCE_WORK:-$BROWSER/work}"
PHASE="${1:-all}"
ARCH="$(uname -m)"
RELEASE="${LIMA_RELEASE:-0}"

json() {
  python3 - "$LOCK" "$1" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
for key in sys.argv[2].split("."):
    value = value[key]
print(value)
PY
}
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

ZEN_COMMIT="$(json zen.commit)"
GECKO="$(json zen.firefoxVersion)"
SHA512="$(json zen.firefoxSourceSha512)"
[[ "$ARCH" == arm64 || "$ARCH" == x86_64 ]] && [[ "$(uname -s)" == Darwin ]] || fail "Build on macOS arm64 or x86_64."
[[ "$RELEASE" == 0 || "$RELEASE" == 1 ]] || fail "LIMA_RELEASE must be 0 or 1."
[[ "$PHASE" =~ ^(all|prepare|build|package)$ ]] || fail "Use all, prepare, build, or package."
[[ "$SHA512" =~ ^[0-9a-f]{128}$ ]] || fail "The Firefox source archive needs a pinned SHA-512."
[[ "$(git -C "$UPSTREAM" rev-parse HEAD)" == "$ZEN_COMMIT" ]] || fail "Run make bootstrap and check the Zen submodule pin."
mkdir -p "$WORK" "$BROWSER/.cache"
WORK="$(cd "$WORK" && pwd)"
CHECKOUT="$WORK/zen-${ZEN_COMMIT:0:12}-$ARCH"
ARCHIVE="firefox-$GECKO.source.tar.xz"
CACHE="$BROWSER/.cache/$ARCHIVE"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
JOBS="${LIMA_SOURCE_JOBS:-2}"

export HUSKY=0 SURFER_PLATFORM=darwin
if [[ "$ARCH" == arm64 ]]; then export SURFER_COMPAT=aarch64; else export SURFER_COMPAT=x86_64; fi
# The full optimized build fits a smaller runner without Zen’s PGO artifacts.
export ZEN_GA_DISABLE_PGO=1 ZEN_DISABLE_LTO=1
export GIT_AUTHOR_NAME="Lima Source Build" GIT_COMMITTER_NAME="Lima Source Build"
export GIT_AUTHOR_EMAIL="lima-build@localhost" GIT_COMMITTER_EMAIL="lima-build@localhost"

prepare() {
  step "Checking the source build prerequisites"
  local free
  free="$(df -Pk "$WORK" | awk 'END {print $4}')"
  if [[ ! -d "$CHECKOUT/engine" ]] && (( free < 30 * 1024 * 1024 )); then
    fail "The source workspace needs at least 30 GiB available before initial preparation."
  fi
  command -v rustup >/dev/null || fail "Zen pins its Rust toolchain through rustup."
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)' || fail "Use Node.js 22 or newer."
  if [[ ! -d "$CHECKOUT/.git" ]]; then
    git clone --shared --no-checkout "$UPSTREAM" "$CHECKOUT"
    git -C "$CHECKOUT" checkout --detach "$ZEN_COMMIT"
  fi
  cd "$CHECKOUT"
  if [[ ! -d node_modules/@zen-browser/surfer ]]; then npm ci; fi
  if [[ ! -f "$CACHE" ]]; then
    curl -fL --proto '=https' --retry 3 "https://archive.mozilla.org/pub/firefox/releases/$GECKO/source/$ARCHIVE" -o "$CACHE.partial"
    printf '%s  %s\n' "$SHA512" "$CACHE.partial" | shasum -a 512 -c
    mv "$CACHE.partial" "$CACHE"
  fi
  printf '%s  %s\n' "$SHA512" "$CACHE" | shasum -a 512 -c
  if [[ ! -f .lima-zen-imported ]]; then
    # Start each import from Zen’s pinned files so every Lima edit applies once.
    git checkout -- .
    python3 "$BROWSER/scripts/prepare_source.py" zen "$CHECKOUT"
    npm run surfer -- ci --brand release --display-version "$VERSION"
    if [[ ! -f engine/mach ]]; then
      mkdir -p .surfer/engine
      ln -sf "$CACHE" ".surfer/engine/$ARCHIVE"
      npm run download
    fi
    local toolchain
    toolchain="$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)"
    rustup toolchain install "$toolchain" --profile minimal
    local python
    python="$(command -v python3.11 || command -v python3)"
    "$python" -m venv .lima-python
    .lima-python/bin/pip install -r requirements.txt
    PATH="$CHECKOUT/.lima-python/bin:$PATH" npm run import
    touch .lima-zen-imported
  fi
  # Zen’s own en-US strings reach the engine only through this copy.
  python3 scripts/copy_language_pack.py en-US >/dev/null
  if [[ "$RELEASE" == 1 ]]; then
    python3 "$BROWSER/scripts/prepare_source.py" engine "$CHECKOUT" --release
  else
    python3 "$BROWSER/scripts/prepare_source.py" engine "$CHECKOUT"
  fi
  step "Prepared $CHECKOUT/engine"
}

build() {
  cd "$CHECKOUT"
  [[ -f .lima-zen-imported ]] || fail "Run $0 prepare before building."
  export PATH="$CHECKOUT/.lima-python/bin:$PATH"
  step "Bootstrapping Gecko’s pinned toolchains"
  if [[ ! -f .lima-bootstrapped ]]; then
    (cd engine && ./mach --no-interactive bootstrap --application-choice=browser --no-system-changes)
    touch .lima-bootstrapped
  fi
  step "Compiling Gecko and Zen patches with $JOBS jobs"
  npm run build -- --jobs "$JOBS"
}

package() {
  cd "$CHECKOUT"
  export PATH="$CHECKOUT/.lima-python/bin:$PATH"
  step "Packaging the compiled application"
  (cd engine && MOZ_PKG_FORMAT=DMG ./mach package)
  local archive mount app output manifest
  archive="$(find engine -path '*/dist/*.dmg' -type f -print | head -n 1)"
  [[ -n "$archive" ]] || fail "mach package did not produce a DMG."
  mount="$(mktemp -d)"
  cleanup() { hdiutil detach -quiet "$mount" >/dev/null 2>&1 || true; rmdir "$mount" 2>/dev/null || true; }
  trap cleanup EXIT
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount" "$archive" >/dev/null
  app="$(find "$mount" -mindepth 1 -maxdepth 1 -type d -name '*.app' -print)"
  [[ -d "$app" && -f "$app/Contents/MacOS/lima" && ! -e "$app/Contents/MacOS/zen" ]] || fail "Unexpected Gecko app bundle."
  output="$CHECKOUT/packaged"
  mkdir -p "$output"
  manifest="$output/source.json"
  python3 - "$manifest" "$ZEN_COMMIT" "$GECKO" "$SHA512" "$RELEASE" <<'PY'
import json, sys
from pathlib import Path
path, commit, gecko, digest, release = sys.argv[1:]
Path(path).write_text(json.dumps(dict(zenCommit=commit, gecko=gecko, sourceSha512=digest, hardened=release=="1"), indent=2)+"\n")
PY
  # 'repack' is the shared Lima bundle assembler in this mode. The engine
  # comes only from the freshly compiled app on this mount.
  LIMA_SOURCE_APP="$app" LIMA_SOURCE_MANIFEST="$manifest" "$BROWSER/scripts/repack.sh"
  cleanup
  trap - EXIT
}

case "$PHASE" in
  all) prepare; build; package ;;
  prepare) prepare ;;
  build) prepare; build ;;
  package) package ;;
esac
