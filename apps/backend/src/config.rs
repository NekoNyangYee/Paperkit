use crate::auth::AuthConfig;
use axum::http::HeaderValue;
use std::{env, net::SocketAddr, path::PathBuf};

pub struct Config {
    pub bind: SocketAddr,
    pub database: PathBuf,
    pub auth: AuthConfig,
    pub cors_origins: Vec<HeaderValue>,
    pub requests_per_minute: u32,
}

impl Config {
    pub fn load() -> Result<Self, String> {
        let auth = AuthConfig::new(
            &env::var("SUPABASE_URL").map_err(|_| "SUPABASE_URL is required")?,
            &env::var("SUPABASE_PUBLISHABLE_KEY")
                .map_err(|_| "SUPABASE_PUBLISHABLE_KEY is required")?,
        )?;
        let cors_origins = env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .filter(|origin| !origin.trim().is_empty())
            .map(|origin| {
                let origin = origin.trim();
                let uri: axum::http::Uri = origin.parse().map_err(|_| "Invalid CORS origin")?;
                if !matches!(uri.scheme_str(), Some("http" | "https"))
                    || uri.authority().is_none()
                    || uri.authority().is_some_and(|v| v.as_str().contains('@'))
                    || uri.path() != "/"
                    || uri.query().is_some()
                    || origin.ends_with('/')
                {
                    return Err(
                        "CORS origins must be exact http(s) origins without a trailing slash",
                    );
                }
                HeaderValue::from_str(origin).map_err(|_| "Invalid CORS origin")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let requests_per_minute = env::var("REQUESTS_PER_MINUTE")
            .unwrap_or_else(|_| "120".into())
            .parse::<u32>()
            .map_err(|_| "Invalid REQUESTS_PER_MINUTE")?;
        if !(1..=10000).contains(&requests_per_minute) {
            return Err("REQUESTS_PER_MINUTE must be between 1 and 10000".into());
        }
        Ok(Self {
            bind: env::var("BIND_ADDRESS")
                .unwrap_or_else(|_| "127.0.0.1:8080".into())
                .parse()
                .map_err(|_| "BIND_ADDRESS must be an IP:port socket address")?,
            database: database_path(),
            auth,
            cors_origins,
            requests_per_minute,
        })
    }
}

pub fn database_path() -> PathBuf {
    env::var_os("DATABASE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/paperkit.sqlite3"))
}
