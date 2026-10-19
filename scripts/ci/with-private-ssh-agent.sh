#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${LAPKB_SDK_READ_KEY:?LAPKB_SDK_READ_KEY is required}"
: "${LAPKB_PROTOCOL_READ_KEY:?LAPKB_PROTOCOL_READ_KEY is required}"
(( $# > 0 )) || { printf 'usage: with-private-ssh-agent.sh <command> [args...]\n' >&2; exit 2; }

repo_root="$(git rev-parse --show-toplevel)"
ssh_binary="$(command -v ssh)"
runner_temp="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve(strict=True))' "$RUNNER_TEMP")"
ssh_dir="$(mktemp -d "$runner_temp/checkmate-ssh.XXXXXXXXXX")"
chmod 700 "$ssh_dir"
ssh_dir="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve(strict=True))' "$ssh_dir")"
ssh_dir_identity="$(python3 - "$ssh_dir" <<'PY'
import os, stat, sys
path = sys.argv[1]
info = os.lstat(path)
if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit('private SSH directory failed its ownership or mode check')
print(f'{info.st_dev}:{info.st_ino}')
PY
)"
agent_started=0
dir_created=1

validate_ssh_dir() {
  python3 - "$RUNNER_TEMP" "$ssh_dir" "$ssh_dir_identity" <<'PY'
import os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
path = pathlib.Path(sys.argv[2])
try:
    info = os.lstat(path)
    resolved = path.resolve(strict=True)
except OSError:
    raise SystemExit(1)
if (stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
        and str(resolved) == str(path) and path.parent == root
        and path.name.startswith('checkmate-ssh.')
        and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == 0o700
        and f'{info.st_dev}:{info.st_ino}' == sys.argv[3]):
    raise SystemExit(0)
raise SystemExit(1)
PY
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  set +e
  if [[ "$agent_started" == 1 ]]; then
    if ! python3 - "$ssh_dir/a" "$SSH_AUTH_SOCK" <<'PY'
import os, pathlib, stat, sys
expected, actual = sys.argv[1:]
try:
    info = os.lstat(actual)
    valid = (not stat.S_ISLNK(info.st_mode) and stat.S_ISSOCK(info.st_mode)
             and info.st_uid == os.getuid()
             and pathlib.Path(actual).resolve(strict=True) == pathlib.Path(expected).resolve(strict=True))
except OSError:
    valid = False
if not valid:
    raise SystemExit(1)
PY
    then
      printf "Refusing to stop an unexpected SSH agent\n" >&2
      status=1
    elif ! ssh-agent -k >/dev/null 2>&1; then
      printf "Could not stop this job's private SSH agent\n" >&2
      status=1
    fi
  fi
  if [[ "$dir_created" == 1 ]]; then
    if validate_ssh_dir; then
      if ! rm -rf -- "$ssh_dir"; then
        printf "Could not remove this job's private SSH directory\n" >&2
        status=1
      fi
    else
      printf 'Refusing cleanup of an unexpected private SSH directory\n' >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s\n' "$LAPKB_SDK_READ_KEY" > "$ssh_dir/sdk"
printf '%s\n' "$LAPKB_PROTOCOL_READ_KEY" > "$ssh_dir/protocol"
unset LAPKB_SDK_READ_KEY LAPKB_PROTOCOL_READ_KEY
chmod 600 "$ssh_dir/sdk" "$ssh_dir/protocol"
ssh-keygen -y -P '' -f "$ssh_dir/sdk" > "$ssh_dir/sdk.pub"
ssh-keygen -y -P '' -f "$ssh_dir/protocol" > "$ssh_dir/protocol.pub"
chmod 600 "$ssh_dir/sdk.pub" "$ssh_dir/protocol.pub"

unset SSH_AUTH_SOCK SSH_AGENT_PID
agent_output="$(ssh-agent -a "$ssh_dir/a" -s 2>/dev/null)"
eval "$agent_output" >/dev/null
agent_started=1
if [[ "${SSH_AUTH_SOCK:-}" != "$ssh_dir/a" ]]; then
  printf 'SSH agent did not bind its private socket\n' >&2
  exit 1
fi
python3 - "$SSH_AUTH_SOCK" <<'PY'
import os, stat, sys
path = sys.argv[1]
info = os.lstat(path)
if not stat.S_ISSOCK(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid():
    raise SystemExit('SSH agent socket failed its ownership check')
PY
ssh-add -q "$ssh_dir/sdk" "$ssh_dir/protocol"
ssh-add -L > "$ssh_dir/agent-identities"
chmod 600 "$ssh_dir/agent-identities"
python3 - "$SSH_AUTH_SOCK" "$ssh_dir" "$RUNNER_TEMP" "$repo_root" "$ssh_binary" <<'PY'
import re, sys
for value in sys.argv[1:]:
    if not re.fullmatch(r'[A-Za-z0-9_./:-]+', value):
        raise SystemExit('runner paths contain unsupported characters')
PY
node "$repo_root/scripts/ci/configure-private-git.mjs" \
  "$ssh_dir/sdk.pub" "$ssh_dir/protocol.pub" "$ssh_dir/agent-identities" \
  "$ssh_dir/config" "$ssh_dir/gitconfig" "$ssh_dir/known_hosts" "$SSH_AUTH_SOCK"

export LAPKB_SDK_PUBLIC_KEY_FILE="$ssh_dir/sdk.pub"
export LAPKB_PROTOCOL_PUBLIC_KEY_FILE="$ssh_dir/protocol.pub"
export LAPKB_PRIVATE_SSH_CONFIG="$ssh_dir/config"
export LAPKB_SSH_BINARY="$ssh_binary"
export GIT_SSH_COMMAND="node \"$repo_root/scripts/ci/repo-ssh.mjs\""
export GIT_SSH_VARIANT=ssh
export GIT_CONFIG_GLOBAL="$ssh_dir/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
unset GIT_SSH
"$@"
