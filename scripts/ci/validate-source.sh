#!/usr/bin/env bash
set -euo pipefail

source_sha="${1:?usage: validate-source.sh <full-source-sha>}"
: "${CHECKMATE_REQUESTED_SOURCE_SHA:?CHECKMATE_REQUESTED_SOURCE_SHA is required}"
: "${GITHUB_REF:?GITHUB_REF is required}"
[[ "$source_sha" == "$CHECKMATE_REQUESTED_SOURCE_SHA" ]] || { printf 'Source SHA does not match the required manual input\n' >&2; exit 1; }
[[ "$GITHUB_REF" == refs/heads/launcher-checkmate-support ]] || { printf 'Manual candidate builds must be dispatched from the launcher-checkmate-support integration branch\n' >&2; exit 1; }
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || { printf 'Source SHA must be a full 40-character commit\n' >&2; exit 1; }
head_sha="$(git rev-parse HEAD)"
[[ "$head_sha" == "$source_sha" ]] || { printf 'Checked-out source does not match the requested source SHA\n' >&2; exit 1; }
git show-ref --verify --quiet refs/remotes/origin/launcher-checkmate-support || { printf 'Fetched launcher-checkmate-support integration branch ref is missing\n' >&2; exit 1; }
git merge-base --is-ancestor "$source_sha" refs/remotes/origin/launcher-checkmate-support || { printf 'Requested source SHA is not reachable from origin/launcher-checkmate-support\n' >&2; exit 1; }
printf 'Verified full source commit %s is on origin/launcher-checkmate-support.\n' "$source_sha"
