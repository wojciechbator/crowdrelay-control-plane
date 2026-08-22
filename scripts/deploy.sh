#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TARGET="${1:-}"
WAIT_SECONDS="${CONTROL_PLANE_DEPLOY_WAIT_SECONDS:-3600}"
POLL_SECONDS="${CONTROL_PLANE_DEPLOY_POLL_SECONDS:-3}"
REMOTE="${CONTROL_PLANE_DEPLOY_HOST:-virya-crowdrelay}"
REMOTE_DIR="${CONTROL_PLANE_DEPLOY_REMOTE_DIR:-/srv/crowdrelay-control-plane}"
CANONICAL="$ROOT_DIR/scripts/deploy-production.sh"
CREDENTIAL_GATE="$ROOT_DIR/scripts/ensure-virya-management-credentials.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

for command in git gh ssh bash; do require "$command"; done
[[ "$WAIT_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'CONTROL_PLANE_DEPLOY_WAIT_SECONDS must be a positive integer'
[[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]] || fail 'CONTROL_PLANE_DEPLOY_POLL_SECONDS must be a positive integer'

cd "$ROOT_DIR"
[[ -f "$CANONICAL" && ! -L "$CANONICAL" ]] || fail "canonical deploy is missing or unsafe: $CANONICAL"
[[ -f "$CREDENTIAL_GATE" && ! -L "$CREDENTIAL_GATE" ]] || fail "management credential gate is missing or unsafe: $CREDENTIAL_GATE"
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'local worktree must be clean'
branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$branch" == "main" ]] || fail "make deploy must run from main, got=${branch:-detached}"

HEAD_SHA="$(git rev-parse HEAD)"
[[ -n "$TARGET" ]] || TARGET="$HEAD_SHA"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || fail 'target must be a full lowercase 40-character SHA'
[[ "$TARGET" == "$HEAD_SHA" ]] || fail "target must equal local HEAD: target=$TARGET head=$HEAD_SHA"
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "$REMOTE_MAIN" == "$TARGET" ]] || fail "origin/main mismatch: remote=$REMOTE_MAIN local=$TARGET"
REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
[[ -n "$REPO" ]] || fail 'cannot resolve GitHub repository'

wait_for_ci() {
  local deadline run_id last_notice artifact_dir release_sha digest
  deadline=$((SECONDS + WAIT_SECONDS))
  run_id=""
  last_notice=0
  printf '==> Waiting for CI for %s\n' "$TARGET"
  while (( SECONDS < deadline )); do
    run_id="$(gh run list --repo "$REPO" --workflow "CI" --branch main --commit "$TARGET" --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
    if [[ -n "$run_id" ]]; then
      printf 'CI_RUN=%s\n' "$run_id"
      gh run watch "$run_id" --repo "$REPO" --exit-status
      printf 'CI=PASS sha=%s\n' "$TARGET"

      artifact_dir="$(mktemp -d)"
      if ! gh run download "$run_id" --repo "$REPO" \
        --name "control-plane-image-digest-${TARGET}" --dir "$artifact_dir"; then
        rm -rf -- "$artifact_dir"
        fail "validated CI run is missing immutable image digest artifact for $TARGET"
      fi
      [[ -f "$artifact_dir/image.env" && -f "$artifact_dir/image.env.sha256" ]] || {
        rm -rf -- "$artifact_dir"
        fail 'image digest artifact is incomplete'
      }
      # Older artifacts recorded the checksum from the CI workspace, where the
      # file sat under image-digest/; upload-artifact flattens that directory
      # away, so `sha256sum -c` chases a path the download does not contain.
      # Compare the recorded digest against the file itself: identical
      # integrity guarantee, independent of where the checksum was generated.
      expected_sum="$(awk 'NR==1 {print $1}' "$artifact_dir/image.env.sha256")"
      actual_sum="$(sha256sum "$artifact_dir/image.env" | awk '{print $1}')"
      [[ "$expected_sum" =~ ^[0-9a-f]{64}$ ]] || {
        rm -rf -- "$artifact_dir"
        fail 'image digest artifact checksum is malformed'
      }
      [[ "$expected_sum" == "$actual_sum" ]] || {
        rm -rf -- "$artifact_dir"
        fail "image digest artifact checksum failed: recorded=$expected_sum actual=$actual_sum"
      }
      release_sha="$(sed -n 's/^CONTROL_PLANE_RELEASE_SHA=//p' "$artifact_dir/image.env")"
      digest="$(sed -n 's/^CONTROL_PLANE_IMAGE_DIGEST=//p' "$artifact_dir/image.env")"
      rm -rf -- "$artifact_dir"
      [[ "$release_sha" == "$TARGET" ]] || fail "digest artifact SHA mismatch: got=$release_sha expected=$TARGET"
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "invalid immutable image digest: $digest"
      export CONTROL_PLANE_IMAGE_DIGEST="$digest"
      printf 'CI_IMAGE=PASS sha=%s digest=%s\n' "$TARGET" "$digest"
      return 0
    fi
    if (( SECONDS - last_notice >= 15 )); then
      printf '... still waiting for CI run for %s\n' "$TARGET"
      last_notice=$SECONDS
    fi
    sleep "$POLL_SECONDS"
  done
  fail "timed out waiting for CI for $TARGET"
}

repair_live_release_unit() {
  printf '==> Repairing Control Plane app+tunnel release unit\n' >&2
  ssh -T "$REMOTE" sudo bash -s -- "$REMOTE_DIR" <<'REMOTE_REPAIR'
set -Eeuo pipefail
root="$1"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker python3; do command -v "$command" >/dev/null 2>&1 || fail "missing recovery command: $command"; done
for file in .env compose.production.yml compose.area.yml deploy/virya-area-tunnel.Caddyfile; do
  [[ -f "$file" && ! -L "$file" ]] || fail "missing or unsafe recovery input: $file"
done
[[ "$(stat -c '%a' .env)" == "600" ]] || fail '.env must have mode 600 before recovery'
compose() { docker compose -f compose.production.yml -f compose.area.yml "$@"; }
compose config --quiet
compose config --format json | python3 -c '
import json,sys
model=json.load(sys.stdin)
env=model.get("services",{}).get("app",{}).get("environment") or {}
if isinstance(env,list):
    env=dict(item.split("=",1) for item in env if isinstance(item,str) and "=" in item)
area=env.get("CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY")
operations=env.get("CONTROL_PLANE_MANAGEMENT_MASTER_KEY")
url=env.get("CONTROL_PLANE_VIRYA_MANAGEMENT_URL")
if not isinstance(area,str) or not area:
    raise SystemExit("recovery refused: effective AREA management master is missing; run make bootstrap-management")
if not isinstance(operations,str) or not operations:
    raise SystemExit("recovery refused: effective operations management master is missing; run make bootstrap-management")
if area == operations:
    raise SystemExit("recovery refused: management masters must be distinct")
if url != "http://127.0.0.1:18080":
    raise SystemExit("recovery refused: management URL is not canonical")
print("CONTROL_PLANE_RECOVERY_PREFLIGHT=PASS management_wiring=complete")
' || fail 'release unit recovery preflight failed before mutation'
compose up -d --no-deps --force-recreate app virya-area-tunnel
for _ in $(seq 1 60); do
  app_state="$(docker inspect crowdrelay-control-plane-app-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  tunnel_state="$(docker inspect crowdrelay-control-plane-virya-area-tunnel-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  if [[ ( "$app_state" == "healthy" || "$app_state" == "running" ) && ( "$tunnel_state" == "healthy" || "$tunnel_state" == "running" ) ]]; then
    printf 'CONTROL_PLANE_RELEASE_UNIT_REPAIR=PASS app=%s tunnel=%s preflight=complete\n' "$app_state" "$tunnel_state"
    exit 0
  fi
  sleep 1
done
fail "release unit did not recover: app=$app_state tunnel=$tunnel_state"
REMOTE_REPAIR
}

verify_live_tunnel() {
  ssh -T "$REMOTE" sudo bash -s <<'REMOTE_GATE'
set -Eeuo pipefail
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker curl python3 grep; do command -v "$command" >/dev/null 2>&1 || fail "missing tunnel gate command: $command"; done
app="crowdrelay-control-plane-app-1"
tunnel="crowdrelay-control-plane-virya-area-tunnel-1"
[[ "$(docker inspect "$app" --format '{{.State.Status}}' 2>/dev/null || true)" == "running" ]] || fail 'Control Plane app is not running'
tunnel_state="$(docker inspect "$tunnel" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
[[ "$tunnel_state" == "healthy" || "$tunnel_state" == "running" ]] || fail "Control Plane tunnel is not ready: $tunnel_state"
app_id="$(docker inspect "$app" --format '{{.Id}}')"
network_mode="$(docker inspect "$tunnel" --format '{{.HostConfig.NetworkMode}}')"
[[ "$network_mode" == "container:${app_id}" ]] || fail "Control Plane tunnel namespace drift: $network_mode"
docker exec "$tunnel" caddy validate --config /etc/caddy/Caddyfile >/dev/null || fail 'live tunnel Caddyfile is invalid'
runtime_caddy="$(docker exec "$tunnel" cat /etc/caddy/Caddyfile)" || fail 'cannot read live tunnel Caddyfile'
# /healthz/ready is the readiness probe the tunnel healthcheck uses. A tunnel
# serving the older route set answers it with 404, so the bridge looks up
# while every operations call through it fails. Gate on it explicitly.
for route in '/healthz/ready' '/v1/control-plane/area' '/v1/control-plane/ops/summary' '/v1/control-plane/ops/attention' '/v1/control-plane/ops/outbox' '/v1/control-plane/ecosystem/overview' '/v1/control-plane/ecosystem/flags' '/v1/control-plane/autopilot/overview' '/v1/control-plane/autopilot/growth'; do
  grep -Fq "$route" <<<"$runtime_caddy" || fail "live tunnel is missing route: $route"
done
runtime_env="$(docker inspect "$app" --format '{{range .Config.Env}}{{println .}}{{end}}')"
area_master="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY=//p')"
management_master="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_MANAGEMENT_MASTER_KEY=//p')"
management_url="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_VIRYA_MANAGEMENT_URL=//p')"
[[ -n "$area_master" ]] || fail 'Control Plane AREA management master is missing from runtime'
[[ -n "$management_master" ]] || fail 'Control Plane operations management master is missing from runtime'
[[ "$area_master" != "$management_master" ]] || fail 'Control Plane management masters are not distinct'
[[ "$management_url" == "http://127.0.0.1:18080" ]] || fail "Control Plane management URL drifted: $management_url"
unset runtime_env area_master management_master management_url
published="$(docker port "$app" 8090/tcp | head -n1)"
[[ -n "$published" ]] || fail 'Control Plane app has no published endpoint'
admin="$(docker inspect "$app" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CONTROL_PLANE_ADMIN_TOKEN=//p')"
[[ -n "$admin" ]] || fail 'Control Plane admin token missing from runtime'
summary=""
for attempt in $(seq 1 30); do
  if summary="$(curl -fsS --connect-timeout 3 --max-time 10 -H "Authorization: Bearer $admin" "http://${published}/api/v1/tenants/virya/operations/summary" 2>/tmp/control-plane-tunnel-gate-error)"; then
    printf 'CONTROL_PLANE_TUNNEL_READINESS=PASS attempt=%s\n' "$attempt"
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    detail="$(cat /tmp/control-plane-tunnel-gate-error 2>/dev/null || true)"
    rm -f /tmp/control-plane-tunnel-gate-error
    fail "operations management path did not become ready after bounded retry: $detail"
  fi
  sleep 1
done
rm -f /tmp/control-plane-tunnel-gate-error
unset admin
printf '%s' "$summary" | python3 -c '
import json
import sys
json.load(sys.stdin)
print("CONTROL_PLANE_TUNNEL_GATE=PASS e2e=true json=true")
'
REMOTE_GATE
}

ensure_live_tunnel() {
  if verify_live_tunnel; then
    printf 'CONTROL_PLANE_TUNNEL_RECOVERY=NOOP healthy=true\n'
    return 0
  fi
  printf 'CONTROL_PLANE_TUNNEL_RECOVERY=REPAIR reason=gate-failed\n' >&2
  repair_live_release_unit || return 1
  verify_live_tunnel
}

on_interrupt() {
  trap - INT TERM HUP
  printf '\nINTERRUPT=RECEIVED ensuring app+tunnel release unit is healthy\n' >&2
  ensure_live_tunnel || true
  exit 130
}

printf '==> Preflight Virya management credential parity before release gates\n'
bash "$CREDENTIAL_GATE" --check || fail 'management credential preflight failed; run make bootstrap-management before deploy'

wait_for_ci
[[ -n "${CONTROL_PLANE_IMAGE_DIGEST:-}" ]] || fail 'CI did not provide CONTROL_PLANE_IMAGE_DIGEST'
[[ "$(git rev-parse HEAD)" == "$TARGET" ]] || fail 'local HEAD moved while waiting for CI'
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || fail 'local worktree changed while waiting for CI'
REMOTE_MAIN="$(git ls-remote origin refs/heads/main | awk '{print $1}')"
[[ "$REMOTE_MAIN" == "$TARGET" ]] || fail "origin/main moved while waiting: remote=$REMOTE_MAIN target=$TARGET"

trap on_interrupt INT TERM HUP
set +e
bash "$CANONICAL" "$TARGET"
deploy_status=$?
set -e
trap - INT TERM HUP

if (( deploy_status != 0 )); then
  ensure_live_tunnel || fail 'Control Plane deploy failed and app+tunnel recovery failed'
else
  verify_live_tunnel || fail 'Control Plane deploy left the tunnel unhealthy'
fi
(( deploy_status == 0 )) || exit "$deploy_status"
printf 'MAKE_DEPLOY=PASS repo=crowdrelay-control-plane sha=%s digest=%s tunnel=healthy credentials=matched\n' "$TARGET" "$CONTROL_PLANE_IMAGE_DIGEST"