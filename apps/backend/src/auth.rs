use base64::Engine;
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone)]
pub struct AuthConfig {
    user_endpoint: Url,
    publishable_key: String,
}

impl AuthConfig {
    pub fn new(project_url: &str, publishable_key: &str) -> Result<Self, String> {
        let url = Url::parse(project_url).map_err(|_| "Invalid SUPABASE_URL")?;
        let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !(url.scheme() == "https" || (url.scheme() == "http" && local))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.host_str().is_none()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("SUPABASE_URL must be an HTTPS project origin (HTTP loopback is allowed for local development)".into());
        }
        let legacy_anon = publishable_key
            .split('.')
            .nth(1)
            .and_then(|payload| {
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(payload)
                    .ok()
            })
            .and_then(|payload| serde_json::from_slice::<serde_json::Value>(&payload).ok())
            .is_some_and(|payload| payload["role"] == "anon");
        if publishable_key.len() > 4096
            || !publishable_key.bytes().all(|b| b.is_ascii_graphic())
            || !(publishable_key.starts_with("sb_publishable_") || legacy_anon)
        {
            return Err("SUPABASE_PUBLISHABLE_KEY must be a publishable key or legacy anon key, never a secret/service_role key".into());
        }
        Ok(Self {
            user_endpoint: url
                .join("auth/v1/user")
                .map_err(|_| "Invalid Supabase auth URL")?,
            publishable_key: publishable_key.into(),
        })
    }
}

#[derive(Clone)]
pub struct SupabaseAuth {
    config: AuthConfig,
    client: Client,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuthenticatedUser {
    pub id: String,
}

#[derive(Debug)]
pub enum AuthError {
    Unauthorized,
    Unavailable,
}

#[derive(Deserialize)]
struct VerifiedUser {
    id: String,
    aud: String,
    role: String,
    #[serde(default)]
    is_anonymous: bool,
}

impl SupabaseAuth {
    pub fn new(config: AuthConfig) -> Result<Self, reqwest::Error> {
        Ok(Self {
            config,
            client: Client::builder()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(8))
                .build()?,
        })
    }

    pub async fn verify(&self, token: &str) -> Result<AuthenticatedUser, AuthError> {
        if token.is_empty() || token.len() > 8192 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(AuthError::Unauthorized);
        }
        // Supabase Auth verifies the signature, issuer, expiry and user existence.
        // This works with both legacy HS256 and asymmetric signing keys. No JWT
        // secret is shared and no identity from an unverified payload is trusted.
        let mut response = self
            .client
            .get(self.config.user_endpoint.clone())
            .header("apikey", &self.config.publishable_key)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|_| AuthError::Unavailable)?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                return Err(AuthError::Unauthorized)
            }
            StatusCode::OK => (),
            _ => return Err(AuthError::Unavailable),
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| AuthError::Unavailable)? {
            if body.len() + chunk.len() > 65536 {
                return Err(AuthError::Unavailable);
            }
            body.extend_from_slice(&chunk);
        }
        let user: VerifiedUser =
            serde_json::from_slice(&body).map_err(|_| AuthError::Unavailable)?;
        if !crate::db::valid_id(&user.id)
            || user.aud != "authenticated"
            || user.role != "authenticated"
            || user.is_anonymous
        {
            return Err(AuthError::Unauthorized);
        }
        Ok(AuthenticatedUser { id: user.id })
    }
}
