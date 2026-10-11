use reqwest::blocking::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    sync::Mutex,
    time::Duration,
};
use tauri::{ipc::Channel, Manager};

const BASE: &str = "https://github.com/NekoNyangYee/Paperkit/releases/download";
const LIMIT: u64 = 256 * 1024 * 1024;

struct Prepared {
    path: tempfile::TempPath,
    hash: String,
}

#[derive(Default)]
enum Stage {
    #[default]
    Idle,
    Downloading,
    Ready(Prepared),
    Installing,
}

#[derive(Default)]
pub struct UpdateState(Mutex<Stage>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

fn installer_name(tag: &str, current: &str) -> Result<String, String> {
    let version = tag
        .strip_prefix('v')
        .ok_or("업데이트 버전이 올바르지 않습니다.")?;
    let parsed =
        semver::Version::parse(version).map_err(|_| "업데이트 버전이 올바르지 않습니다.")?;
    let installed =
        semver::Version::parse(current).map_err(|_| "현재 버전을 확인할 수 없습니다.")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() || parsed <= installed {
        return Err("현재 버전보다 새로운 정식 업데이트만 설치할 수 있습니다.".into());
    }
    Ok(format!("Paperkit_{version}_x64-setup.exe"))
}

fn checksum(contents: &str, name: &str) -> Result<String, String> {
    let matches: Vec<_> = contents
        .trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let hash = fields.next()?;
            let file = fields.next()?.trim_start_matches('*');
            (file == name
                && fields.next().is_none()
                && hash.len() == 64
                && hash.bytes().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
        })
        .collect();
    if matches.len() != 1 {
        return Err("업데이트 검증 정보를 확인할 수 없습니다.".into());
    }
    Ok(matches[0].clone())
}

fn verify(path: &std::path::Path, expected: &str) -> Result<(), String> {
    let mut file =
        std::fs::File::open(path).map_err(|_| "다운로드한 업데이트를 읽을 수 없습니다.")?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|_| "업데이트 파일 검증에 실패했습니다.")?;
    if format!("{:x}", hash.finalize()) != expected {
        return Err("업데이트 파일 검증에 실패했습니다. 다시 다운로드해 주세요.".into());
    }
    Ok(())
}

fn download(
    directory: &std::path::Path,
    current: &str,
    tag: &str,
    progress: impl Fn(Progress),
) -> Result<Prepared, String> {
    let name = installer_name(tag, current)?;
    let client = Client::builder()
        .https_only(true)
        .user_agent("Paperkit updater")
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|_| "업데이트 연결을 준비하지 못했습니다.")?;
    let mut manifest = client
        .get(format!("{BASE}/{tag}/SHA256SUMS.txt"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "업데이트 검증 정보를 내려받지 못했습니다.")?
        .take(16385);
    let mut contents = String::new();
    manifest
        .read_to_string(&mut contents)
        .map_err(|_| "업데이트 검증 정보를 읽지 못했습니다.")?;
    if contents.len() > 16384 {
        return Err("업데이트 검증 정보가 올바르지 않습니다.".into());
    }
    let hash = checksum(&contents, &name)?;
    let mut response = client
        .get(format!("{BASE}/{tag}/{name}"))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "업데이트 다운로드에 실패했습니다. 다시 시도해 주세요.")?;
    let total = response.content_length();
    if total.is_some_and(|n| n == 0 || n > LIMIT) {
        return Err("업데이트 파일 크기가 올바르지 않습니다.".into());
    }
    std::fs::create_dir_all(&directory).map_err(|_| "업데이트 저장 폴더를 만들지 못했습니다.")?;
    let mut file = tempfile::Builder::new()
        .prefix("paperkit-")
        .suffix(".exe")
        .tempfile_in(directory)
        .map_err(|_| "업데이트 파일을 만들지 못했습니다.")?;
    let mut downloaded = 0;
    let mut buffer = [0; 65536];
    let mut last = std::time::Instant::now();
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|_| "다운로드가 중단되었습니다. 다시 시도해 주세요.")?;
        if count == 0 {
            break;
        }
        downloaded += count as u64;
        if downloaded > LIMIT {
            return Err("업데이트 파일이 너무 큽니다.".into());
        }
        file.write_all(&buffer[..count])
            .map_err(|_| "업데이트 파일을 저장하지 못했습니다. 여유 공간을 확인해 주세요.")?;
        if last.elapsed() >= Duration::from_millis(100) {
            progress(Progress { downloaded, total });
            last = std::time::Instant::now();
        }
    }
    if downloaded == 0 || total.is_some_and(|n| n != downloaded) {
        return Err("다운로드가 완료되지 않았습니다. 다시 시도해 주세요.".into());
    }
    file.flush()
        .map_err(|_| "업데이트 파일을 저장하지 못했습니다.")?;
    let path = file.into_temp_path();
    verify(&path, &hash)?;
    progress(Progress {
        downloaded,
        total: Some(downloaded),
    });
    Ok(Prepared { path, hash })
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    tag: String,
    progress: Channel<Progress>,
) -> Result<(), String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "업데이트 저장 폴더를 찾지 못했습니다.")?
        .join("updates");
    let current = app.package_info().version.to_string();
    {
        let state = app.state::<UpdateState>();
        let mut stage = state
            .0
            .lock()
            .map_err(|_| "업데이트 상태를 읽지 못했습니다.")?;
        if matches!(*stage, Stage::Downloading | Stage::Installing) {
            return Err("업데이트를 이미 처리 중입니다.".into());
        }
        *stage = Stage::Downloading;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        download(&directory, &current, &tag, |value| {
            let _ = progress.send(value);
        })
    })
    .await
    .map_err(|_| "업데이트 다운로드 작업이 중단되었습니다.".to_string())
    .and_then(|result| result);
    let state = app.state::<UpdateState>();
    let mut stage = state
        .0
        .lock()
        .map_err(|_| "업데이트 상태를 읽지 못했습니다.")?;
    match result {
        Ok(prepared) => {
            *stage = Stage::Ready(prepared);
            Ok(())
        }
        Err(error) => {
            *stage = Stage::Idle;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<UpdateState>();
        let mut stage = state
            .0
            .lock()
            .map_err(|_| "업데이트 상태를 읽지 못했습니다.")?;
        let Stage::Ready(prepared) = &*stage else {
            return Err("업데이트를 먼저 다운로드해 주세요.".to_string());
        };
        verify(&prepared.path, &prepared.hash)?;
        // Tauri NSIS: passive installation, preserve settings, relaunch on success.
        std::process::Command::new(&prepared.path)
            .args(["/P", "/UPDATE", "/R"])
            .spawn()
            .map_err(|_| "업데이트 설치를 시작하지 못했습니다. 다시 시도해 주세요.".to_string())?;
        // Keep the downloaded file alive until the installer has opened it.
        let Stage::Ready(prepared) = std::mem::replace(&mut *stage, Stage::Installing) else {
            unreachable!()
        };
        let _ = prepared.path.keep();
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "업데이트 설치 작업이 중단되었습니다.".to_string())??;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "downloads the published installer from GitHub without executing it"]
    fn downloads_and_verifies_published_installer() {
        let directory = tempfile::tempdir().unwrap();
        let progress = std::cell::Cell::new(0);
        let result = download(directory.path(), "0.1.0", "v0.2.0", |value| {
            progress.set(value.downloaded)
        })
        .unwrap();
        assert!(progress.get() > 1_000_000);
        verify(&result.path, &result.hash).unwrap();
        let mut header = [0; 2];
        std::fs::File::open(&result.path)
            .unwrap()
            .read_exact(&mut header)
            .unwrap();
        assert_eq!(&header, b"MZ");
    }
    #[test]
    fn only_new_stable_versions_form_download_paths() {
        assert_eq!(
            installer_name("v0.3.0", "0.2.0").unwrap(),
            "Paperkit_0.3.0_x64-setup.exe"
        );
        for tag in [
            "v0.2.0",
            "v0.1.0",
            "v0.3.0-beta.1",
            "v0.3.0+abc",
            "../../bad",
            "v01.0.0",
        ] {
            assert!(installer_name(tag, "0.2.0").is_err());
        }
    }
    #[test]
    fn verifies_exact_asset_and_rejects_modified_download() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"installer").unwrap();
        let hash = format!("{:x}", Sha256::digest(b"installer"));
        assert_eq!(
            checksum(&format!("\u{feff}{hash}  app.exe\r\n"), "app.exe").unwrap(),
            hash
        );
        assert!(checksum(&format!("{hash}  other.exe"), "app.exe").is_err());
        assert!(checksum("xyz app.exe", "app.exe").is_err());
        assert!(verify(file.path(), &hash).is_ok());
        file.write_all(b"changed").unwrap();
        assert!(verify(file.path(), &hash).is_err());
    }
}
