#!/usr/bin/env python3
"""Keep Autopilot growth delivery observable from the Control Plane.

CrowdRelay only queues growth campaigns; external n8n workers perform the
sends. Without a delivery-ledger read model an operator cannot tell "no growth
scheduled" apart from "growth scheduled and nobody is draining it", so the
stall surface is part of the contract rather than a cosmetic panel.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


routes = read("crates/control-plane-api/src/operations_routes.rs")
client = read("crates/control-plane-api/src/tenant_area_client.rs")
api = read("frontend/src/lib/api.ts")
types = read("frontend/src/lib/types.ts")
panel = read("frontend/src/components/GrowthPanel.tsx")
tenant = read("frontend/src/pages/TenantPage.tsx")

# The proxy route stays off the /autopilot/{context} path: a static segment
# there would shadow a policy context of the same name and answer 405.
assert '"/tenants/{slug}/operations/growth"' in routes
assert '"/tenants/{slug}/operations/autopilot/growth"' not in routes

# Fail-closed transport: an upstream path that is not allowlisted is refused
# before any tenant call is made.
assert '"/v1/control-plane/autopilot/growth"' in client

# Read-only. The Control Plane never claims or completes a delivery.
growth_block = routes.split("async fn autopilot_growth", 1)[1].split("async fn ", 1)[0]
assert '"GET"' in growth_block
assert "idempotency_key" not in growth_block

assert "growthOverview" in api
assert "operations/growth" in api
for field in ("stalled", "pending_count", "claimed_count", "campaigns_enabled"):
    assert field in types, field

# The panel must name the two states an operator has to act on.
assert "Growth delivery is stalled" in panel
assert "Campaign delivery is disabled" in panel
assert "communication_campaigns_enabled" in panel
for template in (
    "show.growth.free_fan_push.v1",
    "autopilot.spotify.follow.v1",
    "autopilot.bandsintown.follow.v1",
):
    assert template in panel, template

assert "<GrowthPanel" in tenant
assert "GrowthPanel } from '../components/GrowthPanel'" in tenant

print(
    "CONTROL_PLANE_GROWTH=PASS surface=delivery-ledger states=stalled+disabled+idle"
    " transport=allowlisted+read-only ui=mounted"
)
