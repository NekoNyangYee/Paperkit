use crate::{
    auth::{AuthError, AuthenticatedUser, SupabaseAuth},
    config::Config,
    db::{self, Database, Error},
    models::*,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;
use tower_http::{cors::CorsLayer, limit::RequestBodyLimitLayer, timeout::RequestBodyTimeoutLayer};

#[derive(Clone)]
struct ApiState {
    database: Database,
    auth: SupabaseAuth,
    budget: Arc<Mutex<(Instant, u32)>>,
    requests_per_minute: u32,
    capacity: Arc<Semaphore>,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            Error::Invalid(message) => (StatusCode::BAD_REQUEST, "invalid_request", message),
            Error::NotFound => (StatusCode::NOT_FOUND, "not_found", "Resource not found"),
            Error::Conflict => (
                StatusCode::CONFLICT,
                "conflict",
                "Revision, reference or unique value conflict; fetch current state before retrying",
            ),
            Error::Busy => (
                StatusCode::SERVICE_UNAVAILABLE,
                "busy",
                "Service busy; retry later",
            ),
            Error::Sql(ref error)
                if error.sqlite_error_code().is_some_and(|code| {
                    matches!(
                        code,
                        rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                    )
                }) =>
            {
                (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "database_busy",
                    "Database busy; retry later",
                )
            }
            Error::Sql(_) | Error::Internal => {
                // Never log SQL parameters, request bodies, credentials or document paths.
                eprintln!("paperkit-api: database operation failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal storage error",
                )
            }
        };
        (
            status,
            Json(json!({"error": {"code": code, "message": message}})),
        )
            .into_response()
    }
}

pub fn router(database: Database, config: &Config) -> Result<Router, reqwest::Error> {
    let state = ApiState {
        database,
        auth: SupabaseAuth::new(config.auth.clone())?,
        budget: Arc::new(Mutex::new((Instant::now(), 0))),
        requests_per_minute: config.requests_per_minute,
        capacity: Arc::new(Semaphore::new(4)),
    };
    let api = Router::new()
        .route("/me", get(me))
        .route("/documents", get(list_documents).post(create_document))
        .route("/documents/{id}", get(get_document).delete(delete_document))
        .route("/workspaces/{id}", get(get_workspace).put(put_workspace))
        .route("/documents/{id}/recovery", get(get_recovery))
        .route(
            "/documents/{id}/recovery/snapshot",
            get(get_snapshot)
                .put(put_snapshot)
                .layer(DefaultBodyLimit::max(db::MAX_PDF_BYTES)),
        )
        .route("/documents/{id}/draft", get(get_draft).put(put_draft))
        .route_layer(middleware::from_fn_with_state(state.clone(), authorize));
    let cors = CorsLayer::new()
        .allow_origin(config.cors_origins.clone())
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Ok(Router::new()
        .route("/healthz", get(health))
        .nest("/v1", api)
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(RequestBodyLimitLayer::new(db::MAX_PDF_BYTES))
        .layer(RequestBodyTimeoutLayer::new(Duration::from_secs(30)))
        .layer(cors)
        .layer(middleware::from_fn(response_headers))
        .with_state(state))
}

async fn response_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}

async fn authorize(State(state): State<ApiState>, request: Request, next: Next) -> Response {
    let allowed = {
        let Ok(mut budget) = state.budget.lock() else {
            return Error::Internal.into_response();
        };
        if budget.0.elapsed() >= Duration::from_secs(60) {
            *budget = (Instant::now(), 0);
        }
        if budget.1 >= state.requests_per_minute {
            false
        } else {
            budget.1 += 1;
            true
        }
    };
    if !allowed {
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "60")], Json(json!({"error":{"code":"rate_limited","message":"Service request budget exceeded"}}))).into_response();
    }
    let credentials = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let Ok(_permit) = state.capacity.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "1")],
            Json(json!({"error":{"code":"busy","message":"Service busy"}})),
        )
            .into_response();
    };
    let user = match credentials {
        Some(token) => state.auth.verify(token).await,
        None => Err(AuthError::Unauthorized),
    };
    let user = match user {
        Ok(user) => user,
        Err(AuthError::Unauthorized) => return (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], Json(json!({"error":{"code":"unauthorized","message":"A valid Supabase user access token is required"}}))).into_response(),
        Err(AuthError::Unavailable) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":{"code":"auth_unavailable","message":"Authentication service is temporarily unavailable"}}))).into_response(),
    };
    let mut request = request;
    request.extensions_mut().insert(user);
    next.run(request).await
}

async fn me(Extension(user): Extension<AuthenticatedUser>) -> Json<AuthenticatedUser> {
    Json(user)
}

fn id(value: String) -> db::Result<String> {
    if db::valid_id(&value) {
        Ok(value)
    } else {
        Err(Error::Invalid("Use a lowercase canonical UUID"))
    }
}

async fn health(State(state): State<ApiState>) -> Result<Json<serde_json::Value>, Error> {
    let _permit = state
        .capacity
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy)?;
    state
        .database
        .run(|conn| {
            conn.query_row("SELECT 1", [], |_| Ok(()))?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({"status":"ok"})))
}
async fn create_document(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Json(input): Json<DocumentInput>,
) -> Result<(StatusCode, Json<Document>), Error> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .database
                .run(move |c| db::create_document(c, &user.id, input))
                .await?,
        ),
    ))
}
async fn list_documents(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Query(page): Query<PageQuery>,
) -> Result<Json<Vec<Document>>, Error> {
    let limit = page.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::Invalid("limit must be between 1 and 100"));
    }
    Ok(Json(
        state
            .database
            .run(move |c| db::list_documents(c, &user.id, limit, page.offset.unwrap_or(0)))
            .await?,
    ))
}
async fn get_document(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<Json<Document>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::get_document(c, &user.id, &id))
            .await?,
    ))
}
async fn delete_document(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<StatusCode, Error> {
    let id = id(value)?;
    state
        .database
        .run(move |c| db::delete_document(c, &user.id, &id))
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn get_workspace(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<Json<Workspace>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::get_workspace(c, &user.id, &id))
            .await?,
    ))
}
async fn put_workspace(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
    Json(input): Json<WorkspaceInput>,
) -> Result<Json<Workspace>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::put_workspace(c, &user.id, &id, input))
            .await?,
    ))
}
async fn get_recovery(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<Json<Recovery>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::recovery(c, &user.id, &id))
            .await?,
    ))
}
async fn put_snapshot(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
    Query(query): Query<RecoveryQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Recovery>, Error> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/pdf")
    {
        return Err(Error::Invalid("Content-Type must be application/pdf"));
    }
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::put_recovery(c, &user.id, &id, query, body.to_vec()))
            .await?,
    ))
}
async fn get_snapshot(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<Response, Error> {
    let id = id(value)?;
    let bytes = state
        .database
        .run(move |c| db::snapshot(c, &user.id, &id))
        .await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/pdf"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"recovery.pdf\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
async fn get_draft(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
) -> Result<Json<Draft>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::draft(c, &user.id, &id))
            .await?,
    ))
}
async fn put_draft(
    State(state): State<ApiState>,
    Extension(user): Extension<AuthenticatedUser>,
    Path(value): Path<String>,
    Json(input): Json<DraftInput>,
) -> Result<Json<Draft>, Error> {
    let id = id(value)?;
    Ok(Json(
        state
            .database
            .run(move |c| db::put_draft(c, &user.id, &id, input))
            .await?,
    ))
}
