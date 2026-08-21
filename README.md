# CrowdRelay Control Plane

**Rust / Axum / SQLx / PostgreSQL + SolidJS operations plane** for tenant provisioning, runtime health, branding, deployment identity and audit.

It is deliberately separate from Virya Staff: infrastructure and tenant lifecycle live here, while band operations stay in the band-facing product. The Control Plane is **not** required for CrowdRelay/Signal request handling and therefore cannot become a runtime dependency of tenant traffic.

## Engineering snapshot

- **Atomic provisioning intent:** tenant creation and its approved provisioning job commit in one database transaction; invalid deployment intent cannot leave a half-created tenant.
- **No Docker authority in the HTTP API:** a separately authenticated host agent claims fixed-schema jobs through crash-recoverable leases and reports terminal results back.
- **Idempotent recovery:** identical completion retries are accepted; contradictory terminal results fail closed; a dead reporter naturally turns runtime state stale instead of leaving a tenant green forever.
- **Credential separation:** admin, telemetry, provisioner and tenant-management channels use distinct server-side authorities rather than one platform super-token.
- **Browser secret boundary:** the SPA never receives the platform admin bearer; Caddy authenticates the browser and injects the server-held token only on the localhost upstream hop.
- **Exact release identity:** production builds carry the exact Git revision, deployment validates management wiring before mutation and the release ends with a real CrowdRelay operations-summary E2E.
- **Rollback-aware deployment:** failures after mutation restore the previous application image without resurrecting stale management/tunnel configuration.

This is intentionally a small operations plane rather than a second distributed control system. PostgreSQL owns durable intent and lease state; the host provisioner owns local runtime mutation.

## Product boundary

- CrowdRelay and Virya Signal are tenant products.
- Virya is seeded as the platform-owner tenant.
- Virya branding defaults to **inherit product defaults**, preserving the current CrowdRelay/Signal palette until a custom palette is explicitly saved.
- Synesthesia is not tenantized; the database enforces `synesthesia_enabled => slug = 'virya'`.
- Tenant traffic does not depend on the Control Plane being healthy.

## Stack

- Rust + Axum 0.8 + SQLx/PostgreSQL
- SolidJS + TanStack Solid Router + TanStack Solid Query + Vite
- One production binary serves `/api/v1/*` and the built SPA

Axum's typed `State` model is used for global application state, while admin authorization is enforced at the request boundary. TanStack Solid Query owns server-state caching/refetching and TanStack Solid Router owns typed client navigation.

## Tenant provisioning

The Tenants screen can create a registry entry alone or use **Create & deploy**. The deployment variant is atomic at the database boundary: tenant row and approved provisioning job are persisted together.

`deploy/provisioner.py` is a separately authenticated host agent. It:

1. claims approved jobs with a lease;
2. validates a fixed plan schema;
3. renders a fixed tenant-isolated Docker Compose stack;
4. creates per-tenant Postgres volume, setup/API/worker services and loopback-only API binding;
5. keeps generated secrets host-local;
6. reports success/failure and runtime health through explicit machine APIs.

At most one `planned`/`approved`/`running` job may exist per tenant. Claims are leased and crash-recoverable. Completion is idempotent for identical results and fail-closed for contradictory terminal outcomes.

The provisioner creates only the local CrowdRelay instance. Public DNS/edge routing is deliberately a separate infrastructure step.

## Authorization boundaries

Operator routes require the platform admin authority. The production browser does **not** receive that token: it authenticates to Caddy with Basic Auth, then Caddy replaces the verified Basic header with the server-held admin bearer only for the localhost upstream.

Runtime telemetry uses a different bearer and cannot mutate tenants. Provisioning uses a third bearer. Tenant AREA/operations forwarding uses separate server-only tenant management keys and an explicit allowlist of forwarded paths.

Configured secrets are hashed and compared in constant time.

## Key API groups

```text
/api/v1/overview
/api/v1/tenants/*
/api/v1/tenants/:slug/provisioning/*
/api/v1/tenants/:slug/runtime
/api/v1/tenants/:slug/area/*
/api/v1/tenants/:slug/operations/*
/api/v1/provisioner/*
```

The exact route list and request/response shapes are implemented in the API crate and exercised by repository/contract tests.

## Local run

```bash
cp .env.example .env
# set CONTROL_PLANE_ADMIN_TOKEN and CONTROL_PLANE_TELEMETRY_TOKEN to different random 32+ character secrets

docker compose up -d postgres
export DATABASE_URL=postgres://control_plane:control-plane-local@127.0.0.1:5433/control_plane
export CONTROL_PLANE_ADMIN_TOKEN='replace-with-a-long-random-token'
export CONTROL_PLANE_TELEMETRY_TOKEN='replace-with-a-different-long-random-token'

cd frontend
npm ci
npm run dev

# separate shell
cargo run -p crowdrelay-control-plane-api
```

Vite proxies `/api` and `/healthz` to `127.0.0.1:8090`. In local development the Vite **server-side proxy** injects `CONTROL_PLANE_ADMIN_TOKEN`; the token is never compiled into the browser bundle.

## Production deployment

The canonical deployment is one command from a clean local `main` that exactly matches `origin/main`:

```bash
make deploy-production
```

The deploy builds an immutable `linux/amd64` image carrying the exact Git revision, transfers the release unit, validates management wiring before mutation, recreates app+tunnel together, verifies network/mount/runtime revision and finishes with a real Virya operations-summary E2E.

## Quality gates

```bash
make static
make ci
```

GitHub Actions is the release-validation source of truth. It runs static/Python contracts, PostgreSQL migration smoke, Rust fmt/clippy/tests and frontend tests/build/budget.

The Web production budget is intentionally small: 260 KiB raw JS and 80 KiB raw CSS. The committed lockfile is used with `npm ci` in CI/Docker for deterministic installs.

## Runtime freshness

Runtime health is classified server-side as `healthy`, `degraded`, `stale` or `unknown`. `CONTROL_PLANE_RUNTIME_STALE_AFTER_SECONDS` defaults to 180 seconds, so a once-healthy tenant cannot remain green forever after its reporter dies. Heartbeat-only refreshes update status without appending audit noise; audit is reserved for first observation or meaningful health/schema/deployment changes.
