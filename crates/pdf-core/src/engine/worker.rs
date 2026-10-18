//! Owns the PDFium instance, active document, and transactional history.
use super::{
    protocol::Request,
    raster::{render_loaded_page, render_page},
};
use crate::{editing::History, error::EngineError as PreviewError};
use pdfium_render::prelude::*;
use std::{fs::File, io::Read, path::PathBuf, sync::mpsc::Receiver};
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
pub(super) fn run(library: PathBuf, font_directory: PathBuf, receiver: Receiver<Request>) {
    let pdfium = Pdfium::bind_to_library(library).map(Pdfium::new);
    // This local lives after Pdfium and drops before it: no self-referential struct.
    let mut current: Option<(String, PdfDocument<'_>)> = None;
    let mut history = History::default();
    while let Ok(request) = receiver.recv() {
        match request {
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
                    crate::graphics::copy(pdfium, document, page, object)
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
                    Ok(
                        render_loaded_page(&candidate, &target, page, width, foreground, false)?
                            .png,
                    )
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
                    let data = crate::fonts::preserved_bytes(document, &text.font(), needed)?;
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
                    history.apply(pdfium, document, revision, action, &font_directory)
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
                        let document =
                            pdfium
                                .load_pdf_from_byte_vec(bytes, None)
                                .map_err(|error| {
                                    if matches!(
                                        error,
                                        PdfiumError::PdfiumLibraryInternalError(
                                            PdfiumInternalError::PasswordError
                                        )
                                    ) {
                                        PreviewError::PasswordRequired
                                    } else {
                                        PreviewError::InvalidDocument
                                    }
                                })?;
                        if document.pages().is_empty() {
                            return Err(PreviewError::InvalidDocument);
                        }
                        current = Some((id, document));
                        history = History::default();
                    }
                    let mut rendered = {
                        if let Some(progress) = &progress {
                            progress(40);
                        }
                        render_page(&current.as_ref().unwrap().1, page, width)?
                    };
                    if let Some(progress) = &progress {
                        progress(85);
                    }
                    rendered.state = history.state.clone();
                    Ok(rendered)
                })();
                let _ = reply.send(result);
            }
        }
    }
}
