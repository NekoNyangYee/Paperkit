use pdf_core::document::{inspect_pdf_file, FileCheckError};
use pdf_core::selection::Selection;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::{collections::HashMap, path::PathBuf};

#[derive(Default)]
pub struct AppState(pub Mutex<Selection>, pub Mutex<HashMap<String, PathBuf>>);

#[derive(Debug, Serialize)]
pub struct InputError {
    code: &'static str,
    message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    id: String,
    path: String,
    name: String,
    size_bytes: u64,
}

#[derive(Serialize)]
pub struct SelectionSnapshot {
    revision: u64,
    file: Option<FileInfo>,
    error: Option<InputError>,
}

fn snapshot(selection: &Selection) -> SelectionSnapshot {
    SelectionSnapshot {
        revision: selection.revision(),
        error: None,
        file: selection.file().map(|file| FileInfo {
            id: file.id.clone(),
            path: file.info.path.to_string_lossy().into_owned(),
            name: file.info.name.clone(),
            size_bytes: file.info.size_bytes,
        }),
    }
}

fn internal_error() -> InputError {
    InputError {
        code: "internal",
        message: "파일 상태를 확인할 수 없습니다. 다시 시도해 주세요.",
    }
}

#[tauri::command]
pub fn synchronize_selection(
    state: tauri::State<'_, AppState>,
) -> Result<SelectionSnapshot, InputError> {
    let mut selection = state.0.lock().map_err(|_| internal_error())?;
    selection.synchronize();
    if let Some(file) = selection.file() {
        state
            .1
            .lock()
            .map_err(|_| internal_error())?
            .insert(file.id.clone(), file.info.path.clone());
    }
    Ok(snapshot(&selection))
}

#[tauri::command]
pub fn clear_selection(
    revision: u64,
    state: tauri::State<'_, AppState>,
) -> Result<SelectionSnapshot, InputError> {
    let mut selection = state.0.lock().map_err(|_| internal_error())?;
    selection.clear(revision);
    Ok(snapshot(&selection))
}

impl From<FileCheckError> for InputError {
    fn from(error: FileCheckError) -> Self {
        let (code, message) = match error {
            FileCheckError::NotFound => (
                "notFound",
                "파일을 찾을 수 없습니다. 이동하거나 삭제되었는지 확인해 주세요.",
            ),
            FileCheckError::PermissionDenied => (
                "permissionDenied",
                "파일을 읽을 권한이 없습니다. 파일 접근 권한을 확인해 주세요.",
            ),
            FileCheckError::NotAFile => ("notAFile", "폴더 대신 PDF 파일을 선택해 주세요."),
            FileCheckError::EmptyFile => (
                "emptyFile",
                "내용이 없는 빈 파일입니다. 다른 PDF를 선택해 주세요.",
            ),
            FileCheckError::NotPdfExtension => {
                ("notPdfExtension", "확장자가 .pdf인 파일을 선택해 주세요.")
            }
            FileCheckError::InvalidHeader => (
                "invalidHeader",
                "지원하는 PDF 헤더를 확인할 수 없습니다. 파일 형식을 확인해 주세요.",
            ),
            FileCheckError::ReadFailed => (
                "readFailed",
                "파일을 읽을 수 없습니다. 다른 프로그램의 사용 여부나 파일 상태를 확인해 주세요.",
            ),
        };
        Self { code, message }
    }
}

fn single_path(paths: Vec<String>) -> Result<String, InputError> {
    if paths.len() != 1 {
        return Err(InputError {
            code: "fileCount",
            message: "PDF 한 개만 선택해 주세요.",
        });
    }
    let path = paths.into_iter().next().unwrap();
    if path.trim().is_empty() {
        return Err(InputError {
            code: "emptyPath",
            message: "파일 경로가 비어 있습니다.",
        });
    }
    Ok(path)
}

#[tauri::command]
pub async fn receive_file_input(
    paths: Vec<String>,
    revision: u64,
    state: tauri::State<'_, AppState>,
) -> Result<SelectionSnapshot, InputError> {
    process_file_input(paths, revision, &state).await
}

async fn process_file_input(
    paths: Vec<String>,
    revision: u64,
    state: &AppState,
) -> Result<SelectionSnapshot, InputError> {
    {
        let mut selection = state.0.lock().map_err(|_| internal_error())?;
        if !selection.begin(revision) {
            return Ok(snapshot(&selection));
        }
    }
    let result = match single_path(paths) {
        Ok(path) => {
            tauri::async_runtime::spawn_blocking(move || inspect_pdf_file(Path::new(&path)))
                .await
                .map_err(|_| internal_error())
                .and_then(|result| result.map_err(InputError::from))
        }
        Err(error) => Err(error),
    };
    let mut selection = state.0.lock().map_err(|_| internal_error())?;
    if revision != selection.revision() {
        return Ok(snapshot(&selection));
    }
    match result {
        Ok(info) => {
            selection.commit(revision, info);
            if let Some(file) = selection.file() {
                state
                    .1
                    .lock()
                    .map_err(|_| internal_error())?
                    .insert(file.id.clone(), file.info.path.clone());
            }
            Ok(snapshot(&selection))
        }
        Err(error) => {
            let mut result = snapshot(&selection);
            result.error = Some(error);
            Ok(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_multiple_or_missing_paths() {
        assert!(single_path(vec![]).is_err());
        assert!(single_path(vec!["a.pdf".into(), "b.pdf".into()]).is_err());
        assert!(single_path(vec![" ".into()]).is_err());
    }
    #[test]
    fn preserves_unicode_and_spaces() {
        let path = r"C:\문서 폴더\검토 자료.pdf";
        assert_eq!(single_path(vec![path.into()]).unwrap(), path);
    }

    #[test]
    fn file_validation_and_selection_flow_preserves_original_and_reports_errors() {
        let directory =
            std::env::temp_dir().join(format!("paperkit-command-flow-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone());
        let pdf = directory.join("통합 테스트.pdf");
        let fake = directory.join("fake.pdf");
        let bytes = b"%PDF-1.7\nheader fixture, not a parsed document";
        std::fs::write(&pdf, bytes).unwrap();
        std::fs::write(&fake, b"not a PDF").unwrap();
        let state = AppState::default();
        tauri::async_runtime::block_on(async {
            let selected = process_file_input(vec![pdf.to_string_lossy().into_owned()], 1, &state)
                .await
                .unwrap();
            let selected = selected.file.unwrap();
            assert_eq!(selected.name, "통합 테스트.pdf");
            assert_eq!(selected.size_bytes, bytes.len() as u64);

            let rejected = process_file_input(vec![fake.to_string_lossy().into_owned()], 2, &state)
                .await
                .unwrap();
            assert_eq!(rejected.error.unwrap().code, "invalidHeader");
            assert_eq!(rejected.file.unwrap().id, selected.id);

            let multiple = process_file_input(vec!["a.pdf".into(), "b.pdf".into()], 3, &state)
                .await
                .unwrap();
            assert_eq!(multiple.error.unwrap().code, "fileCount");
            assert_eq!(multiple.file.unwrap().id, selected.id);

            state.0.lock().unwrap().clear(4);
            let stale = process_file_input(vec![pdf.to_string_lossy().into_owned()], 3, &state)
                .await
                .unwrap();
            assert!(stale.file.is_none());
            assert_eq!(stale.revision, 4);
            let selected_again =
                process_file_input(vec![pdf.to_string_lossy().into_owned()], 5, &state)
                    .await
                    .unwrap();
            assert_ne!(selected_again.file.unwrap().id, selected.id);
        });
        assert_eq!(std::fs::read(pdf).unwrap(), bytes);
    }
}
