from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = (ROOT / "crates/control-plane-api/src/operations_routes.rs").read_text()
ATTENTION_ROUTES = (ROOT / "crates/control-plane-api/src/attention_routes.rs").read_text()
CLIENT = (ROOT / "crates/control-plane-api/src/tenant_area_client.rs").read_text()
CADDY = (ROOT / "deploy/virya-area-tunnel.Caddyfile").read_text()
API = (ROOT / "frontend/src/lib/api.ts").read_text()
ATTENTION_API = (ROOT / "frontend/src/lib/attention.ts").read_text()
TYPES = (ROOT / "frontend/src/lib/types.ts").read_text()
UI = (ROOT / "frontend/src/pages/OperatorAttentionPage.tsx").read_text()
OPERATIONS_PANEL = (ROOT / "frontend/src/components/OperationsPanel.tsx").read_text()


class OperatorMaintenanceContract(unittest.TestCase):
    def test_backend_exposes_only_bounded_control_plane_paths(self) -> None:
        for token in (
            "/v1/control-plane/ops/outbox?status=dead&limit=50",
            "/v1/control-plane/ops/deliveries?status=dead&limit=50",
            "/v1/control-plane/ops/outbox/{event_id}/retry",
            "/v1/control-plane/ops/deliveries/{delivery_id}/retry",
            "/v1/control-plane/ops/operations/{request_id}",
            "/v1/control-plane/ecosystem/overview",
            "/v1/control-plane/ecosystem/findings?limit=50&open_only=true",
            "/v1/control-plane/ecosystem/reconcile",
        ):
            self.assertIn(token, ROUTES)
        self.assertNotIn("/v1/admin/", ROUTES)
        self.assertIn("Uuid::parse_str", ROUTES)
        self.assertIn("correlation_segment", ROUTES)

    def test_internal_transport_allowlist_matches_bounded_proxy(self) -> None:
        for token in (
            "/v1/control-plane/ops/outbox?status=dead&limit=50",
            "/v1/control-plane/ops/deliveries?status=dead&limit=50",
            "/v1/control-plane/ecosystem/overview",
            "/v1/control-plane/ecosystem/findings?limit=50&open_only=true",
            "/v1/control-plane/ops/deliveries/dead/clear",
            "/v1/control-plane/ecosystem/reconcile",
            "/v1/control-plane/ops/outbox/",
            "/v1/control-plane/ops/deliveries/",
            "/v1/control-plane/ops/operations/",
        ):
            self.assertIn(token, CLIENT)
        self.assertIn("uuid_segment_between", CLIENT)
        self.assertIn("timeline_segment", CLIENT)
        self.assertIn("valid_operations_request", CLIENT)
        self.assertNotIn('path.starts_with("/v1/control-plane/ops/")', CLIENT)

    def test_mutations_require_idempotency_and_are_audited(self) -> None:
        self.assertGreaterEqual(ROUTES.count("idempotency_key(&headers)?"), 6)
        for action in (
            "tenant.dead_outbox.retried",
            "tenant.dead_delivery.retried",
            "tenant.dead_deliveries.cleared",
            "tenant.ecosystem.reconciled",
        ):
            self.assertIn(action, ROUTES)
        self.assertIn('json!({ "trigger": "manual" })', ROUTES)
        self.assertIn("valid Idempotency-Key is required for tenant operation mutations", CLIENT)

    def test_tunnel_remains_narrow_and_has_readiness(self) -> None:
        for token in (
            "/healthz/ready",
            "/v1/control-plane/ops/outbox",
            "/v1/control-plane/ops/outbox/*",
            "/v1/control-plane/ops/deliveries",
            "/v1/control-plane/ops/deliveries/dead/clear",
            "/v1/control-plane/ops/deliveries/*",
            "/v1/control-plane/ops/operations/*",
            "/v1/control-plane/ecosystem/overview",
            "/v1/control-plane/ecosystem/findings",
            "/v1/control-plane/ecosystem/reconcile",
        ):
            self.assertIn(token, CADDY)
        self.assertNotIn("/v1/admin", CADDY)

    def test_frontend_has_typed_maintenance_surfaces(self) -> None:
        for token in (
            "DatabaseRuntimeSummary",
            "AreaRuntimeSummary",
            "OutboxItem",
            "DeliveryDetails",
            "OperationTimeline",
            "ReconciliationFinding",
        ):
            self.assertIn(token, TYPES)
        for token in (
            "deadOutbox:",
            "retryOutbox:",
            "deadDeliveries:",
            "deliveryDetails:",
            "retryDelivery:",
            "operationTimeline:",
            "reconciliationFindings:",
            "runReconciliation:",
        ):
            self.assertIn(token, API)
        self.assertIn("OperationsAttentionSnapshot", ATTENTION_API)
        self.assertIn("fetchOperationsAttention", ATTENTION_API)

    def test_operator_attention_uses_one_periodic_snapshot(self) -> None:
        # One poll in the browser, one tenant call behind it.
        self.assertIn("/v1/control-plane/ops/attention", ATTENTION_ROUTES)
        self.assertEqual(ATTENTION_ROUTES.count("request_management("), 1)
        self.assertEqual(UI.count("refetchInterval: 30_000"), 1)
        self.assertNotIn("refetchInterval: 15_000", UI)
        self.assertIn("fetchOperationsAttention", UI)
        for token in (
            "POSTGRES RUNTIME",
            "AREA RUNTIME",
            "DEAD OUTBOX",
            "DEAD WEBHOOK DELIVERIES",
            "DELIVERY DETAILS",
            "RECONCILIATION",
            "REQUEST TIMELINE",
            "Run reconciliation",
            "Retry",
        ):
            self.assertIn(token, UI)

    def test_release_convergence_lists_missing_components_explicitly(self) -> None:
        self.assertIn("No production release receipt reported yet.", OPERATIONS_PANEL)
        self.assertIn("release-component-missing", OPERATIONS_PANEL)
        self.assertIn('status="missing"', OPERATIONS_PANEL)
        self.assertIn("component.environment", OPERATIONS_PANEL)
        self.assertIn("component.deploy_ref", OPERATIONS_PANEL)


if __name__ == "__main__":
    unittest.main()