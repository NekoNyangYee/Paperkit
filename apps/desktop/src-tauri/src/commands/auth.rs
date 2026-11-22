use super::auth_popup::LoginPopup;
use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

type LoginResult = Result<String, String>;
struct PendingLogin {
    id: String,
    listener: Option<TcpListener>,
    cancelled: Option<oneshot::Receiver<()>>,
    popup: Option<LoginPopup>,
    cancel: oneshot::Sender<()>,
}
#[derive(Default)]
pub struct AuthState(Mutex<Option<PendingLogin>>);

impl AuthState {
    async fn wait_for_popup_close(&self, id: &str) {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let Ok(mut state) = self.0.lock() else { return };
            let popup = state
                .as_mut()
                .filter(|login| login.id == id)
                .and_then(|login| login.popup.as_mut());
            if popup.is_none_or(|window| window.closed()) {
                return;
            }
        }
    }

    pub(crate) fn close(&self, id: Option<&str>) -> bool {
        let item = {
            let Ok(mut state) = self.0.lock() else {
                return false;
            };
            if !state
                .as_ref()
                .is_some_and(|p| id.is_none_or(|id| id == p.id))
            {
                return false;
            }
            state.take()
        };
        if let Some(p) = item {
            let _ = p.cancel.send(());
            return true;
        }
        false
    }
}

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
            listener: Some(listener),
            cancelled: Some(receive_cancel),
            popup: None,
            cancel: send_cancel,
        });
    }
    Ok(LoginChallenge { id, redirect_url })
}

#[tauri::command]
pub async fn finish_google_login(
    state: tauri::State<'_, AuthState>,
    id: String,
    authorize_url: String,
) -> LoginResult {
    let authorize = url::Url::parse(&authorize_url).map_err(|_| "잘못된 로그인 주소입니다.")?;
    if authorize.scheme() != "https" || authorize.path() != "/auth/v1/authorize" {
        return Err("잘못된 로그인 주소입니다.".into());
    }
    let (listener, cancelled) = {
        let mut state = state
            .0
            .lock()
            .map_err(|_| "로그인 상태를 확인하지 못했습니다.")?;
        let pending = state
            .as_mut()
            .filter(|p| p.id == id)
            .ok_or("로그인 요청이 만료되었습니다.")?;
        if pending.listener.is_none() {
            return Err("이미 처리 중인 로그인입니다.".into());
        }
        pending.popup = Some(LoginPopup::open(&authorize)?);
        (
            pending
                .listener
                .take()
                .ok_or("이미 처리 중인 로그인입니다.")?,
            pending.cancelled.take().ok_or("로그인이 취소되었습니다.")?,
        )
    };
    let path = format!("/auth/callback/{id}");
    tokio::select! {
        _ = cancelled => Err("login_cancelled".into()),
        _ = state.wait_for_popup_close(&id) => Err("login_cancelled".into()),
        result = tokio::time::timeout(Duration::from_secs(180), receive_callback(&listener, &path)) =>
            result.map_err(|_| "로그인 시간이 지났습니다. 다시 시도해 주세요.")?,
    }
}

#[tauri::command]
pub fn complete_google_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, AuthState>,
    id: String,
    success: bool,
) {
    if state.close(Some(&id)) && success {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[tauri::command]
pub fn cancel_google_login(state: tauri::State<'_, AuthState>, id: String) {
    state.close(Some(&id));
}

async fn receive_callback(listener: &TcpListener, path: &str) -> LoginResult {
    let host = listener
        .local_addr()
        .map_err(|_| "로그인 창을 준비하지 못했습니다.")?
        .to_string();
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "로그인 응답을 받지 못했습니다.")?;
        match tokio::time::timeout(Duration::from_secs(3), read_request(&mut stream, &host)).await {
            Ok(Ok(url)) if url.path() == path => {
                let headers = b"HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
                let _ = stream.write_all(headers).await;
                if url
                    .query_pairs()
                    .any(|(k, v)| k == "error" && v == "access_denied")
                {
                    return Err("login_cancelled".into());
                }
                let mut codes = url.query_pairs().filter(|(key, _)| key == "code");
                if let Some((_, code)) = codes.next() {
                    if !code.is_empty() && code.len() <= 4096 && codes.next().is_none() {
                        return Ok(code.into_owned());
                    }
                }
                return Err("로그인 응답이 올바르지 않습니다.".into());
            }
            _ => {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        }
    }
}

async fn read_request(stream: &mut TcpStream, host: &str) -> Result<url::Url, ()> {
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
        return Err(());
    }
    let target = request
        .next()
        .filter(|target| target.starts_with('/') && !target.starts_with("//"))
        .ok_or(())?;
    if !lines.any(|line| {
        line.split_once(':')
            .is_some_and(|(key, value)| key.eq_ignore_ascii_case("host") && value.trim() == host)
    }) {
        return Err(());
    }
    url::Url::parse(&format!("http://{host}{target}")).map_err(|_| ())
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
        let receiver = tokio::spawn(async move {
            receive_callback(&listener, "/auth/callback/random-nonce")
                .await
                .unwrap()
        });
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
                b"HTTP/1.1 204"
            } else {
                b"HTTP/1.1 404"
            }));
        }
        assert_eq!(receiver.await.unwrap(), "good");
    }
}
