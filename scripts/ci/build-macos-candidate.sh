#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: build-macos-candidate.sh <aarch64-apple-darwin|x86_64-apple-darwin>}"
case "$target" in
  aarch64-apple-darwin) expected_arch=arm64; target_label=ARM64; cross_note='ARM64 build; native runtime not exercised.' ;;
  x86_64-apple-darwin) expected_arch=x86_64; target_label=x64; cross_note='Intel build; native runtime not exercised.' ;;
  *) printf 'Unsupported macOS target: %s\n' "$target" >&2; exit 2 ;;
esac

(cd desktop && npm run tauri -- build --target "$target" --bundles app,dmg --features local-staging --config '{"build":{"beforeBuildCommand":""}}' --ci --no-sign -- --locked --offline)
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
shopt -s nullglob
disks=("$bundle/dmg/"*.dmg)
if (( ${#disks[@]} != 1 )) || [[ ! -s "${disks[0]}" ]]; then
  printf 'Expected exactly one non-empty macOS DMG in %s/dmg\n' "$bundle" >&2
  exit 1
fi
tar -czf "$bundle/macos/Checkmate.app.tar.gz" -C "$bundle/macos" Checkmate.app
test -s "$bundle/macos/Checkmate.app.tar.gz"
printf '### Unsigned macOS %s build candidate\n\n- Existing public staging verifier configuration is embedded; live licensing and runtime acceptance are not established.\n- No code signing or notarization.\n- Packaged Mach-O architecture: `%s` (verified with `lipo` from `CFBundleExecutable`).\n- %s\n- The `.app.tar.gz` updater-format archive is unsigned and not update-ready.\n' \
  "$target_label" "$actual_arch" "$cross_note" >> "$GITHUB_STEP_SUMMARY"
