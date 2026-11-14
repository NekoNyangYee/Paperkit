//! Owns the PDFium instance and independent document sessions with transactional history.
use super::{
    protocol::Request,
    raster::{render_loaded_page, render_page},
};
use crate::{editing::History, engine::error::EngineError as PreviewError};
use pdfium_render::prelude::*;
use std::{collections::HashMap, fs::File, io::Read, path::PathBuf, sync::mpsc::Receiver};
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub(super) fn run(library: PathBuf, font_directory: PathBuf, receiver: Receiver<Request>) {
    let ensemble = super::ensemble::Ensemble::new(
        library
            .parent()
            .and_then(|p| p.parent())
            .unwrap_or(std::path::Path::new("")),
    );
    let pdfium = Pdfium::bind_to_library(library).map(Pdfium::new);
    // Sessions live after Pdfium and drop before it: no self-referential struct.
    let mut documents = HashMap::new();
    let mut caches: HashMap<String, super::session_cache::SessionCache> = HashMap::new();
    while let Ok(request) = receiver.recv() {
        let session_id = match &request {
            Request::ExtractText { id, .. }
            | Request::CopyGraphic { id, .. }
            | Request::Background { id, .. }
            | Request::Font { id, .. }
            | Request::Edit { id, .. }
            | Request::Render { id, .. }
            | Request::Release(id) => id.clone(),
        };
        let (mut current, mut history, mut watermark_pages, mut recovered) =
            documents.remove(&session_id).unwrap_or_else(|| {
                (
                    None::<(String, PdfDocument<'_>)>,
                    History::default(),
                    Vec::new(),
                    false,
                )
            });
        let mut cache = caches.remove(&session_id).unwrap_or_default();
        match request {
            Request::ExtractText {
                id,
                revision,
                page,
                force_ocr,
                reply,
            } => {
                let result = (|| {
                    let (_, document) = current
                        .as_ref()
                        .filter(|(active, _)| *active == id)
                        .ok_or(PreviewError::StaleObject)?;
                    if history.state.revision != revision {
                        return Err(PreviewError::StaleObject);
                    }
                    if !document
                        .permissions()
                        .can_extract_text_and_graphics()
                        .unwrap_or(false)
                    {
                        return Err(PreviewError::UnsupportedText);
                    }
                    let target = document
                        .pages()
                        .get(page)
                        .map_err(|_| PreviewError::InvalidPage)?;
                    // Full-page extraction also reaches Form XObjects that the object editor
                    // cannot address safely. OCR is for reading, never synthetic edit IDs.
                    let text = target.text().map(|text| text.all()).unwrap_or_default();
                    let meaningful = text.chars().any(char::is_alphanumeric)
                        && text.chars().filter(|c| *c == '\u{fffd}').count() * 5
                            < text.chars().count();
                    let png = if force_ocr || !meaningful {
                        Some(render_loaded_page(document, &target, page, 1600, false, false)?.png)
                    } else {
                        None
                    };
                    Ok(super::ExtractedPage { text, png })
                })();
                let _ = reply.send(result);
            }
            Request::CopyGraphic {
                id,
                revision,
                page,
                object,
                reply,
            } => {
                let result = (|| {
                    let pdfium = pdfium
                        .as_ref()
                        .map_err(|_| PreviewError::LibraryUnavailable)?;
                    let (_, document) = current
                        .as_ref()
                        .filter(|(active, _)| *active == id)
                        .ok_or(PreviewError::StaleObject)?;
                    if history.state.revision != revision {
                        return Err(PreviewError::StaleObject);
                    }
                    crate::editing::graphics::copy(pdfium, document, page, object)
                })();
                let _ = reply.send(result);
            }
            Request::Background {
                foreground,
                id,
                revision,
                page,
                width,
                mut objects,
                reply,
            } => {
                let result = (|| {
                    let pdfium = pdfium
                        .as_ref()
                        .map_err(|_| PreviewError::LibraryUnavailable)?;
                    let (_, document) = current
                        .as_ref()
                        .filter(|(active, _)| *active == id)
                        .ok_or(PreviewError::StaleObject)?;
                    if history.state.revision != revision
                        || objects.len() > 2048
                        || !(300..=1600).contains(&width)
                    {
                        return Err(PreviewError::StaleObject);
                    }
                    objects.sort_unstable();
                    objects.dedup();
                    let key = (revision, page, width, foreground, objects.clone());
                    if let Some(png) = cache.layers.get(&key) {
                        return Ok(png.clone());
                    }
                    let candidate = pdfium
                        .load_pdf_from_byte_vec(
                            document
                                .save_to_bytes()
                                .map_err(|_| PreviewError::RenderFailed)?,
                            None,
                        )
                        .map_err(|_| PreviewError::RenderFailed)?;
                    let mut target = candidate
                        .pages()
                        .get(page)
                        .map_err(|_| PreviewError::InvalidPage)?;
                    objects.sort_unstable();
                    objects.dedup();
                    for &id in &objects {
                        target
                            .objects()
                            .get(id)
                            .map_err(|_| PreviewError::StaleObject)?;
                    }
                    let remove: Vec<_> = if foreground {
                        (0..target.objects().len())
                            .filter(|i| !objects.contains(i))
                            .collect()
                    } else {
                        objects
                    };
                    target.set_content_regeneration_strategy(
                        PdfPageContentRegenerationStrategy::Manual,
                    );
                    // Physically remove unwanted objects from this private,
                    // loaded page. Inactive flags are not a rendering filter
                    // for every PDFium page composition. Do not regenerate.
                    for id in remove.into_iter().rev() {
                        target
                            .objects_mut()
                            .remove_object_at_index(id)
                            .map_err(|_| PreviewError::RenderFailed)?;
                    }
                    let png =
                        render_loaded_page(&candidate, &target, page, width, foreground, false)?
                            .png;
                    cache.layers.insert(key, png.clone());
                    Ok(png)
                })();
                let _ = reply.send(result);
            }
            Request::Font {
                id,
                revision,
                page,
                object,
                value,
                reply,
            } => {
                let result = (|| {
                    let (_, document) = current
                        .as_ref()
                        .filter(|(active, _)| *active == id)
                        .ok_or(PreviewError::StaleObject)?;
                    if history.state.revision != revision {
                        return Err(PreviewError::StaleObject);
                    }
                    if !document
                        .permissions()
                        .can_extract_text_and_graphics()
                        .unwrap_or(false)
                    {
                        return Err(PreviewError::UnsupportedText);
                    }
                    let page = document
                        .pages()
                        .get(page)
                        .map_err(|_| PreviewError::InvalidPage)?;
                    let object = page
                        .objects()
                        .get(object)
                        .map_err(|_| PreviewError::StaleObject)?;
                    let text = object
                        .as_text_object()
                        .ok_or(PreviewError::UnsupportedText)?;
                    let extracted;
                    let needed = if let Some(value) = value.as_deref() {
                        value
                    } else {
                        extracted = page
                            .text()
                            .map_err(|_| PreviewError::UnsupportedText)?
                            .for_object(text);
                        extracted.trim_end()
                    };
                    let key = (revision, text.font().token());
                    if let Some(bytes) = cache.fonts.get(&key) {
                        if crate::fonts::validate_original(bytes, needed).is_ok() {
                            return Ok(bytes.clone());
                        }
                    }
                    let data = crate::fonts::preserved_bytes(document, &text.font(), needed)?;
                    cache.fonts.insert(key, data.clone());
                    Ok(data)
                })();
                let _ = reply.send(result);
            }
            Request::Edit {
                id,
                revision,
                action,
                reply,
            } => {
                let result = (|| {
                    let pdfium = pdfium
                        .as_ref()
                        .map_err(|_| PreviewError::LibraryUnavailable)?;
                    let (_, document) = current
                        .as_mut()
                        .filter(|(active, _)| *active == id)
                        .ok_or(PreviewError::StaleObject)?;
                    let state = history.apply(
                        pdfium,
                        document,
                        revision,
                        action,
                        &font_directory,
                        &ensemble,
                    )?;
                    watermark_pages = history.watermark_pages();
                    cache = Default::default();
                    Ok(state)
                })();
                let _ = reply.send(result);
            }
            Request::Release(id) => {
                if current.as_ref().is_some_and(|(active, _)| *active == id) {
                    current = None;
                    history = History::default();
                }
            }
            Request::Render {
                id,
                path,
                page,
                width,
                include_text,
                progress,
                reply,
            } => {
                let result = (|| {
                    if let Some(progress) = &progress {
                        progress(15);
                    }
                    let pdfium = pdfium
                        .as_ref()
                        .map_err(|_| PreviewError::LibraryUnavailable)?;
                    if current.as_ref().is_none_or(|(active, _)| *active != id) {
                        let file = File::open(path).map_err(|_| PreviewError::ReadFailed)?;
                        if file.metadata().map_err(|_| PreviewError::ReadFailed)?.len()
                            > MAX_FILE_BYTES
                        {
                            return Err(PreviewError::TooLarge);
                        }
                        let mut bytes = Vec::new();
                        file.take(MAX_FILE_BYTES + 1)
                            .read_to_end(&mut bytes)
                            .map_err(|_| PreviewError::ReadFailed)?;
                        if bytes.len() as u64 > MAX_FILE_BYTES {
                            return Err(PreviewError::TooLarge);
                        }
                        watermark_pages = crate::content_stream::watermarks::pages(&bytes);
                        let (document, was_recovered) = ensemble.open(pdfium, bytes)?;
                        recovered = was_recovered;
                        if document.pages().is_empty() {
                            return Err(PreviewError::InvalidDocument);
                        }
                        current = Some((id, document));
                        history = History::default();
                        cache = Default::default();
                    }
                    let mut rendered = {
                        if let Some(progress) = &progress {
                            progress(40);
                        }
                        render_page(&current.as_ref().unwrap().1, page, width, include_text)?
                    };
                    if let Some(progress) = &progress {
                        progress(85);
                    }
                    rendered.state = history.state.clone();
                    rendered.recovered = recovered;
                    if include_text {
                        rendered.text.watermark_pages = watermark_pages.clone();
                        if watermark_pages.contains(&page) {
                            rendered.text.watermark_settings =
                                history.watermark_settings(&current.as_ref().unwrap().1, page);
                            rendered.text.watermark_objects =
                                history.watermark_objects(&current.as_ref().unwrap().1, page)?;
                        }
                    }
                    Ok(rendered)
                })();
                let _ = reply.send(result);
            }
        }
        if current.is_some() {
            caches.insert(session_id.clone(), cache);
            documents.insert(session_id, (current, history, watermark_pages, recovered));
        }
    }
}
