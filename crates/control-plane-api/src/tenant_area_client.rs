//! Hardened server-to-server transport for tenant AREA management.
//!
//! The browser never receives this credential. Only bare private/loopback
//! HTTP origins are accepted, redirects are refused, and response bodies are
//! bounded before JSON parsing.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::timeout,
};
use url::{Host, Url};
use uuid::Uuid;

use crate::error::ApiError;

const AREA_NAMESPACE: &[u8] = b"crowdrelay-area-admin-v1:";
const CONTROL_PLANE_NAMESPACE: &[u8] = b"crowdrelay-control-plane-v1:";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct TenantAreaClient {
    master_key: Option<Arc<str>>,
    management_master_key: Option<Arc<str>>,
}

pub(crate) struct ManagementRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub body: Option<&'a Value>,
    pub correlation_id: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
}

impl TenantAreaClient {
    #[cfg(test)]
    #[must_use]
    pub fn new(master_key: Option<String>) -> Self {
        Self {
            master_key: master_key.map(Arc::from),
            management_master_key: None,
        }
    }

    #[must_use]
    pub fn with_management(
        master_key: Option<String>,
        management_master_key: Option<String>,
    ) -> Self {
        Self {
            master_key: master_key.map(Arc::from),
            management_master_key: management_master_key.map(Arc::from),
        }
    }

    pub fn derived_token(&self, tenant_id: Uuid) -> Result<String, ApiError> {
        derived_token(
            self.master_key.as_deref(),
            AREA_NAMESPACE,
            tenant_id,
            "AREA management is not configured",
        )
    }

    pub fn derived_management_token(&self, tenant_id: Uuid) -> Result<String, ApiError> {
        derived_token(
            self.management_master_key.as_deref(),
            CONTROL_PLANE_NAMESPACE,
            tenant_id,
            "tenant operations are not configured",
        )
    }

    pub async fn request(
        &self,
        tenant_id: Uuid,
        base_url: &str,
        method: &str,
        path_and_query: &str,
        body: Option<&Value>,
        correlation_id: Option<&str>,
    ) -> Result<Value, ApiError> {
        let area_path = path_and_query
            .split_once('?')
            .map_or(path_and_query, |(path, _)| path);
        if path_and_query.len() > 2_048
            || !(area_path == "/v1/control-plane/area"
                || area_path.starts_with("/v1/control-plane/area/"))
            || contains_request_whitespace(path_and_query)
        {
            return Err(ApiError::InvalidInput(
                "invalid AREA management path".to_owned(),
            ));
        }
        if !matches!(method, "GET" | "POST" | "PATCH" | "DELETE") {
            return Err(ApiError::InvalidInput(
                "invalid AREA management method".to_owned(),
            ));
        }
        let token = self.derived_token(tenant_id)?;
        request_authorized(
            base_url,
            method,
            path_and_query,
            body,
            correlation_id,
            None,
            &token,
        )
        .await
    }

    pub async fn request_management(
        &self,
        tenant_id: Uuid,
        base_url: &str,
        request: ManagementRequest<'_>,
    ) -> Result<Value, ApiError> {
        if !valid_operations_request(request.method, request.path)
            || contains_request_whitespace(request.path)
        {
            return Err(ApiError::InvalidInput(
                "invalid tenant operations request".to_owned(),
            ));
        }
        if matches!(request.method, "POST")
            && !request.idempotency_key.is_some_and(valid_idempotency_key)
        {
            return Err(ApiError::InvalidInput(
                "valid Idempotency-Key is required for tenant operation mutations".to_owned(),
            ));
        }
        if request
            .idempotency_key
            .is_some_and(|value| !valid_idempotency_key(value))
        {
            return Err(ApiError::InvalidInput("invalid Idempotency-Key".to_owned()));
        }
        let token = self.derived_management_token(tenant_id)?;
        request_authorized(
            base_url,
            request.method,
            request.path,
            request.body,
            request.correlation_id,
            request.idempotency_key,
            &token,
        )
        .await
    }
}

fn derived_token(
    master_key: Option<&str>,
    namespace: &[u8],
    tenant_id: Uuid,
    missing_message: &'static str,
) -> Result<String, ApiError> {
    let master_key = master_key.ok_or_else(|| ApiError::Unavailable(missing_message.to_owned()))?;
    let mut message = Vec::with_capacity(namespace.len() + 36);
    message.extend_from_slice(namespace);
    message.extend_from_slice(tenant_id.to_string().as_bytes());
    Ok(hex(&hmac_sha256(master_key.as_bytes(), &message)))
}

fn contains_request_whitespace(value: &str) -> bool {
    value
        .chars()
        .any(|character| matches!(character, '\r' | '\n' | ' ' | '\t'))
}

fn one_safe_segment(path: &str, prefix: &str) -> bool {
    path.strip_prefix(prefix).is_some_and(|segment| {
        !segment.is_empty()
            && segment.len() <= 96
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn uuid_segment_between(path: &str, prefix: &str, suffix: &str) -> bool {
    path.strip_prefix(prefix)
        .and_then(|tail| tail.strip_suffix(suffix))
        .is_some_and(|segment| !segment.is_empty() && Uuid::parse_str(segment).is_ok())
}

fn timeline_segment(path: &str) -> bool {
    path.strip_prefix("/v1/control-plane/ops/operations/")
        .is_some_and(|segment| {
            !segment.is_empty()
                && segment.len() <= 128
                && segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
                })
        })
}

fn valid_operations_request(method: &str, path: &str) -> bool {
    match method {
        "GET" => {
            matches!(
                path,
                "/v1/control-plane/ops/summary"
                    | "/v1/control-plane/ops/attention"
                    | "/v1/control-plane/ops/outbox?status=dead&limit=50"
                    | "/v1/control-plane/ops/deliveries?status=dead&limit=50"
                    | "/v1/control-plane/ecosystem/overview"
                    | "/v1/control-plane/ecosystem/findings?limit=50&open_only=true"
                    | "/v1/control-plane/ecosystem/flags"
                    | "/v1/control-plane/autopilot/overview"
                    | "/v1/control-plane/autopilot/growth"
            ) || uuid_segment_between(path, "/v1/control-plane/ops/deliveries/", "")
                || timeline_segment(path)
        }
        "POST" => {
            matches!(
                path,
                "/v1/control-plane/ops/deliveries/dead/clear"
                    | "/v1/control-plane/ecosystem/reconcile"
            ) || uuid_segment_between(path, "/v1/control-plane/ops/outbox/", "/retry")
                || uuid_segment_between(path, "/v1/control-plane/ops/deliveries/", "/retry")
                || one_safe_segment(path, "/v1/control-plane/ecosystem/flags/")
                || one_safe_segment(path, "/v1/control-plane/autopilot/policies/")
        }
        _ => false,
    }
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

async fn request_authorized(
    base_url: &str,
    method: &str,
    path_and_query: &str,
    body: Option<&Value>,
    correlation_id: Option<&str>,
    idempotency_key: Option<&str>,
    token: &str,
) -> Result<Value, ApiError> {
    let target = validate_management_target(base_url)?;
    let host = target
        .host_str()
        .ok_or_else(|| ApiError::InvalidInput("management target has no host".to_owned()))?;
    let port = target
        .port_or_known_default()
        .ok_or_else(|| ApiError::InvalidInput("management target has no port".to_owned()))?;

    let address = format_host_port(host, port);
    let mut stream = timeout(CONNECT_TIMEOUT, TcpStream::connect(&address))
        .await
        .map_err(|_| ApiError::Unavailable("AREA management connect timeout".to_owned()))?
        .map_err(|_| ApiError::Unavailable("AREA management target unavailable".to_owned()))?;

    let body_text = body.map(Value::to_string).unwrap_or_default();
    let host_header = host_header(host, target.port(), port);
    let mut request = format!(
        "{method} {path_and_query} HTTP/1.1\r\nHost: {host_header}\r\nAuthorization: Bearer {token}\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n"
    );
    if let Some(id) = correlation_id.filter(|id| valid_correlation_id(id)) {
        request.push_str("X-CrowdRelay-Correlation-Id: ");
        request.push_str(id);
        request.push_str("\r\n");
    }
    if let Some(key) = idempotency_key {
        request.push_str("Idempotency-Key: ");
        request.push_str(key);
        request.push_str("\r\n");
    }
    if body.is_some() {
        request.push_str("Content-Type: application/json\r\n");
    }
    if body.is_some() || matches!(method, "POST" | "PATCH") {
        request.push_str("Content-Length: ");
        request.push_str(&body_text.len().to_string());
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    request.push_str(&body_text);

    let exchange = async {
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|_| ApiError::Unavailable("AREA management write failed".to_owned()))?;

        // Keep the write side open while the peer produces its response.
        // The HTTP request is already self-framed (Content-Length when a body is present)
        // and carries `Connection: close`; half-closing the socket here can be interpreted
        // by an intermediary as a disconnected client and yield a header-only 2xx.
        let mut response = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|_| ApiError::Unavailable("AREA management read failed".to_owned()))?;
            if read == 0 {
                break;
            }
            if response.len().saturating_add(read) > MAX_RESPONSE_BYTES {
                return Err(ApiError::Unavailable(
                    "AREA management response exceeded limit".to_owned(),
                ));
            }
            response.extend_from_slice(&chunk[..read]);
        }
        parse_response(&response)
    };

    timeout(REQUEST_TIMEOUT, exchange)
        .await
        .map_err(|_| ApiError::Unavailable("AREA management request timeout".to_owned()))?
}

fn validate_management_target(value: &str) -> Result<Url, ApiError> {
    let parsed = Url::parse(value)
        .map_err(|_| ApiError::InvalidInput("invalid AREA management target".to_owned()))?;
    if parsed.scheme() != "http"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(ApiError::InvalidInput(
            "AREA management target must be a bare private HTTP origin".to_owned(),
        ));
    }
    let private = match parsed.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => private_v4(ip),
        Some(Host::Ipv6(ip)) => private_v6(ip),
        None => false,
    };
    if !private {
        return Err(ApiError::InvalidInput(
            "AREA management target must be loopback or private".to_owned(),
        ));
    }
    Ok(parsed)
}

fn private_v4(ip: Ipv4Addr) -> bool {
    ip.is_loopback() || ip.is_private()
}

fn private_v6(ip: Ipv6Addr) -> bool {
    ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn format_host_port(host: &str, port: u16) -> String {
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]:{port}"),
        _ => format!("{host}:{port}"),
    }
}

fn host_header(host: &str, explicit_port: Option<u16>, resolved_port: u16) -> String {
    let formatted_host = match host.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => format!("[{host}]"),
        _ => host.to_owned(),
    };
    if explicit_port.is_some() || resolved_port != 80 {
        format!("{formatted_host}:{resolved_port}")
    } else {
        formatted_host
    }
}

fn valid_correlation_id(value: &str) -> bool {
    (8..=128).contains(&value.len()) && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

fn parse_response(raw: &[u8]) -> Result<Value, ApiError> {
    let marker = b"\r\n\r\n";
    let Some(split) = raw
        .windows(marker.len())
        .position(|window| window == marker)
    else {
        return Err(ApiError::Unavailable(
            "malformed AREA management response".to_owned(),
        ));
    };
    let head = std::str::from_utf8(&raw[..split])
        .map_err(|_| ApiError::Unavailable("malformed AREA management headers".to_owned()))?;
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| ApiError::Unavailable("missing AREA management status".to_owned()))?;
    if (300..400).contains(&status) {
        return Err(ApiError::Unavailable(
            "AREA management redirect refused".to_owned(),
        ));
    }

    let mut transfer_chunked = false;
    let mut content_length = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            return Err(ApiError::Unavailable(
                "malformed AREA management header".to_owned(),
            ));
        };
        let name = name.trim();
        let value = value.trim();
        if name.eq_ignore_ascii_case("transfer-encoding") {
            let encodings = value
                .split(',')
                .map(str::trim)
                .filter(|encoding| !encoding.is_empty())
                .collect::<Vec<_>>();
            if encodings.len() != 1 || !encodings[0].eq_ignore_ascii_case("chunked") {
                return Err(ApiError::Unavailable(
                    "unsupported AREA management transfer encoding".to_owned(),
                ));
            }
            transfer_chunked = true;
        } else if name.eq_ignore_ascii_case("content-length") {
            let parsed = value.parse::<usize>().map_err(|_| {
                ApiError::Unavailable("invalid AREA management content length".to_owned())
            })?;
            if content_length.replace(parsed).is_some() {
                return Err(ApiError::Unavailable(
                    "duplicate AREA management content length".to_owned(),
                ));
            }
        }
    }
    if transfer_chunked && content_length.is_some() {
        return Err(ApiError::Unavailable(
            "ambiguous AREA management response framing".to_owned(),
        ));
    }

    let wire_body = &raw[split + marker.len()..];
    let decoded;
    let body = if transfer_chunked {
        decoded = decode_chunked(wire_body)?;
        decoded.as_slice()
    } else {
        if let Some(expected) = content_length {
            if expected != wire_body.len() {
                return Err(ApiError::Unavailable(
                    "truncated AREA management response".to_owned(),
                ));
            }
        }
        wire_body
    };
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(ApiError::Unavailable(
            "AREA management response exceeded limit".to_owned(),
        ));
    }

    if status == 204 {
        if body.is_empty() {
            return Ok(Value::Null);
        }
        return Err(ApiError::Unavailable(
            "AREA management returned a body for HTTP 204".to_owned(),
        ));
    }

    if (200..300).contains(&status) && body.is_empty() {
        return Err(ApiError::Unavailable(
            "AREA management returned an empty success body".to_owned(),
        ));
    }

    let value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(body)
            .map_err(|_| ApiError::Unavailable("invalid AREA management JSON".to_owned()))?
    };
    if (200..300).contains(&status) {
        Ok(value)
    } else if status == 404 {
        Err(ApiError::NotFound)
    } else if status == 409 {
        Err(ApiError::Conflict(
            error_code(&value).unwrap_or("AREA_CONFLICT").to_owned(),
        ))
    } else if matches!(status, 400 | 422) {
        Err(ApiError::InvalidInput(
            error_code(&value).unwrap_or("AREA_INVALID").to_owned(),
        ))
    } else {
        Err(ApiError::Unavailable(format!(
            "AREA management returned HTTP {status}"
        )))
    }
}

fn decode_chunked(mut input: &[u8]) -> Result<Vec<u8>, ApiError> {
    let mut output = Vec::new();
    loop {
        let Some(line_end) = input.windows(2).position(|window| window == b"\r\n") else {
            return Err(ApiError::Unavailable(
                "malformed chunked AREA management response".to_owned(),
            ));
        };
        let size_line = std::str::from_utf8(&input[..line_end]).map_err(|_| {
            ApiError::Unavailable("malformed AREA management chunk size".to_owned())
        })?;
        let size_hex = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| ApiError::Unavailable("invalid AREA management chunk size".to_owned()))?;
        input = &input[line_end + 2..];
        if size == 0 {
            return Ok(output);
        }
        if size > MAX_RESPONSE_BYTES.saturating_sub(output.len())
            || input.len() < size.saturating_add(2)
            || &input[size..size + 2] != b"\r\n"
        {
            return Err(ApiError::Unavailable(
                "invalid AREA management chunk framing".to_owned(),
            ));
        }
        output.extend_from_slice(&input[..size]);
        input = &input[size + 2..];
    }
}

fn error_code(value: &Value) -> Option<&str> {
    value.get("code").and_then(Value::as_str)
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0_u8; 64];
    if key.len() > 64 {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0x36_u8; 64];
    let mut outer_pad = [0x5c_u8; 64];
    for index in 0..64 {
        inner_pad[index] ^= block[index];
        outer_pad[index] ^= block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner);
    outer.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(char::from(HEX[(byte >> 4) as usize]));
        output.push(char::from(HEX[(byte & 0x0f) as usize]));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_rejects_public_and_https() {
        assert!(validate_management_target("https://127.0.0.1:8080").is_err());
        assert!(validate_management_target("http://8.8.8.8:8080").is_err());
        assert!(validate_management_target("http://127.0.0.1:8080").is_ok());
        assert!(validate_management_target("http://10.77.0.2:8080").is_ok());
    }

    #[test]
    fn derivation_is_tenant_scoped_and_matches_provisioner() {
        let client = TenantAreaClient::new(Some("01234567890123456789012345678901".to_owned()));
        let token = client.derived_token(Uuid::nil()).expect("configured");
        assert_eq!(
            token,
            "2647b07320443f8c7c4058f9cfd781e0d3e38edb9ff5bda4c29ca2dac95893d5"
        );
        assert_ne!(
            token,
            client
                .derived_token(Uuid::from_u128(1))
                .expect("configured")
        );
    }

    #[test]
    fn missing_master_key_is_unavailable() {
        let client = TenantAreaClient::new(None);
        assert!(client.derived_token(Uuid::nil()).is_err());
    }

    #[test]
    fn operations_allowlist_is_bounded_and_shape_aware() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        for path in [
            "/v1/control-plane/ops/summary",
            "/v1/control-plane/ops/outbox?status=dead&limit=50",
            "/v1/control-plane/ops/deliveries?status=dead&limit=50",
            "/v1/control-plane/ecosystem/overview",
            "/v1/control-plane/ecosystem/findings?limit=50&open_only=true",
            "/v1/control-plane/ecosystem/flags",
            "/v1/control-plane/autopilot/overview",
        ] {
            assert!(valid_operations_request("GET", path), "{path}");
        }
        assert!(valid_operations_request(
            "GET",
            &format!("/v1/control-plane/ops/deliveries/{id}")
        ));
        assert!(valid_operations_request(
            "GET",
            "/v1/control-plane/ops/operations/request-1234"
        ));
        for path in [
            "/v1/control-plane/ops/deliveries/dead/clear",
            "/v1/control-plane/ecosystem/reconcile",
        ] {
            assert!(valid_operations_request("POST", path), "{path}");
        }
        assert!(valid_operations_request(
            "POST",
            &format!("/v1/control-plane/ops/outbox/{id}/retry")
        ));
        assert!(valid_operations_request(
            "POST",
            &format!("/v1/control-plane/ops/deliveries/{id}/retry")
        ));
        assert!(!valid_operations_request(
            "GET",
            "/v1/control-plane/ops/outbox?status=pending&limit=500"
        ));
        assert!(!valid_operations_request("GET", "/v1/admin/ops/summary"));
        assert!(!valid_operations_request(
            "POST",
            "/v1/control-plane/ops/outbox/not-a-uuid/retry"
        ));
    }

    #[test]
    fn redirect_is_refused() {
        let raw = b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1\r\nContent-Length: 0\r\n\r\n";
        assert!(parse_response(raw).is_err());
    }

    #[test]
    fn empty_success_body_is_refused() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n";
        assert!(matches!(
            parse_response(raw),
            Err(ApiError::Unavailable(message))
                if message == "AREA management returned an empty success body"
        ));
    }

    #[test]
    fn no_content_is_decoded_as_null() {
        let raw = b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
        assert_eq!(parse_response(raw).expect("decoded"), Value::Null);
    }

    #[test]
    fn no_content_with_body_is_refused() {
        let raw = b"HTTP/1.1 204 No Content\r\nContent-Length: 2\r\n\r\n{}";
        assert!(matches!(
            parse_response(raw),
            Err(ApiError::Unavailable(message))
                if message == "AREA management returned a body for HTTP 204"
        ));
    }

    #[test]
    fn content_length_json_is_decoded() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        assert_eq!(
            parse_response(raw).expect("decoded"),
            serde_json::json!({"ok": true})
        );
    }

    #[test]
    fn chunked_json_is_decoded() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"ok\":t\r\n4\r\nrue}\r\n0\r\n\r\n";
        assert_eq!(
            parse_response(raw).expect("decoded"),
            serde_json::json!({"ok": true})
        );
    }
}
