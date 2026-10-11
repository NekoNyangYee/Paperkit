use crate::commands::AppState;
use base64::Engine;
use pdf_core::render::{PreviewEngine, PreviewError};
use serde::Serialize;
use tauri::State;

pub struct PreviewState(pub PreviewEngine, pub std::path::PathBuf);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPage {
    file_id: String,
    page_count: i32,
    page_index: i32,
    width: u32,
    height: u32,
    image_url: String,
    text: pdf_core::text::PageText,
    state: pdf_core::edit::EditState,
}

fn message(error: PreviewError) -> String {
    match error {
        PreviewError::PageOverflow => "블록 너비가 너무 좁거나 내용이 페이지 경계를 벗어납니다. 블록 크기나 위치를 조절해 주세요.",
        PreviewError::LayoutReflowRequired => "이 선택은 글자 수와 공백 위치를 유지해야 합니다. 길이를 바꾸려면 같은 서식의 블록을 선택해 주세요.",
        PreviewError::FontUnavailable => {
            "원본 글꼴 데이터를 사용할 수 없습니다. ‘원본 글꼴 불러오기’에서 동일한 이름·굵기의 TTF/TTC를 선택해 주세요. 다른 글꼴로 자동 교체하지 않습니다."
        }
        PreviewError::MissingGlyph => {
            "원본 글꼴에 입력한 문자가 없습니다. 입력 내용은 유지했습니다. ‘원본 글꼴 불러오기’에서 해당 문자가 포함된 동일한 전체 글꼴을 선택해 주세요."
        }
        PreviewError::LibraryUnavailable => {
            "PDF 엔진 파일이 없거나 호환되지 않습니다. 앱을 다시 설치해 주세요."
        }
        PreviewError::WorkerStopped => "PDF 엔진이 종료되었습니다. 앱을 다시 시작해 주세요.",
        PreviewError::Busy => "다른 페이지를 처리하고 있습니다. 잠시 후 다시 시도해 주세요.",
        PreviewError::ReadFailed => {
            "PDF를 읽을 수 없습니다. 파일이 이동되었거나 접근이 제한되었는지 확인해 주세요."
        }
        PreviewError::TooLarge => "현재 미리보기는 128 MB 이하의 PDF를 지원합니다.",
        PreviewError::PasswordRequired => {
            "암호가 필요한 PDF입니다. 암호 입력 기능은 아직 지원하지 않습니다."
        }
        PreviewError::InvalidDocument => {
            "PDF 문서를 열 수 없습니다. 손상되었거나 지원하지 않는 형식입니다."
        }
        PreviewError::InvalidPage => "존재하지 않는 페이지입니다.",
        PreviewError::RenderFailed => "페이지를 표시하지 못했습니다. 다시 시도해 주세요.",
        PreviewError::StaleObject => "문서가 변경되었습니다. 페이지를 다시 확인해 주세요.",
        PreviewError::EditFailed => "텍스트를 수정하지 못했습니다. 기존 내용은 유지됩니다.",
        PreviewError::EditTooLarge => "현재 편집은 32 MB 이하의 문서를 지원합니다.",
        PreviewError::UnsupportedText => {
            "이 객체 또는 입력 문자는 아직 안전하게 수정할 수 없습니다."
        }
        PreviewError::TextOverflow => {
            "새 텍스트가 기존 영역을 벗어납니다. 더 짧은 내용으로 입력해 주세요."
        }
        PreviewError::VerificationFailed => {
            "변경 결과를 검증하지 못했습니다. 작업을 반영하지 않았습니다."
        }
        PreviewError::UnchangedTextModified => {
            "이 PDF를 다시 구성하는 과정에서 수정하지 않은 다른 글자의 보존에 실패했습니다. 원본과 입력 내용은 유지했습니다. 이 문서 구조는 현재 편집 엔진에서 지원을 보완해야 합니다."
        }
        PreviewError::NoHistory => "되돌릴 작업이 없습니다.",
        PreviewError::SaveFailed => {
            "파일을 저장하지 못했습니다. 로컬 폴더와 새 PDF 파일명을 선택해 주세요."
        }
        PreviewError::TargetExists => {
            "이미 존재하는 파일입니다. 원본 보호를 위해 새로운 파일명으로 저장해 주세요."
        }
    }
    .into()
}

#[tauri::command]
pub async fn list_fonts() -> Result<Vec<pdf_core::fonts::FontInfo>, String> {
    tauri::async_runtime::spawn_blocking(pdf_core::fonts::available)
        .await
        .map_err(|_| "글꼴 목록을 읽지 못했습니다.".into())
}

#[tauri::command]
pub async fn import_original_font(
    path: std::path::PathBuf,
    expected: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || pdf_core::fonts::import_original(&path, &expected))
        .await
        .map_err(|_| "원본 글꼴을 불러오지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn editing_background(
    file_id: String,
    revision: u64,
    page_index: i32,
    width: i32,
    objects: Vec<usize>,
    foreground: Option<bool>,
    preview: State<'_, PreviewState>,
) -> Result<String, String> {
    let engine = preview.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .layer(
                file_id,
                revision,
                page_index,
                width,
                objects,
                foreground.unwrap_or(false),
            )
            .map(|bytes| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            })
            .map_err(message)
    })
    .await
    .map_err(|_| "편집 화면을 준비하지 못했습니다.".to_owned())?
}

#[tauri::command]
pub async fn document_font(
    file_id: String,
    revision: u64,
    page_index: i32,
    object_id: usize,
    text: Option<String>,
    preview: State<'_, PreviewState>,
) -> Result<String, String> {
    let engine = preview.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine
            .font_for_text(file_id, revision, page_index, object_id, text)
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
            .map_err(message)
    })
    .await
    .map_err(|_| "원본 글꼴을 읽지 못했습니다.".to_string())?
}

#[tauri::command]
pub async fn editor_font(
    font_id: String,
    text: Option<String>,
    preview: State<'_, PreviewState>,
) -> Result<String, String> {
    let directory = preview.1.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if text.as_ref().is_some_and(|s| s.len() > 32768) {
            return Err("텍스트가 너무 깁니다.".to_owned());
        }
        pdf_core::fonts::load(&directory, &font_id, text.as_deref().unwrap_or(""))
            .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
            .map_err(message)
    })
    .await
    .map_err(|_| "편집 글꼴을 읽지 못했습니다.".to_string())?
}

#[tauri::command]
pub async fn render_selected_page(
    file_id: String,
    page_index: i32,
    width: i32,
    state: State<'_, AppState>,
    preview: State<'_, PreviewState>,
) -> Result<PreviewPage, String> {
    let path = {
        let selection = state.0.lock().map_err(|_| "파일 상태를 읽지 못했습니다.")?;
        let file = selection
            .file()
            .filter(|file| file.id == file_id)
            .ok_or("선택된 파일이 변경되었습니다.")?;
        file.info.path.clone()
    };
    let engine = preview.0.clone();
    let id = file_id.clone();
    let rendered =
        tauri::async_runtime::spawn_blocking(move || engine.render(id, path, page_index, width))
            .await
            .map_err(|_| "PDF 처리 작업을 완료하지 못했습니다.")?;
    let current = state
        .0
        .lock()
        .map_err(|_| "파일 상태를 읽지 못했습니다.")?
        .file()
        .is_some_and(|file| file.id == file_id);
    if !current {
        let engine = preview.0.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || engine.release(file_id)).await;
        return Err("선택된 파일이 변경되었습니다.".into());
    }
    let page = rendered.map_err(message)?;
    Ok(PreviewPage {
        text: page.text,
        state: page.state,
        file_id,
        page_count: page.page_count,
        page_index: page.page_index,
        width: page.width,
        height: page.height,
        image_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(page.png)
        ),
    })
}

#[tauri::command]
pub async fn edit_document(
    file_id: String,
    revision: u64,
    action: pdf_core::edit::EditAction,
    state: State<'_, AppState>,
    preview: State<'_, PreviewState>,
) -> Result<pdf_core::edit::EditState, String> {
    if !state
        .0
        .lock()
        .map_err(|_| "파일 상태를 읽지 못했습니다.")?
        .file()
        .is_some_and(|file| file.id == file_id)
    {
        return Err("선택된 파일이 변경되었습니다.".into());
    }
    let engine = preview.0.clone();
    tauri::async_runtime::spawn_blocking(move || engine.edit(file_id, revision, action))
        .await
        .map_err(|_| "PDF 작업을 완료하지 못했습니다.".to_string())?
        .map_err(message)
}

#[tauri::command]
pub async fn release_preview(
    file_id: String,
    preview: State<'_, PreviewState>,
) -> Result<(), String> {
    let engine = preview.0.clone();
    tauri::async_runtime::spawn_blocking(move || engine.release(file_id))
        .await
        .map_err(|_| "PDF 문서를 닫지 못했습니다.".to_string())?
        .map_err(message)
}
