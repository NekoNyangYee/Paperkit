use super::{
    files::AppState,
    preview::{message, PreviewState},
};
use pdf_core::ocr;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{ipc::Channel, State};
use uuid::Uuid;

#[derive(Default)]
pub struct ReadJobs(Mutex<HashMap<Uuid, Arc<AtomicBool>>>);

#[derive(Serialize)]
pub struct PageText {
    text: String,
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f32>,
}

#[tauri::command]
pub fn cancel_page_read(job_id: String, jobs: State<'_, ReadJobs>) {
    if let (Ok(id), Ok(active)) = (Uuid::parse_str(&job_id), jobs.0.lock()) {
        if let Some(job) = active.get(&id) {
            job.store(true, Ordering::Release);
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn extract_page_text(
    job_id: String,
    file_id: String,
    revision: u64,
    page_index: i32,
    force_ocr: bool,
    on_progress: Channel<u8>,
    state: State<'_, AppState>,
    preview: State<'_, PreviewState>,
    jobs: State<'_, ReadJobs>,
) -> Result<PageText, String> {
    if !state
        .1
        .lock()
        .map_err(|_| "파일 상태를 확인하지 못했어요.")?
        .contains_key(&file_id)
    {
        return Err("문서를 다시 선택해 주세요.".into());
    }
    let id = Uuid::parse_str(&job_id).map_err(|_| "잘못된 읽기 요청입니다.")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = jobs
            .0
            .lock()
            .map_err(|_| "읽기 상태를 확인하지 못했어요.")?;
        if active.len() >= 4 || active.contains_key(&id) {
            return Err("다른 페이지를 처리하고 있습니다.".into());
        }
        active.insert(id, Arc::clone(&cancelled));
    }
    let report = move |value| {
        let _ = on_progress.send(value);
    };
    report(0);
    let engine = preview.0.clone();
    let directory = preview.1.with_file_name("ocr");
    let result = tauri::async_runtime::spawn_blocking(move || {
        let page = engine
            .extract_text(file_id, revision, page_index, force_ocr)
            .map_err(message)?;
        if cancelled.load(Ordering::Acquire) {
            return Err("ocrCancelled".into());
        }
        match page.png {
            Some(png) => {
                let result = ocr::recognize(&directory, &png, &cancelled, report).map_err(
                    |err| match err {
                        ocr::OcrError::Cancelled => "ocrCancelled",
                        ocr::OcrError::TimedOut => "ocrTimeout",
                        ocr::OcrError::Unavailable => "ocrUnavailable",
                        ocr::OcrError::Failed => "ocrFailed",
                    },
                )?;
                Ok(PageText {
                    text: result.text,
                    source: "tesseract",
                    confidence: Some(result.confidence),
                })
            }
            None => Ok(PageText {
                text: page.text,
                source: "pdfium",
                confidence: None,
            }),
        }
    })
    .await;
    jobs.0
        .lock()
        .map_err(|_| "읽기 상태를 확인하지 못했어요.")?
        .remove(&id);
    result.map_err(|_| "페이지 글자를 읽지 못했어요.".to_owned())?
}
