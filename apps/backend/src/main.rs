use paperkit_api::{
    api,
    config::{self, Config},
    db::{Database, SCHEMA_VERSION},
};
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream},
    path::Path,
    time::Duration,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    match arguments.as_slice() {
        [argument] if argument == "--healthcheck" => return healthcheck(),
        [argument, destination] if argument == "backup" => {
            let source = config::database_path();
            if !source.is_file() {
                return Err("Source database does not exist".into());
            }
            Database::open(&source)?.backup(Path::new(destination))?;
            println!("SQLite backup complete; integrity_check=ok");
            return Ok(());
        }
        [argument] if argument == "migrate" => {
            Database::open(&config::database_path())?;
            println!("SQLite schema version {SCHEMA_VERSION} ready; quick_check=ok; foreign_key_check=ok");
            return Ok(());
        }
        [] => (),
        _ => {
            return Err("Usage: paperkit-api [migrate | backup DESTINATION | --healthcheck]".into())
        }
    }
    let config = Config::load()?;
    let database = Database::open(&config.database)?;
    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    eprintln!(
        "paperkit-api: listening on {}; schema={SCHEMA_VERSION}; authentication=Supabase",
        listener.local_addr()?
    );
    axum::serve(listener, api::router(database, &config)?)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

fn healthcheck() -> Result<(), Box<dyn std::error::Error>> {
    let mut address: SocketAddr = std::env::var("BIND_ADDRESS")
        .unwrap_or_else(|_| "127.0.0.1:8080".into())
        .parse()?;
    if address.ip().is_unspecified() {
        address.set_ip(IpAddr::V4(Ipv4Addr::LOCALHOST));
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(3))?;
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    stream.write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
    let mut response = [0u8; 128];
    let count = stream.read(&mut response)?;
    if !response[..count].starts_with(b"HTTP/1.1 200 ") {
        return Err("Health check failed".into());
    }
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => (), _ = terminate => () }
    eprintln!("paperkit-api: shutting down");
}
