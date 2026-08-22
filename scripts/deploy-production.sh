#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE="${CONTROL_PLANE_DEPLOY_HOST:-virya-crowdrelay}"
REMOTE_DIR="${CONTROL_PLANE_DEPLOY_REMOTE_DIR:-/srv/crowdrelay-control-plane}"
AREA_SOURCE="$ROOT_DIR/deploy/compose.area.production.yml"
REMOTE_AREA=""

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$REMOTE_AREA" ]]; then
    ssh -T "$REMOTE" "rm -f '$REMOTE_AREA'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command in git ssh scp; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

cd "$ROOT_DIR"
[[ -f "$AREA_SOURCE" && ! -L "$AREA_SOURCE" ]] || fail "missing canonical area overlay: $AREA_SOURCE"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'local worktree must be clean'
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$branch" == "main" ]] || fail "production deploy must run from main, got=${branch:-detached}"

HEAD_SHA="$(git rev-parse HEAD)"
TARGET="${1:-$HEAD_SHA}"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || fail 'target must be a full lowercase 40-character SHA'
[[ "$TARGET" == "$HEAD_SHA" ]] || fail "target must equal local HEAD: target=$TARGET head=$HEAD_SHA"
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "$REMOTE_MAIN" == "$TARGET" ]] || fail "origin/main mismatch: remote=$REMOTE_MAIN local=$TARGET"

REMOTE_AREA="/tmp/crowdrelay-control-plane-area-bootstrap-${TARGET}.yml"
scp -q "$AREA_SOURCE" "$REMOTE:$REMOTE_AREA"

ssh -T "$REMOTE" sudo bash -s -- "$REMOTE_DIR" "$REMOTE_AREA" <<'REMOTE_BOOTSTRAP'
set -Eeuo pipefail
umask 077
root="$1"
candidate="$2"
cd "$root"

for file in .env compose.production.yml "$candidate"; do
  [[ -f "$file" && ! -L "$file" ]] || {
    echo "ERROR: missing or unsafe bootstrap input: $file" >&2
    exit 1
  }
done
[[ "$(stat -c '%a' .env)" == "600" ]] || {
  echo 'ERROR: .env must have mode 600' >&2
  exit 1
}

docker compose -f compose.production.yml -f "$candidate" config --format json | python3 -c '
import json
import sys
model = json.load(sys.stdin)
app = model.get("services", {}).get("app", {})
env = app.get("environment") or {}
if isinstance(env, list):
    env = dict(item.split("=", 1) for item in env if isinstance(item, str) and "=" in item)
area_master = env.get("CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY")
master = env.get("CONTROL_PLANE_MANAGEMENT_MASTER_KEY")
url = env.get("CONTROL_PLANE_VIRYA_MANAGEMENT_URL")
if not isinstance(area_master, str) or not area_master:
    raise SystemExit("candidate overlay does not wire CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY")
if not isinstance(master, str) or not master:
    raise SystemExit("candidate overlay does not wire CONTROL_PLANE_MANAGEMENT_MASTER_KEY")
if url != "http://127.0.0.1:18080":
    raise SystemExit("candidate overlay has invalid CONTROL_PLANE_VIRYA_MANAGEMENT_URL")
'

install -m 0644 "$candidate" compose.area.yml
docker compose -f compose.production.yml -f compose.area.yml config --quiet
printf 'BOOTSTRAP_OVERLAY=PASS management_wiring=canonical runtime_restarted=false\n'
REMOTE_BOOTSTRAP

exec bash "$ROOT_DIR/scripts/deploy-production-exact.sh" "$@"
