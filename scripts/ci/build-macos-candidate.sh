#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: build-macos-candidate.sh <aarch64-apple-darwin|x86_64-apple-darwin> [app|dmg]}"
phase="${2:-app}"
case "$target" in
  aarch64-apple-darwin) expected_arch=arm64; target_label=ARM64 ;;
  x86_64-apple-darwin) expected_arch=x86_64; target_label=x64 ;;
  *) printf 'Unsupported macOS target: %s\n' "$target" >&2; exit 2 ;;
esac
case "$phase" in
  app) bundles=app ;;
  dmg) bundles=app,dmg ;;
  *) printf 'Unsupported macOS build phase: %s\n' "$phase" >&2; exit 2 ;;
esac

node scripts/ci/validate-pilot-inputs.mjs
(cd desktop && npm run tauri -- build --target "$target" --bundles "$bundles" \
  --features local-staging \
  --config '{"build":{"beforeBuildCommand":""},"bundle":{"macOS":{"signingIdentity":"-"}}}' \
  --ci -- --locked --offline)
bundle="${CARGO_TARGET_DIR:?CARGO_TARGET_DIR is required}/$target/release/bundle"
app="$bundle/macos/Checkmate.app"
plist="$app/Contents/Info.plist"
test -d "$app"
test -s "$plist"
executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
if [[ -z "$executable_name" || "$executable_name" == */* || "$executable_name" == . || "$executable_name" == .. ]]; then
  printf 'Invalid CFBundleExecutable in %s\n' "$plist" >&2
  exit 1
fi
executable="$app/Contents/MacOS/$executable_name"
test -s "$executable"
actual_arch="$(/usr/bin/lipo -archs "$executable")"
if [[ "$actual_arch" != "$expected_arch" ]]; then
  printf 'Packaged macOS executable architecture mismatch: expected %s, found %s\n' "$expected_arch" "$actual_arch" >&2
  exit 1
fi
/usr/bin/codesign --verify --deep --strict "$app"
if [[ "$phase" == app ]]; then
  # macOS metadata sidecars are not sealed app resources; do not add them to the archive.
  COPYFILE_DISABLE=1 tar --format=ustar -czf "$bundle/macos/Checkmate.app.tar.gz" -C "$bundle/macos" Checkmate.app
  test -s "$bundle/macos/Checkmate.app.tar.gz"
  printf '### macOS %s app build candidate\n\n- Ad-hoc signature verified for the app bundle.\n- Packaged Mach-O architecture: `%s` (verified with `lipo` from `CFBundleExecutable`).\n- Existing `Checkmate.app.tar.gz` installation archive created and verified non-empty.\n' \
    "$target_label" "$actual_arch" >> "$GITHUB_STEP_SUMMARY"
else
  shopt -s nullglob
  disks=("$bundle/dmg/"*.dmg)
  if (( ${#disks[@]} != 1 )) || [[ ! -s "${disks[0]}" ]]; then
    printf 'Expected exactly one non-empty macOS DMG in %s/dmg\n' "$bundle" >&2
    exit 1
  fi
  printf '### macOS %s DMG build candidate\n\n- Ad-hoc signature verified for the app bundle.\n- Packaged Mach-O architecture: `%s` (verified with `lipo` from `CFBundleExecutable`).\n- Exactly one non-empty DMG verified: `%s`.\n' \
    "$target_label" "$actual_arch" "${disks[0]}" >> "$GITHUB_STEP_SUMMARY"
fi
