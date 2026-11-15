#!/usr/bin/env bash
# Local development build of Lima Browser.
#
# Repacks the pinned, checksum-verified Zen release with Lima's identity,
# chrome overlay, launcher and native host. This keeps Zen's compiled Gecko
# patches intact (a Firefox artifact build would not) and needs ~1 GB of
# disk instead of a full Gecko compile. Release builds come from source in
# CI — see docs/architecture/build.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BROWSER="$ROOT/browser"
LOCK="$BROWSER/lima.lock.json"
CACHE="$BROWSER/.cache"
OUT="$ROOT/build"
APP="$OUT/Lima.app"

lock() { python3 -c "import json,sys; d=json.load(open('$LOCK')); print(eval('d'+sys.argv[1]))" "$1"; }

ZEN_TAG="$(lock "['zen']['tag']")"
DMG_NAME="$(lock "['zen']['macosDmg']['asset']")"
DMG_SHA="$(lock "['zen']['macosDmg']['sha256']")"
GECKO_VERSION="$(lock "['zen']['firefoxVersion']")"
BUNDLE_ID="$(lock "['lima']['bundleIdentifier']")"
DISPLAY_NAME="$(lock "['lima']['displayName']")"
LIMA_VERSION="5.0.0-dev+zen.${ZEN_TAG}"
SOURCE_STAMP="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_ID="$(date -u +%Y%m%d%H%M%S)"

step() { printf '\033[1m==> %s\033[0m\n' "$*"; }

# 1. Fetch and verify the pinned Zen release.
mkdir -p "$CACHE"
DMG="$CACHE/zen-${ZEN_TAG}.dmg"
if [[ ! -f "$DMG" ]] || [[ "$(shasum -a 256 "$DMG" | cut -d' ' -f1)" != "$DMG_SHA" ]]; then
  step "Downloading Zen $ZEN_TAG"
  rm -f "$DMG"
  gh release download "$ZEN_TAG" -R zen-browser/desktop -p "$DMG_NAME" -O "$DMG"
fi
ACTUAL_SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
if [[ "$ACTUAL_SHA" != "$DMG_SHA" ]]; then
  echo "error: $DMG_NAME checksum mismatch (expected $DMG_SHA, got $ACTUAL_SHA)" >&2
  exit 1
fi

# 2. Build native components.
step "Building lima-host"
swift build -c release --package-path "$ROOT/native" --product lima-host
HOST_BIN="$(swift build -c release --package-path "$ROOT/native" --show-bin-path)/lima-host"

step "Building launcher"
mkdir -p "$OUT"
clang -O2 -Wall -Werror -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
  -o "$OUT/lima-launcher" "$BROWSER/launcher/lima-launcher.c"

# 3. Extract the engine.
step "Extracting Zen.app"
rm -rf "$APP"
MOUNT="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null
trap 'hdiutil detach -quiet "$MOUNT" 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true' EXIT
ditto "$MOUNT/Zen.app" "$APP"
hdiutil detach -quiet "$MOUNT"
trap - EXIT
rmdir "$MOUNT"

C="$APP/Contents"
R="$C/Resources"

# 4. Apply Lima identity and overlay.
step "Applying Lima overlay"
sed -e "s/@LIMA_VERSION@/$LIMA_VERSION/" -e "s/@BUILD_ID@/$BUILD_ID/" \
    -e "s/@SOURCE_STAMP@/$SOURCE_STAMP/" -e "s/@GECKO_VERSION@/$GECKO_VERSION/g" \
    "$BROWSER/overlay/application.ini" > "$R/browser/application.ini"
mkdir -p "$R/defaults/pref" "$R/distribution"
cp "$BROWSER/overlay/defaults/pref/lima-autoconfig.js" "$R/defaults/pref/"
cp "$BROWSER/overlay/lima.cfg" "$R/lima.cfg"
cp "$BROWSER/overlay/distribution/policies.json" "$R/distribution/policies.json"
ditto "$BROWSER/overlay/lima" "$R/lima"
python3 "$BROWSER/scripts/bundle_ui.py" "$BROWSER/overlay/lima/ui" "$R/lima/ui/bundle.js"
cp "$ROOT/legacy/lima-4/Packaging/RayPlacement.icns" "$R/lima.icns"

install -m 0755 "$OUT/lima-launcher" "$C/MacOS/lima"
install -m 0755 "$HOST_BIN" "$C/MacOS/lima-host"
mkdir -p "$R/lima-runtime"
cp "$ROOT/native/Sources/LimaRuntime/Resources/emoji-test.txt" "$R/lima-runtime/"

PLIST="$C/Info.plist"
plutil -replace CFBundleExecutable -string lima "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "$DISPLAY_NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$DISPLAY_NAME" "$PLIST"
plutil -replace CFBundleIconFile -string lima.icns "$PLIST"
plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
plutil -replace CFBundleShortVersionString -string "5.0.0" "$PLIST"
plutil -replace LimaEngine -string "zen ${ZEN_TAG} / gecko ${GECKO_VERSION}" "$PLIST"

# Zen's provisioning profile and signature belong to Zen's team.
rm -f "$C/embedded.provisionprofile"

# 5. Sign. Ad-hoc for local development; CI signs with the Lima identity.
step "Signing (${LIMA_SIGN_IDENTITY:-ad-hoc})"
xattr -cr "$APP"
codesign --force --deep --sign "${LIMA_SIGN_IDENTITY:--}" "$APP"
codesign --verify --deep --strict "$APP"

step "Built $APP"
echo "    engine: Zen $ZEN_TAG (Firefox $GECKO_VERSION)"
echo "    version: $LIMA_VERSION"
