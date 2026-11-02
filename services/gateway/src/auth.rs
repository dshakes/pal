use axum::body::Body;
use axum::http::{Method, Request};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tower::{Layer, Service};

use crate::error::AppError;
use crate::introspect::ApiKeyIntrospector;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub tenant_id: String,
    pub user_id: String,
    pub scopes: Vec<String>,
    pub exp: u64,
    pub iat: u64,
}

impl Claims {
    /// Returns true when the request method is safe (read-only).
    fn is_read_method(method: &Method) -> bool {
        matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
    }

    /// Enforce scope→method mapping:
    ///   - Mutating requests (POST/PUT/PATCH/DELETE) require a `write` scope.
    ///   - Read-only requests (GET/HEAD/OPTIONS) are allowed with any scope.
    ///
    /// Returns Err(AppError::Auth) with a 403-equivalent message on violation.
    pub fn enforce_scope(&self, method: &Method) -> Result<(), AppError> {
        if Self::is_read_method(method) {
            return Ok(());
        }
        // Mutating request — require at least one write-class scope.
        let has_write = self
            .scopes
            .iter()
            .any(|s| s == "write" || s == "admin" || s == "api");
        if has_write {
            Ok(())
        } else {
            Err(AppError::Forbidden(
                "write scope required for mutating requests".to_string(),
            ))
        }
    }
}

/// The gateway accepts API keys only. It used to decode HS256 JWTs locally, but
/// with a claim shape (`user_id`, `scopes`) the control plane never mints:
/// every real PAL session JWT already failed to decode here, so the only
/// tokens that path could accept were ones forged with the shared
/// `JWT_SECRET`, and it could not honour session revocation (`tv`) or the
/// `PAL_JWT_TTL` cap. Dashboard sessions go to the control plane directly
/// (through the dashboard's `/api/pal` proxy), where both are enforced.
#[derive(Clone)]
pub struct AuthLayer {
    introspector: Option<Arc<ApiKeyIntrospector>>,
}

impl AuthLayer {
    /// `introspector` is `None` when API-key auth is unconfigured
    /// (PAL_CONTROL_PLANE_URL / PAL_GRPC_SERVICE_TOKEN unset) — every request
    /// is then refused (fail-closed).
    pub fn new(introspector: Option<Arc<ApiKeyIntrospector>>) -> Self {
        Self { introspector }
    }
}

impl<S> Layer<S> for AuthLayer {
    type Service = AuthMiddleware<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthMiddleware {
            inner,
            introspector: self.introspector.clone(),
        }
    }
}

#[derive(Clone)]
pub struct AuthMiddleware<S> {
    inner: S,
    introspector: Option<Arc<ApiKeyIntrospector>>,
}

impl<S> Service<Request<Body>> for AuthMiddleware<S>
where
    S: Service<Request<Body>, Response = Response> + Clone + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = S::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<Body>) -> Self::Future {
        let path = req.uri().path().to_string();

        if path == "/healthz" || path == "/readyz" {
            let future = self.inner.call(req);
            return Box::pin(future);
        }

        let introspector = self.introspector.clone();
        let mut inner = self.inner.clone();
        // Extract the credential synchronously so the async block never borrows
        // `req` across an `.await` (which would make the future non-Send).
        let credential = extract_credential(&req);

        Box::pin(async move {
            let claims = match resolve_claims(credential, introspector.as_deref()).await {
                Ok(claims) => claims,
                Err(err) => {
                    return Ok(err.into_response());
                }
            };

            // H3: enforce scope before the request reaches any handler.
            if let Err(err) = claims.enforce_scope(req.method()) {
                return Ok(err.into_response());
            }

            tracing::debug!(
                tenant_id = %claims.tenant_id,
                user_id = %claims.user_id,
                "authenticated request"
            );

            req.extensions_mut().insert(claims);
            inner.call(req).await
        })
    }
}

/// The presented API key, extracted from request headers (owned, so it can
/// cross an `.await` without borrowing the request).
struct Credential(String);

/// Pull the API key out of the request headers synchronously: `X-API-Key`, or
/// `Authorization: Bearer <key>` (what the SDKs send). Both go through
/// control-plane introspection; a Bearer JWT is not a key and is refused there.
fn extract_credential(req: &Request<Body>) -> Result<Credential, AppError> {
    if let Some(api_key_header) = req.headers().get("x-api-key") {
        let key = api_key_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid X-API-Key header encoding".to_string()))?;
        return Ok(Credential(key.trim().to_string()));
    }

    if let Some(auth_header) = req.headers().get("authorization") {
        let header_str = auth_header
            .to_str()
            .map_err(|_| AppError::Auth("invalid authorization header encoding".to_string()))?;
        if let Some(token) = header_str.strip_prefix("Bearer ") {
            return Ok(Credential(token.trim().to_string()));
        }
    }

    Err(AppError::Auth(
        "missing authorization header or X-API-Key".to_string(),
    ))
}

async fn resolve_claims(
    credential: Result<Credential, AppError>,
    introspector: Option<&ApiKeyIntrospector>,
) -> Result<Claims, AppError> {
    let Credential(key) = credential?;
    if key.is_empty() {
        return Err(AppError::Auth("empty credential".to_string()));
    }
    // Introspect against the control-plane (cached 60s). FAILS CLOSED when
    // introspection is unconfigured — a caller must not be able to
    // impersonate a tenant by forging the credential body.
    match introspector {
        Some(i) => i.introspect(&key).await,
        None => Err(AppError::Auth(
            "API-key authentication is not configured at this gateway (set \
             PAL_CONTROL_PLANE_URL and PAL_GRPC_SERVICE_TOKEN)"
                .to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;
    use jsonwebtoken::{EncodingKey, Header, encode};

    fn signed(claims: &serde_json::Value, secret: &str) -> String {
        encode(
            &Header::default(),
            claims,
            &EncodingKey::from_secret(secret.as_bytes()),
        )
        .unwrap()
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    fn bearer(token: &str) -> Request<Body> {
        Request::builder()
            .method(Method::GET)
            .uri("/v1/agents")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    }

    // ---- JWTs are never accepted locally ----

    /// A token in the claim shape the old local decoder accepted, correctly
    /// signed: still refused, because nothing is decoded locally any more.
    #[tokio::test]
    async fn signed_gateway_shaped_jwt_refused() {
        let tok = signed(
            &serde_json::json!({"tenant_id":"victim","user_id":"u","scopes":["admin"],"iat":now(),"exp":now()+3600}),
            "the-shared-jwt-secret",
        );
        let res = resolve_claims(extract_credential(&bearer(&tok)), None).await;
        assert!(
            matches!(res, Err(AppError::Auth(_))),
            "local JWT acceptance is gone"
        );
    }

    /// A revoked or over-age PAL session JWT presented at the gateway is not
    /// honoured locally either (revocation and the TTL cap live in the control
    /// plane, which this path never bypasses).
    #[tokio::test]
    async fn pal_session_jwt_refused() {
        let tok = signed(
            &serde_json::json!({"sub":"u","tenant_id":"t","role":"owner","tv":0,"iat":0,"exp":now()+30*86400}),
            "s",
        );
        let res = resolve_claims(extract_credential(&bearer(&tok)), None).await;
        assert!(matches!(res, Err(AppError::Auth(_))));
    }

    #[test]
    fn bearer_and_x_api_key_both_yield_the_key() {
        let Credential(k) = extract_credential(&bearer("hlx_live_abc")).unwrap();
        assert_eq!(k, "hlx_live_abc");
        let req = Request::builder()
            .uri("/v1/agents")
            .header("x-api-key", "hlx_live_xyz")
            .header("authorization", "Bearer something-else")
            .body(Body::empty())
            .unwrap();
        let Credential(k) = extract_credential(&req).unwrap();
        assert_eq!(k, "hlx_live_xyz", "X-API-Key wins over Authorization");
    }

    #[tokio::test]
    async fn empty_or_missing_credential_refused() {
        assert!(
            resolve_claims(extract_credential(&bearer("")), None)
                .await
                .is_err()
        );
        let req = Request::builder()
            .uri("/v1/agents")
            .body(Body::empty())
            .unwrap();
        assert!(matches!(extract_credential(&req), Err(AppError::Auth(_))));
    }

    // ---- C2: API-key path fails closed ----

    #[tokio::test]
    async fn api_key_rejected_when_introspection_unconfigured() {
        // With no introspector wired (unset control-plane URL / service token)
        // the API-key path must fail closed — no tenant impersonation.
        let req = Request::builder()
            .method(Method::GET)
            .uri("/v1/agents")
            .header("x-api-key", "hlx_live_mytenant_randomsuffix")
            .body(Body::empty())
            .unwrap();
        let result = resolve_claims(extract_credential(&req), None).await;
        assert!(
            result.is_err(),
            "API-key auth must fail closed — no tenant impersonation"
        );
        assert!(
            matches!(result.unwrap_err(), AppError::Auth(_)),
            "error must be AppError::Auth"
        );
    }

    #[tokio::test]
    async fn api_key_arbitrary_tenant_rejected() {
        // An attacker forging hlx_live_victim_anything must be rejected when
        // introspection is unconfigured.
        let req = Request::builder()
            .method(Method::POST)
            .uri("/v1/runs")
            .header("x-api-key", "hlx_live_victim-tenant_exploit")
            .body(Body::empty())
            .unwrap();
        let result = resolve_claims(extract_credential(&req), None).await;
        assert!(result.is_err());
    }

    // ---- H3: scope enforcement ----

    fn claims_with_scopes(scopes: &[&str]) -> Claims {
        Claims {
            tenant_id: "t1".to_string(),
            user_id: "u1".to_string(),
            scopes: scopes.iter().map(|s| s.to_string()).collect(),
            exp: u64::MAX,
            iat: 0,
        }
    }

    #[test]
    fn read_scope_allows_get() {
        let claims = claims_with_scopes(&["read"]);
        assert!(claims.enforce_scope(&Method::GET).is_ok());
    }

    #[test]
    fn read_scope_blocks_post() {
        let claims = claims_with_scopes(&["read"]);
        let err = claims.enforce_scope(&Method::POST);
        assert!(err.is_err());
        assert!(matches!(err.unwrap_err(), AppError::Forbidden(_)));
    }

    #[test]
    fn read_scope_blocks_delete() {
        let claims = claims_with_scopes(&["read"]);
        assert!(claims.enforce_scope(&Method::DELETE).is_err());
    }

    #[test]
    fn write_scope_allows_post() {
        let claims = claims_with_scopes(&["write"]);
        assert!(claims.enforce_scope(&Method::POST).is_ok());
    }

    #[test]
    fn admin_scope_allows_delete() {
        let claims = claims_with_scopes(&["admin"]);
        assert!(claims.enforce_scope(&Method::DELETE).is_ok());
    }

    #[test]
    fn api_scope_allows_post() {
        // "api" scope (legacy) is treated as write-capable.
        let claims = claims_with_scopes(&["api"]);
        assert!(claims.enforce_scope(&Method::POST).is_ok());
    }

    #[test]
    fn no_scopes_blocks_post() {
        let claims = claims_with_scopes(&[]);
        assert!(claims.enforce_scope(&Method::POST).is_err());
    }

    #[test]
    fn options_always_allowed() {
        let claims = claims_with_scopes(&[]); // no scopes
        assert!(claims.enforce_scope(&Method::OPTIONS).is_ok());
    }
}
