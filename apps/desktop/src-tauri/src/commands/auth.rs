use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

type LoginResult = Result<String, String>;
struct PendingLogin {
    id: String,
    result: Option<oneshot::Receiver<LoginResult>>,
    cancel: oneshot::Sender<()>,
}
#[derive(Default)]
pub struct AuthState(Mutex<Option<PendingLogin>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    id: String,
    redirect_url: String,
}

#[tauri::command]
pub async fn begin_google_login(
    state: tauri::State<'_, AuthState>,
) -> Result<LoginChallenge, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "로그인 창을 준비하지 못했습니다.")?;
    let address = listener
        .local_addr()
        .map_err(|_| "로그인 창을 준비하지 못했습니다.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = format!("/auth/callback/{id}");
    let redirect_url = format!("http://{address}{path}");
    let (send_result, receive_result) = oneshot::channel();
    let (send_cancel, receive_cancel) = oneshot::channel();
    {
        let mut pending = state
            .0
            .lock()
            .map_err(|_| "로그인 상태를 확인하지 못했습니다.")?;
        if let Some(previous) = pending.take() {
            let _ = previous.cancel.send(());
        }
        *pending = Some(PendingLogin {
            id: id.clone(),
            result: Some(receive_result),
            cancel: send_cancel,
        });
    }
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            _ = receive_cancel => Err("로그인을 취소했습니다.".into()),
            result = tokio::time::timeout(Duration::from_secs(180), receive_callback(listener, path)) =>
                result.unwrap_or_else(|_| Err("로그인 시간이 지났습니다. 다시 시도해 주세요.".into())),
        };
        let _ = send_result.send(result);
    });
    Ok(LoginChallenge { id, redirect_url })
}

#[tauri::command]
pub async fn finish_google_login(state: tauri::State<'_, AuthState>, id: String) -> LoginResult {
    let receive = {
        let mut pending = state
            .0
            .lock()
            .map_err(|_| "로그인 상태를 확인하지 못했습니다.")?;
        let pending = pending
            .as_mut()
            .filter(|pending| pending.id == id)
            .ok_or("로그인 요청이 만료되었습니다.")?;
        pending
            .result
            .take()
            .ok_or("이미 처리 중인 로그인입니다.")?
    };
    let result = receive
        .await
        .unwrap_or_else(|_| Err("로그인을 완료하지 못했습니다.".into()));
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "로그인 상태를 확인하지 못했습니다.")?;
    if pending.as_ref().is_some_and(|pending| pending.id == id) {
        *pending = None;
    }
    result
}

#[tauri::command]
pub fn cancel_google_login(state: tauri::State<'_, AuthState>, id: String) -> Result<(), String> {
    let mut pending = state
        .0
        .lock()
        .map_err(|_| "로그인 상태를 확인하지 못했습니다.")?;
    if pending.as_ref().is_some_and(|pending| pending.id == id) {
        if let Some(pending) = pending.take() {
            let _ = pending.cancel.send(());
        }
    }
    Ok(())
}

async fn receive_callback(listener: TcpListener, expected_path: String) -> LoginResult {
    let address = listener
        .local_addr()
        .map_err(|_| "로그인 창을 준비하지 못했습니다.")?;
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "로그인 응답을 받지 못했습니다.")?;
        let parsed = tokio::time::timeout(
            Duration::from_secs(3),
            read_callback(&mut stream, &address.to_string(), &expected_path),
        )
        .await;
        match parsed {
            Ok(Ok(Some(result))) => {
                let text = if result.is_ok() {
                    "앱에서 로그인 응답을 처리하고 있습니다."
                } else {
                    "로그인을 완료하지 못했습니다. Paperkit에서 다시 시도해 주세요."
                };
                let _ = respond(&mut stream, "200 OK", text).await;
                return result;
            }
            _ => {
                let _ = respond(&mut stream, "404 Not Found", "Not found").await;
            }
        }
    }
}

async fn read_callback(
    stream: &mut TcpStream,
    host: &str,
    expected_path: &str,
) -> Result<Option<LoginResult>, ()> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 1024];
    while !bytes.windows(4).any(|v| v == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).await.map_err(|_| ())?;
        if read == 0 || bytes.len() + read > 8192 {
            return Err(());
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next().ok_or(())?.split_whitespace();
    if request.next() != Some("GET") {
        return Ok(None);
    }
    let target = request
        .next()
        .filter(|target| target.starts_with('/') && !target.starts_with("//"))
        .ok_or(())?;
    if !lines.any(|line| {
        line.split_once(':')
            .is_some_and(|(key, value)| key.eq_ignore_ascii_case("host") && value.trim() == host)
    }) {
        return Ok(None);
    }
    let url = url::Url::parse(&format!("http://{host}{target}")).map_err(|_| ())?;
    if url.path() != expected_path {
        return Ok(None);
    }
    let codes: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "code")
        .map(|(_, value)| value.into_owned())
        .collect();
    if codes.len() != 1 || codes[0].is_empty() || codes[0].len() > 4096 {
        return Ok(Some(Err(
            "Google 로그인을 완료하지 못했습니다. 다시 시도해 주세요.".into(),
        )));
    }
    Ok(Some(Ok(codes[0].clone())))
}

async fn respond(stream: &mut TcpStream, status: &str, text: &str) -> std::io::Result<()> {
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let style = include_str!("auth-callback.css");
    let logo = include_str!("../../../app-icon.svg");
    let text = text
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let body = format!(
        r#"<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Paperkit</title><style nonce="{nonce}">{style}</style></head>
<body><main class="card"><div class="brand">{logo}<span>Paperkit</span></div>
<div class="divider" aria-hidden="true"></div><h1>Paperkit으로 돌아가 주세요</h1>
<p>{text}</p><div class="hint">이 탭은 닫아도 됩니다.</div></main></body></html>"#
    );
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'nonce-{nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len());
    tokio::time::timeout(
        Duration::from_secs(2),
        stream.write_all(response.as_bytes()),
    )
    .await??;
    Ok(())
}

#[cfg(windows)]
fn credential(project: &str) -> Result<keyring::Entry, String> {
    use sha2::{Digest, Sha256};
    let user = format!("{:x}", Sha256::digest(project.as_bytes()));
    keyring::Entry::new("com.paperkit.desktop.supabase.refresh", &user)
        .map_err(|_| "로그인 정보를 안전하게 보관할 수 없습니다.".into())
}

#[tauri::command]
pub async fn read_auth_refresh_token(project: String) -> Result<Option<String>, String> {
    if project.len() > 512 {
        return Err("잘못된 로그인 설정입니다.".into());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        match credential(&project)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("저장된 로그인 정보를 읽지 못했습니다.".into()),
        }
    })
    .await
    .map_err(|_| "저장된 로그인 정보를 읽지 못했습니다.".to_string())?;
    #[cfg(not(windows))]
    Ok(None)
}

#[tauri::command]
pub async fn write_auth_refresh_token(
    project: String,
    refresh_token: Option<String>,
) -> Result<(), String> {
    if project.len() > 512
        || refresh_token
            .as_ref()
            .is_some_and(|v| v.len() > 2048 || !v.bytes().all(|b| b.is_ascii_graphic()))
    {
        return Err("잘못된 로그인 정보입니다.".into());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let entry = credential(&project)?;
        match refresh_token {
            Some(value) => entry
                .set_password(&value)
                .map_err(|_| "로그인 정보를 안전하게 저장하지 못했습니다.".into()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err("저장된 로그인 정보를 지우지 못했습니다.".into()),
            },
        }
    })
    .await
    .map_err(|_| "로그인 정보 저장을 완료하지 못했습니다.".to_string())?;
    #[cfg(not(windows))]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn callback_requires_matching_host_and_random_path_before_accepting_a_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let receiver = tokio::spawn(receive_callback(
            listener,
            "/auth/callback/random-nonce".into(),
        ));
        for (path, host) in [
            ("/auth/callback/other?code=bad", address.to_string()),
            (
                "/auth/callback/random-nonce?code=bad",
                "evil.example".into(),
            ),
            ("/auth/callback/random-nonce?code=good", address.to_string()),
        ] {
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").as_bytes())
                .await
                .unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).await.unwrap();
            assert!(response.starts_with(if path.ends_with("good") {
                b"HTTP/1.1 200"
            } else {
                b"HTTP/1.1 404"
            }));
        }
        assert_eq!(receiver.await.unwrap().unwrap(), "good");
    }
}
