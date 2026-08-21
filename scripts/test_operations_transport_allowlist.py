#!/usr/bin/env python3
"""Ensure every shipped tenant-operations upstream call survives the transport allowlist."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
# Every file that issues tenant calls, not just the operations proxy: a route
# that lives elsewhere still has to clear the allowlist and the tunnel.
ROUTE_FILES = (
    "crates/control-plane-api/src/operations_routes.rs",
    "crates/control-plane-api/src/attention_routes.rs",
)
ROUTES = "\n".join(
    (ROOT / relative).read_text(encoding="utf-8") for relative in ROUTE_FILES
)
CLIENT = (ROOT / "crates/control-plane-api/src/tenant_area_client.rs").read_text(encoding="utf-8")
TUNNEL = (ROOT / "deploy/virya-area-tunnel.Caddyfile").read_text(encoding="utf-8")


class OperationsTransportAllowlistContract(unittest.TestCase):
    def test_every_shipped_upstream_path_is_represented_in_allowlist(self) -> None:
        allowlist = CLIENT.split("fn valid_operations_request", 1)[1].split("\nfn ", 1)[0]

        static_paths = set(re.findall(r'"(/v1/control-plane/[^"{]+)"', ROUTES))
        dynamic_prefixes = {
            prefix
            for prefix in re.findall(r'format!\("(/v1/control-plane/[^"{]+)\{', ROUTES)
        }

        self.assertTrue(static_paths, "no static upstream paths found in operations_routes.rs")
        for path in sorted(static_paths):
            self.assertIn(
                f'"{path}"',
                allowlist,
                f"upstream path is not represented in valid_operations_request: {path}",
            )

        for prefix in sorted(dynamic_prefixes):
            if f'"{prefix}' in allowlist:
                continue
            helper = re.search(
                rf"fn\s+([a-z_][a-z0-9_]*)\([^)]*\)[^{{]*\{{(?:(?!\nfn\s).)*{re.escape(prefix)}",
                CLIENT,
                flags=re.DOTALL,
            )
            self.assertIsNotNone(
                helper,
                f"dynamic upstream family has no allowlist helper: {prefix}",
            )
            helper_name = helper.group(1)
            self.assertIn(
                f"{helper_name}(path)",
                allowlist,
                f"allowlist helper for {prefix} is not invoked by valid_operations_request",
            )

    def test_every_allowlisted_path_is_reachable_through_the_tunnel(self) -> None:
        """The allowlist is necessary but not sufficient.

        Tenant calls reach CrowdRelay through a Caddy matcher that answers 404
        for anything it does not list. A path can therefore pass every
        Control Plane guard and still fail in production, which looks like an
        upstream outage rather than a missing line of config.
        """
        matcher = TUNNEL.split("@operations path", 1)[1].split("\n\n", 1)[0]
        tunnel_paths = set(re.findall(r"/v1/control-plane/[^\\\s]+", matcher))
        self.assertTrue(tunnel_paths, "no control-plane paths found in the tunnel matcher")

        allowlist = CLIENT.split("fn valid_operations_request", 1)[1].split("\nfn ", 1)[0]
        # Caddy matches on path only, so drop the query string before comparing.
        allowlisted = {
            path.split("?", 1)[0]
            for path in re.findall(r'"(/v1/control-plane/[^"]+)"', allowlist)
        }
        self.assertTrue(allowlisted, "no literal paths found in the allowlist")

        for path in sorted(allowlisted):
            covered = path in tunnel_paths or any(
                candidate.endswith("/*") and path.startswith(candidate[:-1])
                for candidate in tunnel_paths
            )
            self.assertTrue(covered, f"tunnel does not route allowlisted path: {path}")

    def test_allowlist_stays_fail_closed(self) -> None:
        allowlist = CLIENT.split("fn valid_operations_request", 1)[1].split("\nfn ", 1)[0]
        self.assertNotIn('path.starts_with("/v1/control-plane/ops/")', allowlist)
        self.assertNotIn('"/v1/admin/', allowlist)
        self.assertIn('"/v1/control-plane/ops/deliveries/dead/clear"', allowlist)


if __name__ == "__main__":
    unittest.main()
