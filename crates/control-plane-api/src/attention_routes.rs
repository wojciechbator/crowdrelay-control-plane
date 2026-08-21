//! Aggregated, read-only operator-attention snapshot.
//!
//! The browser polls one endpoint instead of five independent Control Plane
//! routes. CrowdRelay remains canonical for every constituent read model.
//!
//! CrowdRelay assembles the snapshot itself, so this is a single tenant call
//! rather than a five-way fan-out through the private tunnel: the upstream
//! runs the sections concurrently under its own per-section timeout, and one
//! slow read can no longer stall four other tunnel requests. The response is
//! still re-projected field by field so an upstream addition cannot leak into
//! the Control Plane contract unreviewed.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};

use crate::{AppState, error::ApiError, tenant_area_client::ManagementRequest};

const PRIVATE_NO_STORE: &str = "private, no-store";

pub fn router() -> Router<AppState> {
    Router::new().route("/tenants/{slug}/operations/attention", get(attention))
}

fn correlation(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .or_else(|| {
            headers
                .get("x-crowdrelay-correlation-id")
                .and_then(|value| value.to_str().ok())
        })
}

fn expect_object(value: &Value, name: &str) -> Result<(), ApiError> {
    if value.is_object() {
        Ok(())
    } else {
        Err(ApiError::Unavailable(format!(
            "tenant attention {name} returned an invalid JSON shape"
        )))
    }
}

fn expect_array(value: &Value, name: &str) -> Result<(), ApiError> {
    if value.is_array() {
        Ok(())
    } else {
        Err(ApiError::Unavailable(format!(
            "tenant attention {name} returned an invalid JSON shape"
        )))
    }
}

fn section<'a>(snapshot: &'a Value, name: &str) -> Result<&'a Value, ApiError> {
    snapshot.get(name).ok_or_else(|| {
        ApiError::Unavailable(format!("tenant attention snapshot is missing {name}"))
    })
}

async fn attention(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (tenant, target) = crate::area_routes::target(&state, &slug).await?;
    let snapshot = state
        .area_client
        .request_management(
            tenant.tenant.id,
            &target,
            ManagementRequest {
                method: "GET",
                path: "/v1/control-plane/ops/attention",
                body: None,
                correlation_id: correlation(&headers),
                idempotency_key: None,
            },
        )
        .await?;

    Ok((
        StatusCode::OK,
        [(CACHE_CONTROL, PRIVATE_NO_STORE)],
        Json(project(&snapshot)?),
    )
        .into_response())
}

/// Re-project the upstream snapshot field by field.
///
/// Passing the tenant response through verbatim would let an upstream field
/// addition enter the Control Plane contract without review, so each section is
/// named and type-checked here exactly as the five-call version checked its
/// five responses.
fn project(snapshot: &Value) -> Result<Value, ApiError> {
    expect_object(snapshot, "snapshot")?;
    let summary = section(snapshot, "summary")?;
    let dead_outbox = section(snapshot, "dead_outbox")?;
    let dead_deliveries = section(snapshot, "dead_deliveries")?;
    let ecosystem = section(snapshot, "ecosystem")?;
    let findings = section(snapshot, "findings")?;

    expect_object(summary, "summary")?;
    expect_array(dead_outbox, "dead outbox")?;
    expect_array(dead_deliveries, "dead deliveries")?;
    expect_object(ecosystem, "ecosystem")?;
    expect_array(findings, "findings")?;

    Ok(json!({
        "summary": summary,
        "dead_outbox": dead_outbox,
        "dead_deliveries": dead_deliveries,
        "ecosystem": ecosystem,
        "findings": findings,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({
            "summary": {"outbox": {"pending": 1}},
            "dead_outbox": [{"id": "a"}],
            "dead_deliveries": [],
            "ecosystem": {"schema_version": 1, "flags": []},
            "findings": [{"id": "f"}],
        })
    }

    #[test]
    fn projects_every_section_of_a_well_formed_snapshot() {
        let projected = project(&snapshot()).expect("well-formed snapshot projects");
        assert_eq!(projected, snapshot());
    }

    #[test]
    fn drops_fields_the_control_plane_contract_does_not_name() {
        let mut extra = snapshot();
        extra["surprise_upstream_addition"] = json!({"leaked": true});
        let projected = project(&extra).expect("unknown fields are ignored, not fatal");
        assert_eq!(projected, snapshot());
        assert!(projected.get("surprise_upstream_addition").is_none());
    }

    #[test]
    fn rejects_a_snapshot_missing_a_section() {
        for name in [
            "summary",
            "dead_outbox",
            "dead_deliveries",
            "ecosystem",
            "findings",
        ] {
            let mut partial = snapshot();
            partial.as_object_mut().expect("object").remove(name);
            let error = project(&partial).expect_err("missing section must fail");
            assert!(
                matches!(&error, ApiError::Unavailable(message) if message.contains(name)),
                "{name} should be named in the error"
            );
        }
    }

    #[test]
    fn rejects_a_section_of_the_wrong_json_type() {
        let mut wrong = snapshot();
        wrong["dead_outbox"] = json!({"not": "an array"});
        assert!(project(&wrong).is_err());

        let mut also_wrong = snapshot();
        also_wrong["summary"] = json!([]);
        assert!(project(&also_wrong).is_err());
    }

    #[test]
    fn rejects_a_snapshot_that_is_not_an_object() {
        assert!(project(&json!([])).is_err());
        assert!(project(&json!("degraded")).is_err());
    }
}
