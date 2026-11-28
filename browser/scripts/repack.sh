#!/usr/bin/env bash
# Builds Lima.app by repacking the pinned Zen release.
#
# Repacks the pinned Zen release (verified by SHA-256 *and* by Zen's
# notarized Developer ID signature) with Lima's identity, chrome overlay,
# launcher and native host, then signs every binary inside-out with the
# hardened runtime. Development and release builds run the same code; a
# release (LIMA_RELEASE=1) adds the pinned signing identity, the update feed
# and locked-down debugging prefs. See docs/architecture/build.md.
#
#   LIMA_RELEASE=1          release build (requires LIMA_SIGN_IDENTITY)
#   LIMA_SIGN_IDENTITY      codesign identity (default: ad-hoc "-")
#   LIMA_SIGN_KEYCHAIN      keychain holding that identity
#   LIMA_BUILD_DIR          output directory (default: build/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BROWSER="$ROOT/browser"
LOCK="$BROWSER/lima.lock.json"
POLICY="${LIMA_RELEASE_POLICY:-$BROWSER/release.json}"
CACHE="$BROWSER/.cache"
OUT="${LIMA_BUILD_DIR:-$ROOT/build}"
APP="$OUT/Lima.app"
RELEASE="${LIMA_RELEASE:-0}"
IDENTITY="${LIMA_SIGN_IDENTITY:--}"
SOURCE_APP="${LIMA_SOURCE_APP:-}"

json() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval('d'+sys.argv[2]))" "$1" "$2"; }
step() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

ZEN_TAG="$(json "$LOCK" "['zen']['tag']")"
ZEN_TEAM="$(json "$LOCK" "['zen']['signingTeam']")"
DMG_NAME="$(json "$LOCK" "['zen']['macosDmg']['asset']")"
DMG_SHA="$(json "$LOCK" "['zen']['macosDmg']['sha256']")"
GECKO_VERSION="$(json "$LOCK" "['zen']['firefoxVersion']")"
BUNDLE_ID="$(json "$LOCK" "['lima']['bundleIdentifier']")"
DISPLAY_NAME="$(json "$LOCK" "['lima']['displayName']")"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
[[ "$VERSION" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail "VERSION must be X.Y.Z (got $VERSION)"
BUILD_NUMBER="$(printf '%d%03d%03d' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")"
SOURCE_STAMP="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
BUILD_ID="$(date -u +%Y%m%d%H%M%S)"

if [[ "$RELEASE" == 1 ]]; then
  [[ "$IDENTITY" != "-" ]] || fail "release builds need LIMA_SIGN_IDENTITY"
  [[ "$IDENTITY" == "$(json "$POLICY" "['signing']['identity']")" ]] || fail "LIMA_SIGN_IDENTITY is not the pinned release identity"
  CERT_SHA="$(json "$POLICY" "['signing']['certificateSHA256']")"
  SIGN_MODE="$(json "$POLICY" "['signing']['mode']")"
  TEAM="$(json "$POLICY" "['signing'].get('developerTeam', '')")"
  [[ -z "$TEAM" || "$TEAM" =~ ^[A-Z0-9]{10}$ ]] || fail "browser/release.json signing.developerTeam must be a 10-character Team ID"
  [[ "$SIGN_MODE" != developer-id || -n "$TEAM" ]] || fail "developer-id signing needs signing.developerTeam"
  FEED_URL="$(json "$POLICY" "['updates']['feedURL']")"
  UPDATE_KEY="$(json "$POLICY" "['updates']['publicKey']")"
  [[ "$FEED_URL" == https://* ]] || fail "browser/release.json updates.feedURL must be an https URL"
  [[ -n "$UPDATE_KEY" ]] || fail "browser/release.json updates.publicKey is empty (run browser/scripts/release/setup_update_key.sh)"
  APP_VERSION="$VERSION"
else
  APP_VERSION="$VERSION-dev+zen.$ZEN_TAG"
fi

# 1. Fetch the pinned Zen release and prove where it came from.
mkdir -p "$CACHE"
DMG="$CACHE/zen-${ZEN_TAG}.dmg"
if [[ -z "$SOURCE_APP" ]]; then
if [[ ! -f "$DMG" ]] || [[ "$(shasum -a 256 "$DMG" | cut -d' ' -f1)" != "$DMG_SHA" ]]; then
  step "Downloading Zen $ZEN_TAG"
  rm -f "$DMG"
  gh release download "$ZEN_TAG" -R zen-browser/desktop -p "$DMG_NAME" -O "$DMG"
fi
ACTUAL_SHA="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
[[ "$ACTUAL_SHA" == "$DMG_SHA" ]] || fail "$DMG_NAME checksum mismatch (expected $DMG_SHA, got $ACTUAL_SHA)"
fi

# 2. Verify third-party files Lima copies into the bundle.
step "Verifying vendored assets"
python3 - "$ROOT" "$BROWSER/vendor-assets.json" <<'PY'
import hashlib, json, os, sys
root, manifest = sys.argv[1], json.load(open(sys.argv[2]))
assert manifest.get("schemaVersion") == 1, "unsupported vendor manifest"
bad = []
for name, asset in manifest["assets"].items():
    path = os.path.join(root, asset["path"])
    if os.path.islink(path) or not os.path.isfile(path):
        bad.append(f"{name}: missing or a symlink ({asset['path']})")
        continue
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    if digest != asset["sha256"]:
        bad.append(f"{name}: sha256 {digest} != pinned {asset['sha256']}")
if bad:
    sys.exit("error: vendored assets changed:\n  " + "\n  ".join(bad))
print(f"    {len(manifest['assets'])} assets match their pins")
PY

# 3. Build native components.
step "Building lima-host"
swift build -c release --package-path "$ROOT/native" --product lima-host
HOST_BIN="$(swift build -c release --package-path "$ROOT/native" --show-bin-path)/lima-host"

mkdir -p "$OUT"
# A compiled engine carries Lima's name, profile and remoting identity
# itself; only the repacked Zen engine needs the -app launcher.
if [[ -z "$SOURCE_APP" ]]; then
  step "Building launcher"
  clang -O2 -Wall -Werror -arch arm64 -arch x86_64 -mmacosx-version-min=12.0 \
    -o "$OUT/lima-launcher" "$BROWSER/launcher/lima-launcher.c"
fi

# 4. Extract the engine after checking Zen's own signature and notarization.
ENTITLEMENTS="$OUT/zen-entitlements.json"
if [[ -n "$SOURCE_APP" ]]; then
  step "Verifying the compiled Gecko input"
  python3 "$BROWSER/scripts/verify_source_bundle.py" "$SOURCE_APP" "${LIMA_SOURCE_MANIFEST:?}" "$RELEASE"
  python3 "$BROWSER/scripts/lima_codesign.py" capture "$SOURCE_APP" "$ENTITLEMENTS"
  rm -rf "$APP"
  ditto "$SOURCE_APP" "$APP"
else
step "Verifying and extracting Zen.app"
rm -rf "$APP"
MOUNT="$(mktemp -d)"
cleanup_mount() { hdiutil detach -quiet "$MOUNT" 2>/dev/null || true; rmdir "$MOUNT" 2>/dev/null || true; }
trap cleanup_mount EXIT
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MOUNT" "$DMG" >/dev/null
# (Not --strict: Zen's DMG carries Finder metadata; Lima's own output is verified strictly below.)
codesign --verify --deep \
  -R="anchor apple generic and certificate leaf[subject.OU] = \"$ZEN_TEAM\"" "$MOUNT/Zen.app" \
  || fail "Zen.app is not signed by Zen's Developer ID team $ZEN_TEAM"
if ASSESSMENT="$(spctl --assess --type execute -vv "$MOUNT/Zen.app" 2>&1)" && grep -q "source=Notarized Developer ID" <<<"$ASSESSMENT"; then
  echo "    Zen.app: Developer ID $ZEN_TEAM, notarized"
elif [[ "$RELEASE" == 1 ]]; then
  fail "Zen.app notarization could not be confirmed: $ASSESSMENT"
else
  echo "    warning: notarization not confirmed (offline?): $ASSESSMENT"
fi
python3 "$BROWSER/scripts/lima_codesign.py" capture "$MOUNT/Zen.app" "$ENTITLEMENTS"
ditto "$MOUNT/Zen.app" "$APP"
cleanup_mount
trap - EXIT
# Zen's name, logos, links and default URLs live in its omni.ja archives.
step "Rebranding the engine's strings and assets"
python3 "$BROWSER/scripts/rebrand_omni.py" "$APP"
fi

C="$APP/Contents"
R="$C/Resources"

# 5. Apply Lima identity and overlay.
step "Applying Lima overlay"
mkdir -p "$R/defaults/pref" "$R/distribution"
if [[ -z "$SOURCE_APP" ]]; then
sed -e "s/@LIMA_VERSION@/$APP_VERSION/" -e "s/@BUILD_ID@/$BUILD_ID/" \
    -e "s/@SOURCE_STAMP@/$SOURCE_STAMP/" -e "s/@GECKO_VERSION@/$GECKO_VERSION/g" \
    "$BROWSER/overlay/application.ini" > "$R/browser/application.ini"
cp "$BROWSER/overlay/defaults/pref/lima-autoconfig.js" "$R/defaults/pref/"
cp "$BROWSER/overlay/lima.cfg" "$R/lima.cfg"
if [[ "$RELEASE" == 1 ]]; then
  cat "$BROWSER/source/hardened.js" >> "$R/lima.cfg"
fi
else
  cp "$LIMA_SOURCE_MANIFEST" "$R/lima-source.json"
fi
cp "$BROWSER/overlay/distribution/policies.json" "$R/distribution/policies.json"
if [[ "$RELEASE" == 1 && -n "${LIMA_RELEASE_NOTES_FILE:-}" ]]; then
  cp "$LIMA_RELEASE_NOTES_FILE" "$R/lima-release-notes.md"
fi

ditto "$BROWSER/overlay/lima" "$R/lima"
python3 "$BROWSER/scripts/bundle_ui.py" "$BROWSER/overlay/lima/ui" "$R/lima/ui/bundle.js"
ICON_STAGE="$(mktemp -d)"
ICON_SET="$ICON_STAGE/Lima.iconset"
mkdir "$ICON_SET"
trap 'rm -rf "$ICON_STAGE"' EXIT
sips -s format png "$BROWSER/branding/lima-app-icon.svg" --out "$ICON_STAGE/master.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_STAGE/master.png" --out "$ICON_SET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$ICON_STAGE/master.png" --out "$ICON_SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICON_SET" -o "$R/lima.icns"
sips -s format png "$BROWSER/branding/grammar.svg" --out "$R/lima/ui/marks/grammar-mascot.png" >/dev/null
# Dock "working" badge: twelve frames of a dot wave, plus a "done" check,
# in light and dark palettes (LimaDockBadge picks one by appearance).
for theme in light dark; do
  if [[ "$theme" == light ]]; then palette=(-e "s/BUBBLE/#3a3a3a/" -e "s/EDGE/#ffffff/" -e "s/DOT/#ffffff/")
  else palette=(-e "s/BUBBLE/#ececec/" -e "s/EDGE/#1c1c1d/" -e "s/DOT/#1c1c1d/"); fi
  for frame in $(seq 0 11); do
    read -r ya ra yb rb yc rc < <(awk -v f="$frame" 'BEGIN {
      for (i = 0; i < 3; i++) { w = sin(6.2832 * f / 12 - i * 0.95); if (w < 0) w = 0
        printf "%.1f %.1f ", 46 - 6 * w, 4.6 + 2.4 * w }; print "" }')
    sed "${palette[@]}" -e "s/YA/$ya/" -e "s/RA/$ra/" -e "s/YB/$yb/" -e "s/RB/$rb/" -e "s/YC/$yc/" -e "s/RC/$rc/" \
      "$BROWSER/branding/dock-chat.svg" > "$ICON_STAGE/frame.svg"
    sips -s format png "$ICON_STAGE/frame.svg" --out "$R/lima/ui/marks/dock-$theme-$frame.png" >/dev/null
  done
  sed "${palette[@]}" "$BROWSER/branding/dock-done.svg" > "$ICON_STAGE/done.svg"
  sips -s format png "$ICON_STAGE/done.svg" --out "$R/lima/ui/marks/dock-$theme-done.png" >/dev/null
done
rm -rf "$ICON_STAGE"
trap - EXIT

if [[ -z "$SOURCE_APP" ]]; then
  install -m 0755 "$OUT/lima-launcher" "$C/MacOS/lima"
fi
[[ -z "$SOURCE_APP" || ! -e "$C/MacOS/zen" ]] || fail "A source-built engine must not carry Contents/MacOS/zen"
install -m 0755 "$HOST_BIN" "$C/MacOS/lima-host"
# On-device dictation: the whisper-cli 4.x shipped (pinned in vendor-assets.json).
# The 466 MB model isn't copied; the runtime finds the one Lima 4 installed.
mkdir -p "$R/Whisper/runtime"
install -m 0755 "$BROWSER/vendor/whisper/whisper-cli" "$R/Whisper/runtime/whisper-cli"
# MIT requires the notice to travel with the binary.
install -m 0644 "$BROWSER/vendor/whisper/LICENSE" "$R/Whisper/runtime/LICENSE"
mkdir -p "$R/lima-runtime"
cp "$ROOT/native/Sources/LimaRuntime/Resources/emoji-test.txt" "$R/lima-runtime/"

PLIST="$C/Info.plist"
HOST_PLIST="$ROOT/native/Sources/LimaHost/Support/Info.plist"
plutil -replace CFBundleExecutable -string lima "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "$DISPLAY_NAME" "$PLIST"
plutil -replace CFBundleDisplayName -string "$DISPLAY_NAME" "$PLIST"
while IFS= read -r -d '' localized; do
  plutil -convert xml1 "$localized"
  plutil -replace CFBundleName -string "$DISPLAY_NAME" "$localized"
done < <(find "$R" -maxdepth 2 -path '*.lproj/InfoPlist.strings' -print0)

plutil -replace CFBundleIconFile -string lima.icns "$PLIST"
plutil -remove CFBundleIconName "$PLIST" 2>/dev/null || true
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$BUILD_NUMBER" "$PLIST"
if [[ -n "$SOURCE_APP" ]]; then
  ENGINE_LABEL="lima source $(json "$LOCK" "['zen']['commit']" | cut -c1-12) / gecko ${GECKO_VERSION}"
else
  ENGINE_LABEL="zen ${ZEN_TAG} / gecko ${GECKO_VERSION}"
fi
plutil -replace LimaEngine -string "$ENGINE_LABEL" "$PLIST"
plutil -replace LimaSourceCommit -string "$SOURCE_STAMP" "$PLIST"
# Lima's runtime asks for these through the app, so the app must explain them.
for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription NSAppleEventsUsageDescription \
           NSCalendarsFullAccessUsageDescription NSRemindersFullAccessUsageDescription; do
  plutil -replace "$key" -string "$(plutil -extract "$key" raw "$HOST_PLIST")" "$PLIST"
done
# The browser owns location requests for websites and for Lima itself.
for key in NSLocationUsageDescription NSLocationWhenInUseUsageDescription NSLocationAlwaysAndWhenInUseUsageDescription; do
  plutil -replace "$key" -string "Lima uses location for sites you allow and for one-time Lima requests you approve." "$PLIST"
done
plutil -replace NSCameraUsageDescription -string "Only sites you allow in Lima can use the camera." "$PLIST"
plutil -remove SUFeedURL "$PLIST" 2>/dev/null || true
# Firefox asks macOS to quarantine every file the app (and anything it
# launches) writes. Workspace agents build and run code, so their compilers'
# output (SwiftPM's manifest runner, test binaries, CLIs) was quarantined and
# Gatekeeper refused to run it. Downloads are still quarantined: Gecko marks
# each finished download itself (DownloadPlatform).
plutil -remove LSFileQuarantineEnabled "$PLIST" 2>/dev/null || true
if [[ "$RELEASE" == 1 ]]; then
  plutil -replace LimaUpdateFeedURL -string "$FEED_URL" "$PLIST"
  plutil -replace LimaUpdatePublicKey -string "$UPDATE_KEY" "$PLIST"
  # Updates and the runtime also trust this team's Developer ID signature.
  if [[ -n "$TEAM" ]]; then plutil -replace LimaTrustedTeam -string "$TEAM" "$PLIST"; else plutil -remove LimaTrustedTeam "$PLIST" 2>/dev/null || true; fi
else
  plutil -remove LimaTrustedTeam "$PLIST" 2>/dev/null || true
  # Development builds don't offer to open web links, so they never appear in
  # macOS's default-browser list beside the installed Lima (each build would
  # show up as another "Lima (5.0.x)"). LIMA_DEV_LINKS=1 keeps them for
  # testing the default-browser flow.
  if [[ "${LIMA_DEV_LINKS:-0}" != 1 ]]; then
    plutil -remove CFBundleURLTypes "$PLIST" 2>/dev/null || true
    plutil -remove CFBundleDocumentTypes "$PLIST" 2>/dev/null || true
  fi
  plutil -remove LimaUpdateFeedURL "$PLIST" 2>/dev/null || true
  plutil -remove LimaUpdatePublicKey "$PLIST" 2>/dev/null || true
fi

# Zen's provisioning profile and signature belong to Zen's team.
rm -f "$C/embedded.provisionprofile"
# Lima's own profile (from Apple, for Lima's App ID) turns on iCloud Keychain
# and phone passkeys. It only fits a Developer ID signature from that team,
# so local ad-hoc builds go without it (security keys still work there).
LIMA_PROFILE="${LIMA_PROVISIONING_PROFILE:-$BROWSER/signing/Lima.provisionprofile}"
if [[ -f "$LIMA_PROFILE" && "${SIGN_MODE:-}" == developer-id ]]; then
  cp "$LIMA_PROFILE" "$C/embedded.provisionprofile"
  echo "    passkeys: signing with $(basename "$LIMA_PROFILE")"
fi

# 6. Sign inside-out with the hardened runtime, then verify the result.
step "Signing (${IDENTITY/#-/ad-hoc})"
python3 "$BROWSER/scripts/lima_codesign.py" sign "$APP" "$ENTITLEMENTS" \
  --identity "$IDENTITY" ${LIMA_SIGN_KEYCHAIN:+--keychain "$LIMA_SIGN_KEYCHAIN"} \
  ${SIGN_MODE:+--mode-"$SIGN_MODE"}
python3 "$BROWSER/scripts/lima_codesign.py" verify "$APP" "$ENTITLEMENTS" ${CERT_SHA:+--certificate-sha256 "$CERT_SHA"}

step "Built $APP"
echo "    engine:  $ENGINE_LABEL"
echo "    version: $APP_VERSION ($BUILD_NUMBER)"
