use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub(super) struct LoginPopup {
    child: Child,
    _profile: tempfile::TempDir,
}

impl LoginPopup {
    pub(super) fn open(url: &url::Url) -> Result<Self, String> {
        // A separate profile gives this attempt its own browser process and window.
        let profile = tempfile::Builder::new()
            .prefix("paperkit-login-")
            .tempdir()
            .map_err(|_| "로그인 창을 준비하지 못했습니다.")?;
        for browser in browsers() {
            if let Ok(child) = Command::new(browser)
                .arg(format!("--user-data-dir={}", profile.path().display()))
                .args([
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-background-mode",
                    "--disable-sync",
                    "--window-size=540,740",
                ])
                .arg(format!("--app={url}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                return Ok(Self {
                    child,
                    _profile: profile,
                });
            }
        }
        Err("로그인 창을 열려면 Chrome 또는 Microsoft Edge가 필요합니다.".into())
    }

    pub(super) fn closed(&mut self) -> bool {
        !matches!(self.child.try_wait(), Ok(None))
    }
}

impl Drop for LoginPopup {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    #[ignore = "opens an installed browser in a temporary profile"]
    async fn opens_the_requested_url_and_releases_the_login_profile() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = url::Url::parse(&format!("http://{addr}/popup-check")).unwrap();
        let mut popup = LoginPopup::open(&url).unwrap();
        let profile = popup._profile.path().to_owned();
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0; 1024];
                let n = stream.read(&mut request).await.unwrap();
                let _ = stream
                    .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                    .await;
                if request[..n].starts_with(b"GET /popup-check ") {
                    break;
                }
            }
        })
        .await
        .unwrap();
        assert!(!popup.closed());
        drop(popup);
        assert!(!profile.exists());
    }
}

fn browsers() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        [
            "Google/Chrome/Application/chrome.exe",
            "Microsoft/Edge/Application/msedge.exe",
        ]
        .into_iter()
        .flat_map(|exe| {
            ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
                .into_iter()
                .filter_map(std::env::var_os)
                .map(move |root| PathBuf::from(root).join(exe))
        })
        .filter(|path| path.is_file())
        .collect()
    }
    #[cfg(target_os = "macos")]
    {
        [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
        .map(PathBuf::from)
        .into()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        ["google-chrome", "chromium", "microsoft-edge"]
            .map(PathBuf::from)
            .into()
    }
}
