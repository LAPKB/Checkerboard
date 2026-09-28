#!/usr/bin/env bash
set -euo pipefail

target="${1:?usage: build-container-candidate.sh <target>}"
case "$target" in
x86_64-pc-windows-msvc | aarch64-pc-windows-msvc)
  kind=windows
  platform=linux/amd64
  target_argument=WINDOWS_TARGET
  ;;
x86_64-unknown-linux-gnu)
  kind=linux
  platform=linux/amd64
  target_argument=LINUX_TARGET
  [[ "$(uname -m)" == x86_64 ]] || {
    printf 'Linux target requires a native x64 runner\n' >&2
    exit 2
  }
  ;;
aarch64-unknown-linux-gnu)
  kind=linux
  platform=linux/arm64
  target_argument=LINUX_TARGET
  [[ "$(uname -m)" == aarch64 || "$(uname -m)" == arm64 ]] || {
    printf 'Linux target requires a native ARM64 runner\n' >&2
    exit 2
  }
  ;;
*)
  printf 'Unsupported container target: %s\n' "$target" >&2
  exit 2
  ;;
esac
artifact_prefix=checkmate-artifacts
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_RUN_ATTEMPT:?GITHUB_RUN_ATTEMPT is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
repo_root="$(git rev-parse --show-toplevel)"
runner_temp_real="$(realpath -e -- "$RUNNER_TEMP")"
runner_uid="$(id -u)"
runner_gid="$(id -g)"
: "${CHECKMATE_SOURCE_SHA:?CHECKMATE_SOURCE_SHA is required}"
[[ "$(git rev-parse HEAD)" == "$CHECKMATE_SOURCE_SHA" ]] || { echo 'Unexpected source commit' >&2; exit 1; }
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG BUILDX_CONFIG SSH_AUTH_SOCK SSH_AGENT_PID

private_config=''
artifact_dir=''
config_identity=''
artifact_identity=''
config_created=0
artifact_created=0
config_chown_attempted=0
artifact_chown_attempted=0
artifact_may_be_root=0
build_succeeded=0
builder_creation_started=0
builder=''
docker_mode=''
docker_argv=()

validate_private_dir() {
  local path="$1" prefix="$2" identity="$3" owner_mode="${4:-runner}"
  python3 "$repo_root/scripts/ci/owned-temp-dir.py" validate \
    "$runner_temp_real" "$path" "$prefix" "$identity" "$owner_mode"
}

restore_private_dir_owner() {
  local path="$1" prefix="$2" identity="$3"
  if ! validate_private_dir "$path" "$prefix" "$identity" root-or-runner; then
    printf 'Refusing ownership change outside the validated private directory\n' >&2
    return 1
  fi
  if ! sudo -n -- /usr/bin/chown -R --no-dereference --from=0 "$runner_uid:$runner_gid" -- "$path"; then
    printf 'Scoped ownership restoration was denied for a job-private directory\n' >&2
    return 1
  fi
  if ! validate_private_dir "$path" "$prefix" "$identity" ||
    [[ "$(stat -c '%u:%g' -- "$path")" != "$runner_uid:$runner_gid" ]]; then
    printf 'Private directory ownership did not return to the runner\n' >&2
    return 1
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e

  if [[ "$builder_creation_started" == 1 ]]; then
    if ! "${docker_argv[@]}" buildx rm --force "$builder" >/dev/null; then
      printf "Could not remove this job's Buildx builder/cache: %s\n" "$builder" >&2
      status=1
    fi
  fi

  if [[ "$config_created" == 1 ]]; then
    if validate_private_dir "$private_config" checkmate-buildx "$config_identity" root-or-runner; then
      if [[ "$docker_mode" == sudo && "$config_chown_attempted" == 0 ]]; then
        config_chown_attempted=1
        if ! restore_private_dir_owner "$private_config" checkmate-buildx "$config_identity"; then
          status=1
        fi
      fi
      if ! python3 "$repo_root/scripts/ci/owned-temp-dir.py" cleanup \
        "$runner_temp_real" "$private_config" checkmate-buildx "$config_identity"; then
        status=1
      fi
    else
      printf 'Refusing cleanup of an unexpected Docker config path\n' >&2
      status=1
    fi
  fi

  if [[ "$artifact_created" == 1 && "$build_succeeded" != 1 ]]; then
    if validate_private_dir "$artifact_dir" "$artifact_prefix" "$artifact_identity" root-or-runner; then
      if [[ "$docker_mode" == sudo && "$artifact_may_be_root" == 1 && "$artifact_chown_attempted" == 0 ]]; then
        artifact_chown_attempted=1
        if ! restore_private_dir_owner "$artifact_dir" "$artifact_prefix" "$artifact_identity"; then
          status=1
        fi
      fi
      if ! python3 "$repo_root/scripts/ci/owned-temp-dir.py" cleanup \
        "$runner_temp_real" "$artifact_dir" "$artifact_prefix" "$artifact_identity"; then
        status=1
      fi
    else
      printf 'Refusing cleanup of an unexpected container output path\n' >&2
      status=1
    fi
  fi

  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

private_config="$(mktemp -d "$runner_temp_real/checkmate-buildx.XXXXXXXXXX")"
config_created=1
config_identity="$(stat -c '%d:%i' -- "$private_config")"
chmod 700 "$private_config"
artifact_dir="$(mktemp -d "$runner_temp_real/$artifact_prefix.XXXXXXXXXX")"
artifact_created=1
artifact_identity="$(stat -c '%d:%i' -- "$artifact_dir")"
chmod 700 "$artifact_dir"
validate_private_dir "$private_config" checkmate-buildx "$config_identity"
validate_private_dir "$artifact_dir" "$artifact_prefix" "$artifact_identity"

random_suffix="$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')"
[[ "$random_suffix" =~ ^[0-9a-f]{32}$ ]] || {
  printf 'Could not create a unique builder suffix\n' >&2
  exit 1
}
builder="checkmate-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${target}-${random_suffix}"

docker_flags=(--host unix:///var/run/docker.sock --config "$private_config")
direct_docker_argv=(/usr/bin/docker "${docker_flags[@]}")
if "${direct_docker_argv[@]}" version >/dev/null 2>&1; then
  docker_argv=("${direct_docker_argv[@]}")
  docker_mode=direct
else
  docker_argv=(sudo -n -- /usr/bin/docker "${docker_flags[@]}")
  docker_mode=sudo
fi

cd "$repo_root"
case "$kind" in
  linux) dockerfile=scripts/ci/linux-native.Dockerfile ;;
  windows) dockerfile=scripts/ci/windows-cross.Dockerfile ;;
esac
builder_creation_started=1
"${docker_argv[@]}" buildx create --name "$builder" --driver docker-container >/dev/null
"${docker_argv[@]}" buildx inspect "$builder" --bootstrap >/dev/null
artifact_may_be_root=1
"${docker_argv[@]}" buildx build \
  --builder "$builder" \
  --platform "$platform" \
  --build-arg "$target_argument=$target" \
  --build-arg CARGO_BUILD_JOBS=2 \
  --output "type=local,dest=$artifact_dir" \
  --file "$dockerfile" \
  "$repo_root"

if [[ "$docker_mode" == sudo ]]; then
  artifact_chown_attempted=1
  restore_private_dir_owner "$artifact_dir" "$artifact_prefix" "$artifact_identity"
fi
if [[ "$kind" == windows ]]; then
  node scripts/ci/verify-windows-artifacts.mjs "$target" "$artifact_dir"
else
  node scripts/ci/verify-linux-artifacts.mjs "$target" "$artifact_dir" --receipt
fi
case "$artifact_dir" in
*$'\n'* | *$'\r'*)
  printf 'Invalid artifact output path\n' >&2
  exit 1
  ;;
esac
printf 'artifact_dir=%s\nartifact_identity=%s\n' "$artifact_dir" "$artifact_identity" >>"$GITHUB_OUTPUT"
build_succeeded=1
