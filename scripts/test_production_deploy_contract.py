from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy-production-exact.sh"
WRAPPER = ROOT / "scripts/deploy-production.sh"
DOCKERFILE = ROOT / "Dockerfile"
MAKEFILE = ROOT / "Makefile"
AREA_COMPOSE = ROOT / "deploy/compose.area.production.yml"
CADDYFILE = ROOT / "deploy/virya-area-tunnel.Caddyfile"
CONFIG = ROOT / "crates/control-plane-api/src/config.rs"
OPERATIONS = ROOT / "crates/control-plane-api/src/operations_routes.rs"
CI = ROOT / ".github/workflows/ci.yml"


class ProductionDeployContract(unittest.TestCase):
    def test_shell_syntax(self):
        subprocess.run(["bash", "-n", str(SCRIPT)], check=True)
        subprocess.run(["bash", "-n", str(WRAPPER)], check=True)

    def test_mac_deploy_is_exact_registry_based_and_fail_closed(self):
        text = SCRIPT.read_text()
        self.assertIn('CONTROL_PLANE_DEPLOY_HOST:-virya-crowdrelay', text)
        self.assertIn('production deploy must run from main', text)
        self.assertIn('origin/main mismatch', text)
        self.assertIn('CONTROL_PLANE_IMAGE_DIGEST', text)
        self.assertIn('ghcr.io/wojciechbator/crowdrelay-control-plane', text)
        self.assertIn('docker pull "$registry_ref"', text)
        self.assertIn('remote OCI revision mismatch', text)
        self.assertIn('remote image architecture mismatch', text)
        self.assertNotIn('docker buildx build', text)
        self.assertNotIn('docker save -o', text)
        self.assertNotIn('docker load -i', text)

    def test_ci_publishes_exact_main_image_and_digest_artifact(self):
        text = CI.read_text()
        self.assertIn('packages: write', text)
        self.assertIn('ghcr.io/${GITHUB_REPOSITORY_OWNER}/crowdrelay-control-plane:sha-${GITHUB_SHA}', text)
        # Both production architectures must be built and merged into one
        # release index; virya-crowdrelay is arm64 and virya-oracle is amd64.
        for platform in ('linux/amd64', 'linux/arm64'):
            self.assertIn(f'platform: {platform}', text)
        self.assertIn('ubuntu-24.04-arm', text)
        self.assertIn('docker buildx imagetools create --tag', text)
        self.assertIn('--build-arg "VCS_REF=${GITHUB_SHA}"', text)
        self.assertIn('--push', text)
        self.assertIn('CONTROL_PLANE_IMAGE_DIGEST=', text)
        self.assertIn('control-plane-image-digest-${{ github.sha }}', text)
        self.assertIn('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02', text)

    def test_wrapper_checks_release_identity_before_remote_mutation(self):
        text = WRAPPER.read_text()
        clean = text.index("local worktree must be clean")
        branch = text.index("production deploy must run from main")
        remote = text.index("origin/main mismatch")
        scp = text.index('scp -q "$AREA_SOURCE"')
        self.assertLess(clean, scp)
        self.assertLess(branch, scp)
        self.assertLess(remote, scp)

    def test_wrapper_self_heals_runtime_overlay_without_restart(self):
        text = WRAPPER.read_text()
        self.assertIn('compose.area.production.yml', text)
        self.assertIn('docker compose -f compose.production.yml -f "$candidate" config --format json', text)
        self.assertIn('CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY', text)
        self.assertIn('install -m 0644 "$candidate" compose.area.yml', text)
        self.assertIn('BOOTSTRAP_OVERLAY=PASS management_wiring=canonical runtime_restarted=false', text)
        self.assertIn('exec bash "$ROOT_DIR/scripts/deploy-production-exact.sh"', text)
        self.assertNotIn('docker compose up', text)

    def test_management_wiring_preflight_is_semantic(self):
        text = SCRIPT.read_text()
        self.assertIn('compose config --format json', text)
        self.assertIn('MANAGEMENT_WIRING=PASS semantic=true', text)
        self.assertIn('effective app config is missing CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY', text)
        self.assertIn('effective app config is missing CONTROL_PLANE_MANAGEMENT_MASTER_KEY', text)
        self.assertIn('effective app config has invalid CONTROL_PLANE_VIRYA_MANAGEMENT_URL', text)
        self.assertIn('effective management masters must be distinct', text)

    def test_rollback_is_armed_before_first_runtime_file_mutation(self):
        text = SCRIPT.read_text()
        armed = text.index("mutated=true")
        canonical_install = text.index("install_canonical_infra\n", armed)
        self.assertLess(armed, canonical_install)

    def test_rollback_restores_old_app_but_keeps_canonical_infra(self):
        text = SCRIPT.read_text()
        restore = text.split("restore_release_state()", 1)[1].split("verify_tunnel_contract()", 1)[0]
        self.assertIn('cp -p "$backup_dir/.env" .env', restore)
        self.assertIn("install_canonical_infra", restore)
        self.assertNotIn('backup_dir/compose.area.yml', restore)
        self.assertNotIn('backup_dir/virya-area-tunnel.Caddyfile', restore)
        self.assertIn('ROLLBACK=PASS restored_tag=%s app=%s tunnel=%s canonical_infra=true', text)
        self.assertIn('verify_tunnel_contract', text)

    def test_caddy_preflight_is_pinned_and_does_not_require_existing_tunnel(self):
        text = SCRIPT.read_text()
        start = text.index('caddy_image="$(python3 - "$area_source"')
        end = text.index('old_tag=', start)
        preflight = text[start:end]
        self.assertIn('caddy@sha256:[0-9a-f]{64}', preflight)
        self.assertIn('docker image inspect "$caddy_image"', preflight)
        self.assertIn('timeout 90s docker pull "$caddy_image"', preflight)
        self.assertIn('--cap-drop ALL', preflight)
        self.assertIn('--cap-add NET_BIND_SERVICE', preflight)
        self.assertIn('CADDY_PREFLIGHT=PASS source=canonical image=pinned', preflight)
        self.assertNotIn('docker inspect crowdrelay-control-plane-virya-area-tunnel-1', preflight)

    def test_tunnel_verification_uses_health_and_avoids_pipefail_grep_race(self):
        text = SCRIPT.read_text()
        verify = text.split("verify_tunnel_contract()", 1)[1].split("rollback()", 1)[0]
        self.assertIn("tunnel_health", verify)
        self.assertIn('[[ "$tunnel_health" == "healthy" ]]', verify)
        self.assertIn('cmp -s <(docker exec crowdrelay-control-plane-virya-area-tunnel-1 cat /etc/caddy/Caddyfile)', verify)
        self.assertIn('runtime_caddy="$(docker exec crowdrelay-control-plane-virya-area-tunnel-1 cat /etc/caddy/Caddyfile)"', verify)
        self.assertIn('grep -Fq "$route" <<<"$runtime_caddy"', verify)
        self.assertNotIn('| grep -Fq', verify)

    def test_app_and_tunnel_are_one_release_unit(self):
        text = SCRIPT.read_text()
        self.assertIn('--force-recreate app virya-area-tunnel', text)
        self.assertIn('network_mode', text)
        self.assertIn('tunnel Caddyfile', text)
        self.assertIn('/srv/crowdrelay-control-plane', text)
        self.assertIn('CONTROL_PLANE_VIRYA_MANAGEMENT_URL', text)
        self.assertIn('http://127.0.0.1:18080', text)

    def test_deploy_has_rollback_readiness_and_e2e_gate(self):
        text = SCRIPT.read_text()
        self.assertIn('ROLLBACK=START', text)
        self.assertIn('ROLLBACK=PASS', text)
        self.assertIn('restore_release_state', text)
        self.assertIn('wait_for_tunnel', text)
        self.assertIn('/api/v1/tenants/virya/operations/summary', text)
        self.assertIn('/api/v1/tenants/virya/operations/attention', text)
        self.assertIn('operations summary is not an object', text)
        self.assertIn('http.p95_ms missing', text)
        self.assertIn('CONTROL_PLANE_DEPLOY=PASS', text)

    def test_runtime_image_carries_source_revision(self):
        dockerfile = DOCKERFILE.read_text()
        self.assertIn('ARG VCS_REF=unknown', dockerfile)
        self.assertIn('LABEL org.opencontainers.image.revision=$VCS_REF', dockerfile)

    def test_canonical_tunnel_config_is_source_controlled_and_healthy(self):
        area = AREA_COMPOSE.read_text()
        caddy = CADDYFILE.read_text()
        self.assertIn('CONTROL_PLANE_AREA_MANAGEMENT_MASTER_KEY', area)
        self.assertIn('CONTROL_PLANE_MANAGEMENT_MASTER_KEY', area)
        self.assertIn('CONTROL_PLANE_VIRYA_MANAGEMENT_URL', area)
        self.assertIn('network_mode: "service:app"', area)
        self.assertIn('VIRYA_AREA_UPSTREAM required', area)
        self.assertIn('NET_BIND_SERVICE', area)
        self.assertIn('virya-area-tunnel.Caddyfile:/etc/caddy/Caddyfile:ro', area)
        self.assertIn('healthcheck:', area)
        self.assertIn('http://127.0.0.1:18080/healthz/ready', area)
        self.assertIn('/healthz/ready', caddy)
        self.assertIn('/v1/control-plane/ops/summary', caddy)
        self.assertIn('/v1/control-plane/ecosystem/flags', caddy)
        self.assertIn('/v1/control-plane/autopilot/overview', caddy)
        self.assertIn('respond 404', caddy)

    def test_management_config_has_no_silent_virya_fallback(self):
        config = CONFIG.read_text()
        self.assertNotIn('DEFAULT_VIRYA_MANAGEMENT_URL', config)
        self.assertIn('area_management_master_key.is_some() || management_master_key.is_some()', config)
        self.assertIn('CONTROL_PLANE_VIRYA_MANAGEMENT_URL is required when tenant management is configured', config)

    def test_operations_proxy_rejects_wrong_success_shapes(self):
        operations = OPERATIONS.read_text()
        self.assertIn('fn object_no_store', operations)
        self.assertIn('if !value.is_object()', operations)
        self.assertIn('fn array_no_store', operations)
        self.assertIn('if !value.is_array()', operations)
        self.assertIn('array_no_store(value, "flags")', operations)
        self.assertIn('object_no_store(value, "summary")', operations)
        self.assertIn('returned an invalid JSON shape', operations)

    def test_makefile_exposes_single_canonical_command(self):
        makefile = MAKEFILE.read_text()
        self.assertIn('deploy-production:', makefile)
        self.assertIn('bash scripts/deploy-production.sh', makefile)
        self.assertNotIn('bash scripts/deploy-production-exact.sh\n', makefile)


if __name__ == "__main__":
    unittest.main()