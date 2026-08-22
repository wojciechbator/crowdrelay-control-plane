#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOME_HOST="${CONTROL_PLANE_DEPLOY_HOST:-virya-crowdrelay}"
HOME_DIR="${CONTROL_PLANE_DEPLOY_REMOTE_DIR:-/srv/crowdrelay-control-plane}"
AREA_SOURCE="$ROOT_DIR/deploy/compose.area.production.yml"
CADDY_SOURCE="$ROOT_DIR/deploy/virya-area-tunnel.Caddyfile"
REMOTE_AREA="/tmp/crowdrelay-control-plane-bootstrap-area-$$.yml"
REMOTE_CADDY="/tmp/crowdrelay-control-plane-bootstrap-caddy-$$.Caddyfile"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail 'missing SHA-256 utility (sha256sum or shasum)'
  fi
}

cleanup() {
  ssh -T "$HOME_HOST" "rm -f '$REMOTE_AREA' '$REMOTE_CADDY'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for command in ssh scp bash; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
for file in "$AREA_SOURCE" "$CADDY_SOURCE"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "missing or unsafe canonical management file: $file"
done

area_sha="$(sha256_file "$AREA_SOURCE")"
caddy_sha="$(sha256_file "$CADDY_SOURCE")"

printf '==> Installing canonical Home management overlay before credential reload\n'
scp -q "$AREA_SOURCE" "$HOME_HOST:$REMOTE_AREA"
scp -q "$CADDY_SOURCE" "$HOME_HOST:$REMOTE_CADDY"

report="$(ssh -T "$HOME_HOST" sudo bash -s -- "$HOME_DIR" "$REMOTE_AREA" "$REMOTE_CADDY" "$area_sha" "$caddy_sha" <<'REMOTE'
set -Eeuo pipefail
root="$1"
area_source="$2"
caddy_source="$3"
expected_area_sha="$4"
expected_caddy_sha="$5"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

for command in install sha256sum; do
  command -v "$command" >/dev/null 2>&1 || fail "missing Home command: $command"
done
[[ -d "$root" ]] || fail "missing Control Plane production directory: $root"
[[ -f "$root/compose.production.yml" && ! -L "$root/compose.production.yml" ]] || fail 'missing or unsafe Home compose.production.yml'
[[ -f "$root/.env" && ! -L "$root/.env" ]] || fail 'missing or unsafe Home .env'
[[ "$(stat -c '%a' "$root/.env")" == "600" ]] || fail 'Home .env must have mode 600'
[[ -f "$area_source" && ! -L "$area_source" ]] || fail 'transferred management overlay missing or unsafe'
[[ -f "$caddy_source" && ! -L "$caddy_source" ]] || fail 'transferred tunnel Caddyfile missing or unsafe'
[[ "$(sha256sum "$area_source" | awk '{print $1}')" == "$expected_area_sha" ]] || fail 'transferred management overlay digest mismatch'
[[ "$(sha256sum "$caddy_source" | awk '{print $1}')" == "$expected_caddy_sha" ]] || fail 'transferred tunnel Caddyfile digest mismatch'

mkdir -p "$root/deploy"
install -m 0644 "$area_source" "$root/compose.area.yml"
install -m 0644 "$caddy_source" "$root/deploy/virya-area-tunnel.Caddyfile"

runtime_area_sha="$(sha256sum "$root/compose.area.yml" | awk '{print $1}')"
runtime_caddy_sha="$(sha256sum "$root/deploy/virya-area-tunnel.Caddyfile" | awk '{print $1}')"
[[ "$runtime_area_sha" == "$expected_area_sha" ]] || fail 'installed Home management overlay digest mismatch'
[[ "$runtime_caddy_sha" == "$expected_caddy_sha" ]] || fail 'installed Home tunnel Caddyfile digest mismatch'

printf 'CANONICAL_MANAGEMENT_OVERLAY=PASS area_sha256=%s caddy_sha256=%s\n' "$runtime_area_sha" "$runtime_caddy_sha"
REMOTE
)" || fail 'failed to install canonical Home management overlay'
printf '%s\n' "$report"

if bash "$ROOT_DIR/scripts/ensure-virya-management-credentials.sh" --apply; then
  exit 0
fi

printf 'MANAGEMENT_BOOTSTRAP_READINESS=RETRY reason=post-recreate-e2e-not-ready\n' >&2
for attempt in $(seq 1 15); do
  sleep 1
  if bash "$ROOT_DIR/scripts/ensure-virya-management-credentials.sh" --check; then
    printf 'MANAGEMENT_BOOTSTRAP_READINESS=PASS attempt=%s mutation_retried=false\n' "$attempt"
    exit 0
  fi
  printf '... management tunnel not ready yet attempt=%s/15\n' "$attempt" >&2
done

fail 'management bootstrap did not reach E2E readiness after bounded retry'
