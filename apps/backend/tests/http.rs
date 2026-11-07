use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use paperkit_api::{api, auth::AuthConfig, config::Config, db::Database};
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

const KEY: &str = "test-only-32-byte-key-never-use-in-production";
struct Fixture {
    _directory: TempDir,
    auth_server: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.auth_server.abort();
    }
}
const USER_A: &str = "11111111-1111-4111-8111-111111111111";
const USER_B: &str = "22222222-2222-4222-8222-222222222222";
const SECOND_KEY: &str = "second-user-test-access-token";
async fn fixture(limit: u32) -> (Fixture, Router) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let mock = Router::new().route("/auth/v1/user", axum::routing::get(|headers: axum::http::HeaderMap| async move {
        use axum::response::IntoResponse;
        assert_eq!(headers["apikey"], "sb_publishable_mock_for_tests");
        let token = headers.get("authorization").and_then(|h| h.to_str().ok()).unwrap_or_default();
        let user = match token.strip_prefix("Bearer ") {
            Some(KEY) => USER_A,
            Some(SECOND_KEY) => USER_B,
            Some("auth-outage") => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
            Some("redirect-token") => return (StatusCode::FOUND, [("location", "http://127.0.0.1:1/must-not-follow")]).into_response(),
            Some("anonymous-token") => return axum::Json(json!({"id":USER_A,"aud":"authenticated","role":"authenticated","is_anonymous":true})).into_response(),
            _ => return StatusCode::UNAUTHORIZED.into_response(),
        };
        axum::Json(json!({"id":user,"aud":"authenticated","role":"authenticated","is_anonymous":false})).into_response()
    }));
    let auth_server = tokio::spawn(async move {
        axum::serve(listener, mock).await.unwrap();
    });
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(&directory.path().join("test.sqlite3")).unwrap();
    let config = Config {
        bind: "127.0.0.1:8080".parse().unwrap(),
        database: directory.path().join("test.sqlite3"),
        auth: AuthConfig::new(&origin, "sb_publishable_mock_for_tests").unwrap(),
        cors_origins: vec!["https://allowed.example".parse().unwrap()],
        requests_per_minute: limit,
    };
    (
        Fixture {
            _directory: directory,
            auth_server,
        },
        api::router(database, &config).unwrap(),
    )
}
fn request(method: &str, path: &str, body: Option<Value>, auth: bool) -> Request<Body> {
    let mut request = Request::builder().method(method).uri(path);
    if auth {
        request = request.header("Authorization", format!("Bearer {KEY}"));
    }
    if body.is_some() {
        request = request.header("Content-Type", "application/json");
    }
    request
        .body(Body::from(body.map(|v| v.to_string()).unwrap_or_default()))
        .unwrap()
}
async fn json(response: axum::response::Response) -> Value {
    serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}

#[tokio::test]
async fn health_is_public_but_data_requires_bearer_and_is_never_cached() {
    let (_directory, app) = fixture(120).await;
    let health = app
        .clone()
        .oneshot(request("GET", "/healthz", None, false))
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(json(health).await, json!({"status":"ok"}));
    let response = app
        .clone()
        .oneshot(request("GET", "/v1/documents", None, false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let response = app
        .oneshot(request("GET", "/v1/documents", None, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await, json!([]));
}

#[tokio::test]
async fn document_round_trip_preserves_unicode_and_rejects_duplicate_path() {
    let (_directory, app) = fixture(120).await;
    let input = json!({"sourcePath":"C:\\문서\\원본.pdf","displayName":"원본.pdf","sizeBytes":100});
    let response = app
        .clone()
        .oneshot(request("POST", "/v1/documents", Some(input.clone()), true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let saved = json(response).await;
    let path = format!("/v1/documents/{}", saved["id"].as_str().unwrap());
    let response = app
        .clone()
        .oneshot(request("GET", &path, None, true))
        .await
        .unwrap();
    assert_eq!(json(response).await["displayName"], "원본.pdf");
    let duplicate = app
        .clone()
        .oneshot(request("POST", "/v1/documents", Some(input), true))
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let response = app
        .clone()
        .oneshot(request("DELETE", &path, None, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = app
        .oneshot(request("GET", &path, None, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn limits_unauthenticated_requests_and_rejects_oversized_json() {
    let (_directory, app) = fixture(1).await;
    let response = app
        .clone()
        .oneshot(request("GET", "/v1/documents", None, false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let response = app
        .oneshot(request("GET", "/v1/documents", None, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let (_directory, app) = fixture(120).await;
    let input = json!({"sourcePath":"a".repeat(300_000),"displayName":"a.pdf","sizeBytes":1});
    let response = app
        .oneshot(request("POST", "/v1/documents", Some(input), true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn cors_allows_only_configured_origins_and_preflight_needs_no_key() {
    let (_directory, app) = fixture(120).await;
    for (origin, allowed) in [
        ("https://allowed.example", true),
        ("https://other.example", false),
    ] {
        let request = Request::builder()
            .method("OPTIONS")
            .uri("/v1/documents")
            .header("Origin", origin)
            .header("Access-Control-Request-Method", "POST")
            .header(
                "Access-Control-Request-Headers",
                "authorization,content-type",
            )
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_some(),
            allowed
        );
    }
}

#[tokio::test]
async fn binary_recovery_requires_pdf_type_and_round_trips_without_prefix() {
    let (_directory, app) = fixture(120).await;
    let input = json!({"sourcePath":"a.pdf","displayName":"a.pdf","sizeBytes":100});
    let document = json(
        app.clone()
            .oneshot(request("POST", "/v1/documents", Some(input), true))
            .await
            .unwrap(),
    )
    .await;
    let path = format!(
        "/v1/documents/{}/recovery/snapshot",
        document["id"].as_str().unwrap()
    );
    let upload = format!("{path}?expectedRevision=0&sourceHash={}", "a".repeat(64));
    // PDF route must override the smaller JSON body limit.
    let mut pdf = b"%PDF-1.7\nheader-only-test-fixture".to_vec();
    pdf.resize(300_000, b' ');
    let upload_request = Request::builder()
        .method("PUT")
        .uri(&upload)
        .header("Authorization", format!("Bearer {KEY}"))
        .header("Content-Type", "application/pdf")
        .body(Body::from(pdf.clone()))
        .unwrap();
    let response = app.clone().oneshot(upload_request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json(response).await["revision"], 1);
    let response = app
        .oneshot(request("GET", &path, None, true))
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "application/pdf");
    assert_eq!(
        to_bytes(response.into_body(), 400_000)
            .await
            .unwrap()
            .as_ref(),
        pdf.as_slice()
    );
}

#[tokio::test]
async fn rejects_invalid_anonymous_and_operator_tokens_and_fails_closed_on_upstream_failure() {
    let (_fixture, app) = fixture(120).await;
    for (token, status) in [
        ("old-operator-key", StatusCode::UNAUTHORIZED),
        ("anonymous-token", StatusCode::UNAUTHORIZED),
        ("auth-outage", StatusCode::SERVICE_UNAVAILABLE),
        ("redirect-token", StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let mut req = request("GET", "/v1/documents", None, false);
        req.headers_mut()
            .insert("authorization", format!("Bearer {token}").parse().unwrap());
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), status);
    }
}

#[tokio::test]
async fn identity_comes_from_verified_supabase_user_and_other_users_cannot_read_or_delete_documents(
) {
    let (_fixture, app) = fixture(120).await;
    let saved = json(
        app.clone()
            .oneshot(request(
                "POST",
                "/v1/documents",
                Some(json!({"sourcePath":"private.pdf","displayName":"private.pdf","sizeBytes":9})),
                true,
            ))
            .await
            .unwrap(),
    )
    .await;
    let path = format!("/v1/documents/{}", saved["id"].as_str().unwrap());
    for method in ["GET", "DELETE"] {
        let mut req = request(method, &path, None, false);
        req.headers_mut().insert(
            "authorization",
            format!("Bearer {SECOND_KEY}").parse().unwrap(),
        );
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
    }
    let me = json(
        app.oneshot(request("GET", "/v1/me", None, true))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(me["id"], USER_A);
}
