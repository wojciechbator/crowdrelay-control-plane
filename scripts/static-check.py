from pathlib import Path
root = Path(__file__).resolve().parents[1]
checks = {
    "synesthesia_db_invariant": (root / "migrations/0001_control_plane.sql", "NOT synesthesia_enabled OR slug = 'virya'"),
    "admin_hash": (root / "crates/control-plane-api/src/config.rs", "Sha256::digest"),
    "separate_telemetry_secret": (root / "crates/control-plane-api/src/config.rs", "CONTROL_PLANE_TELEMETRY_TOKEN"),
    "constant_time_auth": (root / "crates/control-plane-api/src/auth.rs", ".ct_eq("),
    "admin_bearer_only": (root / "crates/control-plane-api/src/auth.rs", "require_bearer(request.headers(), state.admin_token_hash)"),
    "caddy_admin_injection": (root / "deploy/Caddyfile.control.virya.music.example", 'header_up Authorization "Bearer {$CONTROL_PLANE_ADMIN_TOKEN}"'),
    "caddy_clickjacking_defense": (root / "deploy/Caddyfile.control.virya.music.example", "frame-ancestors 'none'"),
    "worker_readiness_gate": (root / "deploy/provisioner.py", 'wait_container_healthy(config, tenant_dir, project, "worker"'),
    "telemetry_auth": (root / "crates/control-plane-api/src/auth.rs", "require_telemetry"),
    "virya_seed_inherit_branding": (root / "crates/control-plane-api/src/store.rs", "branding_palette, synesthesia_enabled, area_enabled)"),
    "provisioning_no_rce": (root / "crates/control-plane-api/src/store.rs", '"mode": "local_docker_compose"'),
    "provisioner_secret": (root / "crates/control-plane-api/src/config.rs", "CONTROL_PLANE_PROVISIONER_TOKEN"),
    "provisioner_auth": (root / "crates/control-plane-api/src/auth.rs", "require_provisioner"),
    "provisioner_routes": (root / "crates/control-plane-api/src/routes.rs", '"/provisioner/jobs/claim"'),
    "provisioner_lease_schema": (root / "migrations/0003_tenant_instance_provisioning.sql", "claim_token_hash bytea"),
    "provisioner_host_agent": (root / "deploy/provisioner.py", "def process_claim"),
    "atomic_create_deploy": (root / "crates/control-plane-api/src/store.rs", '"createdWithTenant": true'),
    "split_runtime_env": (root / "deploy/provisioner.py", 'env_file: [.env, tenant.env]'),
    "host_port_allocation_lock": (root / "deploy/provisioner.py", 'fcntl.LOCK_EX'),
    "retryable_agent_transport": (root / "deploy/provisioner.py", 'terminal=False'),
    "docker_child_secret_scrub": (root / "deploy/provisioner.py", 'CONTROL_PLANE_SECRET_ENV'),
    "idempotent_completion": (root / "crates/control-plane-api/src/store.rs", 'provisioning_success_matches'),
    "provisioner_systemd": (root / "deploy/crowdrelay-control-plane-provisioner.service.example", "Group=docker"),
    "workspace_unique": (root / "migrations/0001_control_plane.sql", "control_plane_tenant_workspace_uidx"),
    "provisioning_dedupe_db": (root / "migrations/0002_operational_hardening.sql", "control_plane_provisioning_one_active_uidx"),
    "provisioning_dedupe_app": (root / "crates/control-plane-api/src/store.rs", "ON CONFLICT (tenant_id) WHERE status IN ('planned', 'approved', 'running') DO NOTHING"),
    "palette_contrast": (root / "crates/control-plane-api/src/validation.rs", "WCAG AA 4.5:1"),
    "runtime_report": (root / "crates/control-plane-api/src/routes.rs", '"/tenants/{slug}/runtime"'),
    "runtime_freshness": (root / "crates/control-plane-api/src/model.rs", "RuntimeHealth::classify"),
    "runtime_server_clock_authority": (root / "crates/control-plane-api/src/model.rs", ".checked_at"),
    "tenant_resource_caps": (root / "deploy/provisioner.py", "mem_limit: 384m"),
    "runtime_meaningful_audit": (root / "crates/control-plane-api/src/store.rs", 'action: "tenant.runtime.changed"'),
    "runtime_validation": (root / "crates/control-plane-api/src/validation.rs", "lastHeartbeatAt cannot be more than 5 minutes in the future"),
    "bounded_pool_acquire": (root / "crates/control-plane-api/src/main.rs", ".acquire_timeout(Duration::from_secs(5))"),
    "bounded_db_statement": (root / "crates/control-plane-api/src/main.rs", "SET statement_timeout = '5s'"),
    "joined_tenant_runtime": (root / "crates/control-plane-api/src/store.rs", "LEFT JOIN control_plane_runtime_status"),
    "solid_query": (root / "frontend/src/main.tsx", "@tanstack/solid-query"),
    "solid_router": (root / "frontend/src/main.tsx", "@tanstack/solid-router"),
    "docker_lockfile": (root / "Dockerfile", "COPY frontend/package.json frontend/package-lock.json ./"),
    "rust_1971_docker": (root / "Dockerfile", "FROM rust:1.97.1-alpine AS rust"),
    "rust_1971_ci": (root / ".github/workflows/ci.yml", "toolchain: 1.97.1"),
    "docker_cargo_locked": (root / "Dockerfile", "cargo build --release --locked"),
    "ci_clippy_locked": (root / ".github/workflows/ci.yml", "cargo clippy --locked"),
    "spa_deep_link_200": (root / "crates/control-plane-api/src/main.rs", ".fallback(ServeFile::new(index))"),
    "area_private_transport": (root / "crates/control-plane-api/src/tenant_area_client.rs", "AREA management target must be loopback or private"),
    "area_redirect_refusal": (root / "crates/control-plane-api/src/tenant_area_client.rs", "AREA management redirect refused"),
    "area_tenant_token": (root / "crates/control-plane-api/src/tenant_area_client.rs", "crowdrelay-area-admin-v1:"),
    "area_entitlement": (root / "migrations/0004_area_management.sql", "area_enabled boolean"),
}
for name, (file, needle) in checks.items():
    text = file.read_text()
    assert needle in text, f"{name} missing in {file}"

store = (root / "crates/control-plane-api/src/store.rs").read_text()
assert 'action: "tenant.runtime.reported"' not in store, "heartbeat write amplification regression: every report is audited"
main = (root / "crates/control-plane-api/src/main.rs").read_text()
assert ".not_found_service(ServeFile::new(index))" not in main, \
    "SPA deep-link fallback must preserve index.html's 200 status instead of forcing 404"
spa = (root / "frontend/src/lib/api.ts").read_text()
frontend = "\n".join(path.read_text() for path in (root / "frontend/src").rglob("*.ts*") if path.is_file())
auth = (root / "crates/control-plane-api/src/auth.rs").read_text()
caddy = (root / "deploy/Caddyfile.control.virya.music.example").read_text()
assert "x-control-plane-token" not in auth.lower(), "backend must not grow a browser-only admin header"
assert "x-control-plane-token" not in frontend.lower(), "SPA must not carry the platform admin secret"
assert "Basic ${btoa" not in spa, "Basic credential encoding belongs in the dedicated auth module"
auth_ui = (root / "frontend/src/lib/auth.ts").read_text()
assert "createSignal" in auth_ui, "operator auth state must remain reactive"
# The operator session survives a reload on purpose, so sessionStorage is
# allowed. localStorage is not: it would outlive the tab and leave a
# password-equivalent credential for the next person on this machine.
assert "localStorage" not in auth_ui, \
    "operator credentials must never persist beyond the tab"
assert "sessionStorage" in auth_ui, \
    "operator session must survive a reload via tab-scoped storage"
assert "setAuthorization(null)" in auth_ui, "operator credentials must clear explicitly on logout"
assert "Basic ${btoa(binary)}" in auth_ui, "operator login must use Basic only at the edge"
assert "CONTROL_PLANE_ADMIN_TOKEN" not in frontend, "admin secret must not be compiled into frontend source"
assert "crowdrelay-control-plane-token" not in frontend.lower(), "browser admin-token storage key must not return"
assert "{http.request.header.X-Control-Plane-Token}" not in caddy, "Caddy must not trust a browser-supplied app token"
assert caddy.index("handle @runtime") < caddy.index("basic_auth"), "telemetry route must bypass browser Basic and rely on its own Bearer"
assert "handle @provisioner" in caddy and caddy.index("handle @provisioner") < caddy.index("basic_auth"), "provisioner machine route must bypass browser Basic and preserve its own Bearer"
assert caddy.index("basic_auth") < caddy.index('header_up Authorization "Bearer {$CONTROL_PLANE_ADMIN_TOKEN}"'), "Basic must gate server-side admin token injection"
provisioner = (root / "deploy/provisioner.py").read_text()
rust_api = "\n".join(path.read_text() for path in (root / "crates/control-plane-api/src").glob("*.rs"))
for forbidden in ("shell=True", "os.system(", "eval(", "exec(", "/var/run/docker.sock"):
    assert forbidden not in provisioner, f"provisioner command escape hatch forbidden: {forbidden}"
for forbidden in ("std::process::Command", "/var/run/docker.sock", "docker compose"):
    assert forbidden not in rust_api, f"HTTP API must not own Docker capability: {forbidden}"
assert "def dry_run(" in provisioner, "provisioner must expose a non-mutating readiness dry run"
dry_run_body = provisioner.split("def dry_run(", 1)[1].split("\ndef ", 1)[0]
for forbidden in ("claim_once", "process_claim", "api(", "api_with_token("):
    assert forbidden not in dry_run_body, f"dry-run must not claim live provisioning jobs or mutate the Control Plane: {forbidden}"
assert "def safe_image_ref" in provisioner and 'segment not in ("", ".", "..")' in provisioner, "agent must independently reject image path traversal"
# An OCI tag is mutable, so a sha-<commit> tag alone pins nothing. The agent must
# verify the image's OCI revision label against the planned commit, deploy the
# resolved digest, and refuse a release whose digest changed under it.
assert "org.opencontainers.image.revision" in provisioner, "agent must verify the published OCI revision label"
assert "RepoDigests" in provisioner and "image_digest_changed" in provisioner, "agent must pin deployments to a resolved digest and fail closed on digest drift"
assert '"image"' in provisioner and "pinned[\"api\"]" in provisioner, "compose must run digest-pinned images"
# Runtime health observation must not be serialised behind a multi-minute deploy.
assert "def observer_loop(" in provisioner, "runtime observation must run independently of provisioning"
assert "max_workers=config.observer_concurrency" in provisioner, "observer probes must be bounded"
assert "class LeaseKeeper" in provisioner, "an active deployment must hold its lease while long Docker steps run"
main_body = provisioner.split("def main(", 1)[1]
assert "observe_deployments(config)" not in main_body, "the claim loop must not be what drives observation"
assert "COALESCE(EXCLUDED.api_healthy" in store, "runtime telemetry updates must preserve omitted fields"
assert "EXCLUDED.last_heartbeat_at >= control_plane_runtime_status.last_heartbeat_at" in store, "out-of-order telemetry must not overwrite a newer runtime snapshot"
model = (root / "crates/control-plane-api/src/model.rs").read_text()
routes = (root / "crates/control-plane-api/src/routes.rs").read_text()
assert "pub deploy_crowdrelay: bool" in model and "pub desired_version: Option<String>" in model, "create request must carry optional atomic deployment intent"
assert "deployment.as_ref()" in routes, "create route must persist tenant and deployment intent together"
assert "now.clone()" not in model, "DateTime<Utc> is Copy here; keep model classification free of redundant clones"
create_start = store.index("pub async fn create_tenant")
create_end = store.index("pub async fn update_branding", create_start)
create_body = store[create_start:create_end]
assert "self.tenant_by_slug" not in create_body, "create+deploy must not add a fallible post-commit read that creates ambiguous success"

workflow = (root / ".github/workflows/ci.yml").read_text()
assert "cargo check --locked --workspace --all-targets" not in workflow, "CI hot path must not re-add redundant cargo check before locked clippy + tests"
for line in workflow.splitlines():
    if "uses:" in line:
        ref = line.split("@", 1)[-1].split()[0] if "@" in line else ""
        assert len(ref) == 40 and all(ch in "0123456789abcdef" for ch in ref), f"GitHub Action must be SHA-pinned: {line.strip()}"
print(f"CONTROL_PLANE_STATIC=PASS checks={len(checks)} auth=styled-edge-basic+tab-session+server-bearer freshness=bounded provisioning=idempotent")
