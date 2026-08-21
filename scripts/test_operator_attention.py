#!/usr/bin/env python3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


class OperatorAttentionContract(unittest.TestCase):
    def test_operator_attention_surface_is_routed_and_live(self) -> None:
        main = read("frontend/src/main.tsx")
        shell = read("frontend/src/components/Shell.tsx")
        page = read("frontend/src/pages/OperatorAttentionPage.tsx")
        api = read("frontend/src/lib/api.ts")
        attention = read("frontend/src/lib/attention.ts")
        route = read("crates/control-plane-api/src/attention_routes.rs")

        self.assertIn("path: '/attention'", main)
        self.assertIn("OperatorAttentionPage", main)
        self.assertIn('to="/attention"', shell)
        self.assertIn("Operator attention required", page)
        self.assertIn("Dead outbox", page)
        self.assertIn("Dead deliveries", page)
        self.assertIn("Dead push", page)
        self.assertIn("Critical watchdog", page)
        self.assertIn("tenant-operator-attention-snapshot", page)
        self.assertEqual(page.count("refetchInterval: 30_000"), 1)
        self.assertNotIn("refetchInterval: 15_000", page)
        self.assertIn("fetchOperationsAttention", page)
        self.assertIn("/operations/attention", attention)
        # One tenant call, not a five-way fan-out: CrowdRelay assembles the
        # snapshot itself, so a slow section cannot stall four other tunnel
        # requests. Fanning out again would silently reintroduce that.
        self.assertIn("/v1/control-plane/ops/attention", route)
        self.assertEqual(route.count("request_management("), 1)
        self.assertNotIn("tokio::try_join!", route)
        # The sections are still re-projected, so an upstream field addition
        # cannot leak into the Control Plane contract unreviewed.
        for part in ("summary", "dead_outbox", "dead_deliveries", "ecosystem", "findings"):
            self.assertIn(f'"{part}"', route)
        self.assertIn("Usuń stare dead queues", page)
        self.assertIn("Potwierdź cleanup", page)
        self.assertIn("api.clearDeadDeliveries", page)
        self.assertIn("'idempotency-key': crypto.randomUUID()", api)

    def test_dead_delivery_clear_stays_narrow_and_audited(self) -> None:
        routes = read("crates/control-plane-api/src/operations_routes.rs")
        tunnel = read("deploy/virya-area-tunnel.Caddyfile")

        self.assertIn('/operations/dead-deliveries/clear', routes)
        self.assertIn('/v1/control-plane/ops/deliveries/dead/clear', routes)
        self.assertIn('tenant.dead_deliveries.cleared', routes)
        self.assertIn('idempotency_key(&headers)', routes)
        self.assertIn('/v1/control-plane/ops/deliveries/dead/clear', tunnel)
        self.assertNotIn('/v1/admin', tunnel)


if __name__ == "__main__":
    unittest.main()
