#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODE="${1:---check}"
HOME_HOST="${CONTROL_PLANE_DEPLOY_HOST:-virya-crowdrelay}"
HOME_DIR="${CONTROL_PLANE_DEPLOY_REMOTE_DIR:-/srv/crowdrelay-control-plane}"
ORACLE_HOST="${CONTROL_PLANE_VIRYA_ORACLE_HOST:-virya-crowdrelay}"
ORACLE_DIR="${CONTROL_PLANE_VIRYA_ORACLE_DIR:-/opt/crowdrelay}"
LOCAL_PAYLOAD=""
REMOTE_PAYLOAD=""

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$LOCAL_PAYLOAD" ]] || rm -f -- "$LOCAL_PAYLOAD"
  if [[ -n "$REMOTE_PAYLOAD" ]]; then
    ssh -T "$ORACLE_HOST" "rm -f '$REMOTE_PAYLOAD'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command in ssh scp python3; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
case "$MODE" in
  --check|--apply) ;;
  *) fail 'usage: ensure-virya-management-credentials.sh [--check|--apply]' ;;
esac

home_check() {
  ssh -T "$HOME_HOST" sudo bash -s -- "$HOME_DIR" <<'HOME_CHECK'
set -Eeuo pipefail
root="$1"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker curl python3 sha256sum; do command -v "$command" >/dev/null 2>&1 || fail "missing Home command: $command"; done
for file in .env compose.production.yml compose.area.yml deploy/virya-area-tunnel.Caddyfile; do
  [[ -f "$file" && ! -L "$file" ]] || fail "missing or unsafe Home file: $file"
done
[[ "$(stat -c '%a' .env)" == "600" ]] || fail '.env must have mode 600'
app="crowdrelay-control-plane-app-1"
tunnel="crowdrelay-control-plane-virya-area-tunnel-1"
# A host that has never run the control plane has nothing to verify yet, and
# failing here deadlocks the first deploy: the gate demands a running app, and
# the deploy that would start it never runs. Absent is a bootstrap state.
# A container that exists but is not running is still a hard failure.
if ! docker inspect "$app" >/dev/null 2>&1; then
  printf 'BOOTSTRAP_REQUIRED=true reason=control-plane-app-absent\n'
  exit 0
fi
[[ "$(docker inspect "$app" --format '{{.State.Status}}' 2>/dev/null || true)" == "running" ]] || fail 'Control Plane app is not running'
[[ "$(docker inspect "$tunnel" --format '{{.State.Status}}' 2>/dev/null || true)" == "running" ]] || fail 'Control Plane tunnel is not running'
runtime_env="$(docker inspect "$app" --format '{{range .Config.Env}}{{println .}}{{end}}')"
admin="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_ADMIN_TOKEN=//p')"
area_master="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY=//p')"
management_master="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_MANAGEMENT_MASTER_KEY=//p')"
management_url="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_VIRYA_MANAGEMENT_URL=//p')"
[[ -n "$admin" ]] || fail 'Control Plane admin token missing from runtime'
[[ -n "$area_master" ]] || fail 'Control Plane AREA management master missing from runtime; run make bootstrap-management'
[[ -n "$management_master" ]] || fail 'Control Plane operations management master missing from runtime; run make bootstrap-management'
[[ "$area_master" != "$management_master" ]] || fail 'Control Plane management masters must be distinct'
[[ "$management_url" == "http://127.0.0.1:18080" ]] || fail 'Control Plane management URL is not canonical'
published="$(docker port "$app" 8090/tcp | head -n1)"
[[ -n "$published" ]] || fail 'Control Plane app has no published endpoint'
base="http://${published}"
tenant_id="$(curl -fsS --connect-timeout 3 --max-time 10 -H "Authorization: Bearer $admin" "$base/api/v1/tenants/virya" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
[[ "$tenant_id" =~ ^[0-9a-f-]{36}$ ]] || fail 'cannot resolve Virya tenant id'
read -r area_hash management_hash < <(python3 - "$area_master" "$management_master" "$tenant_id" <<'PY'
import hashlib,hmac,sys
area,management,tenant=sys.argv[1:]
def derived(master, namespace):
    token=hmac.new(master.encode(), (namespace+tenant).encode(), hashlib.sha256).hexdigest()
    return hashlib.sha256(token.encode()).hexdigest()
print(derived(area, 'crowdrelay-area-admin-v1:'), derived(management, 'crowdrelay-control-plane-v1:'))
PY
)
for path in \
  /api/v1/tenants/virya/area \
  /api/v1/tenants/virya/operations/summary \
  /api/v1/tenants/virya/operations/flags \
  /api/v1/tenants/virya/operations/autopilot; do
  code="$(curl -sS -o /tmp/control-plane-management-check-body -w '%{http_code}' --connect-timeout 3 --max-time 10 -H "Authorization: Bearer $admin" "$base$path")"
  if [[ "$code" != "200" ]]; then
    detail="$(cat /tmp/control-plane-management-check-body 2>/dev/null || true)"
    rm -f /tmp/control-plane-management-check-body
    fail "management E2E failed path=$path status=$code detail=$detail"
  fi
done
rm -f /tmp/control-plane-management-check-body
fingerprint="$(docker inspect "$tunnel" --format '{{.Id}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.Status}}')"
printf 'TENANT_ID=%s\nAREA_DERIVED_SHA256=%s\nMANAGEMENT_DERIVED_SHA256=%s\nTUNNEL_FINGERPRINT=%s\n' "$tenant_id" "$area_hash" "$management_hash" "$fingerprint"
HOME_CHECK
}

oracle_check() {
  ssh -T "$ORACLE_HOST" bash -s -- "$ORACLE_DIR" <<'ORACLE_CHECK'
set -Eeuo pipefail
root="$1"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker sha256sum; do command -v "$command" >/dev/null 2>&1 || fail "missing Oracle command: $command"; done
env_file="deploy/.env.production"
[[ -f "$env_file" && ! -L "$env_file" ]] || fail 'Oracle production env missing or unsafe'
runtime_env="$(docker inspect crowdrelay-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}')"
runtime_area="$(printf '%s\n' "$runtime_env" | sed -n 's/^CROWDRELAY_CONTROL_PLANE_AREA_API_KEY=//p')"
runtime_management="$(printf '%s\n' "$runtime_env" | sed -n 's/^CROWDRELAY_CONTROL_PLANE_API_KEY=//p')"
persisted_area="$(sed -n 's/^CROWDRELAY_CONTROL_PLANE_AREA_API_KEY=//p' "$env_file" | tail -n1)"
persisted_management="$(sed -n 's/^CROWDRELAY_CONTROL_PLANE_API_KEY=//p' "$env_file" | tail -n1)"
[[ -n "$runtime_area" ]] || fail 'Oracle runtime AREA API key missing; run make bootstrap-management in Control Plane'
[[ -n "$runtime_management" ]] || fail 'Oracle runtime operations API key missing; run make bootstrap-management in Control Plane'
[[ -n "$persisted_area" ]] || fail 'Oracle persisted AREA API key missing; run make bootstrap-management in Control Plane'
[[ -n "$persisted_management" ]] || fail 'Oracle persisted operations API key missing; run make bootstrap-management in Control Plane'
hash() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }
printf 'ORACLE_RUNTIME_AREA_SHA256=%s\nORACLE_RUNTIME_MANAGEMENT_SHA256=%s\nORACLE_PERSISTED_AREA_SHA256=%s\nORACLE_PERSISTED_MANAGEMENT_SHA256=%s\n' \
  "$(hash "$runtime_area")" "$(hash "$runtime_management")" "$(hash "$persisted_area")" "$(hash "$persisted_management")"
ORACLE_CHECK
}

if [[ "$MODE" == "--check" ]]; then
  HOME_REPORT="$(home_check)" || fail 'Home management credential/E2E check failed'
  if [[ "$HOME_REPORT" == BOOTSTRAP_REQUIRED=* ]]; then
    # First deploy onto this host. The deploy itself brings the app up and its
    # own post-deploy gates verify the result, so do not block here.
    printf 'MANAGEMENT_CREDENTIALS=BOOTSTRAP %s\n' "$HOME_REPORT"
    exit 0
  fi
  ORACLE_REPORT="$(oracle_check)" || fail 'Oracle management credential check failed'
  area_expected="$(printf '%s\n' "$HOME_REPORT" | sed -n 's/^AREA_DERIVED_SHA256=//p')"
  management_expected="$(printf '%s\n' "$HOME_REPORT" | sed -n 's/^MANAGEMENT_DERIVED_SHA256=//p')"
  runtime_area="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_RUNTIME_AREA_SHA256=//p')"
  runtime_management="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_RUNTIME_MANAGEMENT_SHA256=//p')"
  persisted_area="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_PERSISTED_AREA_SHA256=//p')"
  persisted_management="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_PERSISTED_MANAGEMENT_SHA256=//p')"
  [[ -n "$area_expected" && -n "$management_expected" ]] || fail 'Home did not return credential fingerprints'
  [[ "$runtime_area" == "$area_expected" && "$persisted_area" == "$area_expected" ]] || fail 'AREA management credential drift between Home and Oracle; run make bootstrap-management'
  [[ "$runtime_management" == "$management_expected" && "$persisted_management" == "$management_expected" ]] || fail 'operations management credential drift between Home and Oracle; run make bootstrap-management'
  printf '%s\n' "$HOME_REPORT" | grep '^TUNNEL_FINGERPRINT='
  printf 'MANAGEMENT_CREDENTIALS=PASS home=runtime oracle=runtime,persisted area=matched operations=matched e2e=pass\n'
  exit 0
fi

printf '==> Ensuring persistent Home management masters\n'
HOME_PREP="$(ssh -T "$HOME_HOST" sudo bash -s -- "$HOME_DIR" <<'HOME_APPLY'
set -Eeuo pipefail
umask 077
root="$1"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
for command in docker curl python3; do command -v "$command" >/dev/null 2>&1 || fail "missing Home command: $command"; done
for file in .env compose.production.yml compose.area.yml; do [[ -f "$file" && ! -L "$file" ]] || fail "missing or unsafe Home file: $file"; done
[[ "$(stat -c '%a' .env)" == "600" ]] || fail '.env must have mode 600'
python3 <<'PY'
from pathlib import Path
import os,re,secrets,stat
path=Path('.env')
st=path.stat()
text=path.read_text()
def get(key):
    m=re.search(rf'^{re.escape(key)}=(.*)$', text, flags=re.M)
    return m.group(1) if m else None
def upsert(source,key,value):
    pattern=rf'^{re.escape(key)}=.*$'
    line=f'{key}={value}'
    if re.search(pattern, source, flags=re.M):
        return re.sub(pattern,line,source,count=1,flags=re.M)
    return source.rstrip()+f'\n{line}\n'
area=get('CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY')
management=get('CONTROL_PLANE_MANAGEMENT_MASTER_KEY')
reserved={get('CONTROL_PLANE_ADMIN_TOKEN'),get('CONTROL_PLANE_TELEMETRY_TOKEN'),get('CONTROL_PLANE_PROVISIONER_TOKEN')}
reserved.discard(None); reserved.discard('')
def fresh(blocked):
    while True:
        value=secrets.token_hex(48)
        if value not in blocked:
            return value
if not area or area in reserved:
    area=fresh(reserved | ({management} if management else set()))
if not management or management in reserved or management == area:
    management=fresh(reserved | {area})
text=upsert(text,'CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY',area)
text=upsert(text,'CONTROL_PLANE_MANAGEMENT_MASTER_KEY',management)
text=upsert(text,'CONTROL_PLANE_VIRYA_MANAGEMENT_URL','http://127.0.0.1:18080')
tmp=path.with_name('.env.management-bootstrap.tmp')
tmp.write_text(text)
os.chmod(tmp,0o600); os.chown(tmp,st.st_uid,st.st_gid); os.replace(tmp,path)
PY
chmod 600 .env
docker compose -f compose.production.yml -f compose.area.yml config --quiet || fail 'effective Home compose is invalid after credential bootstrap'
app="crowdrelay-control-plane-app-1"
runtime_env="$(docker inspect "$app" --format '{{range .Config.Env}}{{println .}}{{end}}')"
admin="$(printf '%s\n' "$runtime_env" | sed -n 's/^CONTROL_PLANE_ADMIN_TOKEN=//p')"
published="$(docker port "$app" 8090/tcp | head -n1)"
[[ -n "$admin" && -n "$published" ]] || fail 'cannot use current Control Plane app to resolve Virya tenant'
tenant_id="$(curl -fsS --connect-timeout 3 --max-time 10 -H "Authorization: Bearer $admin" "http://${published}/api/v1/tenants/virya" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
area_master="$(sed -n 's/^CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY=//p' .env | tail -n1)"
management_master="$(sed -n 's/^CONTROL_PLANE_MANAGEMENT_MASTER_KEY=//p' .env | tail -n1)"
python3 - "$area_master" "$management_master" "$tenant_id" <<'PY'
import hashlib,hmac,sys
area,management,tenant=sys.argv[1:]
def token(master,namespace):
    return hmac.new(master.encode(),(namespace+tenant).encode(),hashlib.sha256).hexdigest()
area_token=token(area,'crowdrelay-area-admin-v1:')
management_token=token(management,'crowdrelay-control-plane-v1:')
print('TENANT_ID='+tenant)
print('AREA_TOKEN='+area_token)
print('MANAGEMENT_TOKEN='+management_token)
print('AREA_DERIVED_SHA256='+hashlib.sha256(area_token.encode()).hexdigest())
print('MANAGEMENT_DERIVED_SHA256='+hashlib.sha256(management_token.encode()).hexdigest())
PY
HOME_APPLY
)" || fail 'failed to persist/derive Home management credentials'

area_token="$(printf '%s\n' "$HOME_PREP" | sed -n 's/^AREA_TOKEN=//p')"
management_token="$(printf '%s\n' "$HOME_PREP" | sed -n 's/^MANAGEMENT_TOKEN=//p')"
area_hash="$(printf '%s\n' "$HOME_PREP" | sed -n 's/^AREA_DERIVED_SHA256=//p')"
management_hash="$(printf '%s\n' "$HOME_PREP" | sed -n 's/^MANAGEMENT_DERIVED_SHA256=//p')"
[[ "$area_token" =~ ^[0-9a-f]{64}$ && "$management_token" =~ ^[0-9a-f]{64}$ ]] || fail 'derived management tokens are invalid'
[[ "$area_token" != "$management_token" ]] || fail 'derived management tokens must be distinct'
printf 'HOME_MANAGEMENT_MASTERS=PASS area_sha256=%s operations_sha256=%s\n' "$area_hash" "$management_hash"

LOCAL_PAYLOAD="$(mktemp -t virya-management.XXXXXX)"
chmod 600 "$LOCAL_PAYLOAD"
printf 'CROWDRELAY_CONTROL_PLANE_AREA_API_KEY=%s\nCROWDRELAY_CONTROL_PLANE_API_KEY=%s\n' "$area_token" "$management_token" >"$LOCAL_PAYLOAD"
unset area_token management_token HOME_PREP
REMOTE_PAYLOAD="/tmp/virya-management-credentials-$$.env"
scp -q "$LOCAL_PAYLOAD" "$ORACLE_HOST:$REMOTE_PAYLOAD"

printf '==> Persisting Oracle API credentials and reloading only the current API image\n'
ssh -T "$ORACLE_HOST" bash -s -- "$ORACLE_DIR" "$REMOTE_PAYLOAD" <<'ORACLE_APPLY'
set -Eeuo pipefail
umask 077
root="$1"
payload="$2"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; rm -f -- "$payload"; exit 1; }
for command in docker python3 sha256sum; do command -v "$command" >/dev/null 2>&1 || fail "missing Oracle command: $command"; done
[[ -f "$payload" && ! -L "$payload" ]] || fail 'credential payload missing or unsafe'
chmod 600 "$payload"
# shellcheck source=/dev/null
source "$payload"
[[ "$CROWDRELAY_CONTROL_PLANE_AREA_API_KEY" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid AREA API key payload'
[[ "$CROWDRELAY_CONTROL_PLANE_API_KEY" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid operations API key payload'
env_file="deploy/.env.production"
[[ -f "$env_file" && ! -L "$env_file" ]] || fail 'Oracle production env missing or unsafe'
python3 - "$env_file" "$CROWDRELAY_CONTROL_PLANE_AREA_API_KEY" "$CROWDRELAY_CONTROL_PLANE_API_KEY" <<'PY'
from pathlib import Path
import os,re,stat,sys
path=Path(sys.argv[1]); area=sys.argv[2]; management=sys.argv[3]; st=path.stat(); text=path.read_text()
def upsert(source,key,value):
    pattern=rf'^{re.escape(key)}=.*$'; line=f'{key}={value}'
    if re.search(pattern,source,flags=re.M): return re.sub(pattern,line,source,count=1,flags=re.M)
    return source.rstrip()+f'\n{line}\n'
text=upsert(text,'CROWDRELAY_CONTROL_PLANE_AREA_API_KEY',area)
text=upsert(text,'CROWDRELAY_CONTROL_PLANE_API_KEY',management)
tmp=path.with_name(path.name+'.management-bootstrap.tmp'); tmp.write_text(text)
os.chmod(tmp,stat.S_IMODE(st.st_mode)); os.chown(tmp,st.st_uid,st.st_gid); os.replace(tmp,path)
PY
rm -f -- "$payload"
running_image="$(docker inspect crowdrelay-api-1 --format '{{.Config.Image}}')"
current_sha="${running_image##*:sha-}"
[[ "$current_sha" =~ ^[0-9a-f]{40}$ ]] || fail "current API image is not immutable: $running_image"
[[ -f .crowdrelay.local.sh && ! -L .crowdrelay.local.sh ]] || fail 'CrowdRelay local config missing or unsafe'
# shellcheck source=/dev/null
source .crowdrelay.local.sh
absolute_path() { if [[ "$1" = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$PWD" "$1"; fi; }
export CROWDRELAY_ENV_FILE="$(absolute_path "${CROWDRELAY_ENV_FILE:-deploy/.env.production}")"
export CROWDRELAY_BOOTSTRAP_HOST_FILE="$(absolute_path "${CROWDRELAY_BOOTSTRAP_FILE:-deploy/bootstrap.production.json}")"
export CROWDRELAY_WEBHOOK_SECRETS_HOST_FILE="$(absolute_path "${CROWDRELAY_WEBHOOK_SECRETS_FILE:-deploy/webhook-secrets.production.json}")"
export CROWDRELAY_FCM_SERVICE_ACCOUNT_HOST_FILE="$(absolute_path "${CROWDRELAY_FCM_SERVICE_ACCOUNT_FILE:-deploy/secrets/firebase-service-account.json}")"
export CROWDRELAY_DOCKER_NETWORK
export CROWDRELAY_IMAGE_TAG="sha-${current_sha}"
compose_file="$(absolute_path "${CROWDRELAY_COMPOSE_FILE:-compose.production.yaml}")"
compose_args=(--env-file "$CROWDRELAY_ENV_FILE" -f "$compose_file")
if [[ "${CROWDRELAY_AREA_MANAGEMENT_ENABLED:-false}" == "true" ]]; then
  export CROWDRELAY_AREA_MANAGEMENT_CONFIG_SHA256="$(sha256sum deploy/area-management.Caddyfile | awk '{print $1}')"
  compose_args+=(-f compose.area-management.yaml)
fi
compose() { docker compose "${compose_args[@]}" "$@"; }
compose config --quiet || fail 'Oracle effective compose invalid after credential persistence'
compose up -d --no-deps --force-recreate --wait --wait-timeout "${CROWDRELAY_DEPLOY_WAIT_TIMEOUT_SECONDS:-180}" api
new_image="$(docker inspect crowdrelay-api-1 --format '{{.Config.Image}}')"
[[ "$new_image" == "$running_image" ]] || fail "credential reload changed CrowdRelay release: before=$running_image after=$new_image"
image_id="$(docker inspect crowdrelay-api-1 --format '{{.Image}}')"
revision="$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[[ "$revision" == "$current_sha" ]] || fail 'CrowdRelay runtime revision changed during credential reload'
printf 'ORACLE_CREDENTIAL_RELOAD=PASS release_unchanged=true api_sha=%s worker=untouched proxy=untouched\n' "$current_sha"
ORACLE_APPLY
REMOTE_PAYLOAD=""

printf '==> Reloading current Control Plane app+tunnel release unit\n'
ssh -T "$HOME_HOST" sudo bash -s -- "$HOME_DIR" <<'HOME_RELOAD'
set -Eeuo pipefail
root="$1"
cd "$root"
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
compose() { docker compose -f compose.production.yml -f compose.area.yml "$@"; }
compose config --quiet || fail 'Home effective compose invalid before reload'
old_image="$(docker inspect crowdrelay-control-plane-app-1 --format '{{.Config.Image}}')"
compose up -d --no-deps --force-recreate app virya-area-tunnel
for _ in $(seq 1 60); do
  app_state="$(docker inspect crowdrelay-control-plane-app-1 --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || true)"
  tunnel_state="$(docker inspect crowdrelay-control-plane-virya-area-tunnel-1 --format '{{.State.Status}}' 2>/dev/null || true)"
  if [[ ( "$app_state" == "healthy" || "$app_state" == "running" ) && "$tunnel_state" == "running" ]]; then break; fi
  sleep 1
done
[[ "$app_state" == "healthy" || "$app_state" == "running" ]] || fail "Control Plane app did not recover: $app_state"
[[ "$tunnel_state" == "running" ]] || fail "Control Plane tunnel did not recover: $tunnel_state"
new_image="$(docker inspect crowdrelay-control-plane-app-1 --format '{{.Config.Image}}')"
[[ "$new_image" == "$old_image" ]] || fail "credential reload changed Control Plane release: before=$old_image after=$new_image"
printf 'HOME_CREDENTIAL_RELOAD=PASS release_unchanged=true app=%s tunnel=%s\n' "$app_state" "$tunnel_state"
HOME_RELOAD

HOME_REPORT="$(home_check)" || fail 'post-bootstrap Home management E2E failed'
ORACLE_REPORT="$(oracle_check)" || fail 'post-bootstrap Oracle credential check failed'
area_expected="$(printf '%s\n' "$HOME_REPORT" | sed -n 's/^AREA_DERIVED_SHA256=//p')"
management_expected="$(printf '%s\n' "$HOME_REPORT" | sed -n 's/^MANAGEMENT_DERIVED_SHA256=//p')"
runtime_area="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_RUNTIME_AREA_SHA256=//p')"
runtime_management="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_RUNTIME_MANAGEMENT_SHA256=//p')"
persisted_area="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_PERSISTED_AREA_SHA256=//p')"
persisted_management="$(printf '%s\n' "$ORACLE_REPORT" | sed -n 's/^ORACLE_PERSISTED_MANAGEMENT_SHA256=//p')"
[[ "$runtime_area" == "$area_expected" && "$persisted_area" == "$area_expected" ]] || fail 'AREA credential mismatch after bootstrap'
[[ "$runtime_management" == "$management_expected" && "$persisted_management" == "$management_expected" ]] || fail 'operations credential mismatch after bootstrap'
printf '%s\n' "$HOME_REPORT" | grep '^TUNNEL_FINGERPRINT='
printf 'MANAGEMENT_BOOTSTRAP=PASS home=runtime,persisted oracle=runtime,persisted release_versions=unchanged e2e=area,summary,flags,autopilot\n'
