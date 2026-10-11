use crate::{
    edit::{EditAction, EditState, History},
    text::{self, PageText},
};
use pdfium_render::prelude::*;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::sync::mpsc::{self, SyncSender};

const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewError {
    LibraryUnavailable,
    WorkerStopped,
    Busy,
    ReadFailed,
    TooLarge,
    PasswordRequired,
    InvalidDocument,
    InvalidPage,
    RenderFailed,
    StaleObject,
    EditFailed,
    EditTooLarge,
    UnsupportedText,
    TextOverflow,
    PageOverflow,
    VerificationFailed,
    UnchangedTextModified,
    NoHistory,
    SaveFailed,
    TargetExists,
    FontUnavailable,
    MissingGlyph,
    LayoutReflowRequired,
}

pub struct RenderedPage {
    pub page_count: i32,
    pub page_index: i32,
    pub width: u32,
    pub height: u32,
    pub png: Vec<u8>,
    pub text: PageText,
    pub state: EditState,
}

enum Request {
    Background {
        foreground: bool,
        id: String,
        revision: u64,
        page: i32,
        width: i32,
        objects: Vec<usize>,
        reply: SyncSender<Result<Vec<u8>, PreviewError>>,
    },
    Font {
        id: String,
        revision: u64,
        page: i32,
        object: usize,
        value: Option<String>,
        reply: SyncSender<Result<Vec<u8>, PreviewError>>,
    },
    Edit {
        id: String,
        revision: u64,
        action: EditAction,
        reply: SyncSender<Result<EditState, PreviewError>>,
    },
    Render {
        id: String,
        path: PathBuf,
        page: i32,
        width: i32,
        reply: SyncSender<Result<RenderedPage, PreviewError>>,
    },
    Release(String),
}

/// Only messages cross thread boundaries; PDFium and documents stay on the worker.
#[derive(Clone)]
pub struct PreviewEngine {
    sender: SyncSender<Request>,
}

impl PreviewEngine {
    pub fn start(library: PathBuf) -> Result<Self, PreviewError> {
        Self::start_with_fonts(library, PathBuf::new())
    }

    pub fn start_with_fonts(
        library: PathBuf,
        font_directory: PathBuf,
    ) -> Result<Self, PreviewError> {
        crate::system_fonts::register_bundled(&font_directory);
        let (sender, receiver) = mpsc::sync_channel(4);
        std::thread::Builder::new()
            .name("paperkit-pdfium".into())
            .spawn(move || {
                let pdfium = Pdfium::bind_to_library(library).map(Pdfium::new);
                // This local lives after Pdfium and drops before it: no self-referential struct.
                let mut current: Option<(String, PdfDocument<'_>)> = None;
                let mut history = History::default();
                while let Ok(request) = receiver.recv() {
                    match request {
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
                                Ok(render_loaded_page(
                                    &candidate, &target, page, width, foreground,
                                )?
                                .png)
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
                                let data = crate::fonts::preserved_bytes(
                                    document,
                                    &text.font(),
                                    value.as_deref().unwrap_or(
                                        &page
                                            .text()
                                            .map_err(|_| PreviewError::UnsupportedText)?
                                            .for_object(text)
                                            .trim_end(),
                                    ),
                                )?;
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
                            reply,
                        } => {
                            let result = (|| {
                                let pdfium = pdfium
                                    .as_ref()
                                    .map_err(|_| PreviewError::LibraryUnavailable)?;
                                if current.as_ref().is_none_or(|(active, _)| *active != id) {
                                    let file =
                                        File::open(path).map_err(|_| PreviewError::ReadFailed)?;
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
                                    let document = pdfium
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
                                let mut rendered =
                                    render_page(&current.as_ref().unwrap().1, page, width)?;
                                rendered.state = history.state.clone();
                                Ok(rendered)
                            })();
                            let _ = reply.send(result);
                        }
                    }
                }
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        Ok(Self { sender })
    }

    /// Blocking API for a backend task, never the UI thread.
    pub fn background(
        &self,
        id: String,
        revision: u64,
        page: i32,
        width: i32,
        objects: Vec<usize>,
    ) -> Result<Vec<u8>, PreviewError> {
        self.layer(id, revision, page, width, objects, false)
    }

    pub fn layer(
        &self,
        id: String,
        revision: u64,
        page: i32,
        width: i32,
        objects: Vec<usize>,
        foreground: bool,
    ) -> Result<Vec<u8>, PreviewError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            // Called from a blocking backend task. Queue pressure is temporary;
            // wait for capacity instead of leaving the editor without its layer.
            .send(Request::Background {
                foreground,
                id,
                revision,
                page,
                width,
                objects,
                reply,
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        receiver.recv().map_err(|_| PreviewError::WorkerStopped)?
    }

    /// Blocking API for a backend task, never the UI thread.
    pub fn font(
        &self,
        id: String,
        revision: u64,
        page: i32,
        object: usize,
    ) -> Result<Vec<u8>, PreviewError> {
        self.font_for_text(id, revision, page, object, None)
    }

    pub fn font_for_text(
        &self,
        id: String,
        revision: u64,
        page: i32,
        object: usize,
        value: Option<String>,
    ) -> Result<Vec<u8>, PreviewError> {
        if value.as_ref().is_some_and(|s| s.len() > 32768) {
            return Err(PreviewError::UnsupportedText);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Font {
                id,
                revision,
                page,
                object,
                value,
                reply,
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        receiver.recv().map_err(|_| PreviewError::WorkerStopped)?
    }

    /// Blocking API for a backend task, never the UI thread.
    pub fn edit(
        &self,
        id: String,
        revision: u64,
        action: EditAction,
    ) -> Result<EditState, PreviewError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Edit {
                id,
                revision,
                action,
                reply,
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        receiver.recv().map_err(|_| PreviewError::WorkerStopped)?
    }

    /// Blocking API for a backend task, never the UI thread.
    pub fn render(
        &self,
        id: String,
        path: PathBuf,
        page: i32,
        width: i32,
    ) -> Result<RenderedPage, PreviewError> {
        if !(300..=1600).contains(&width) {
            return Err(PreviewError::RenderFailed);
        }
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::Render {
                id,
                path,
                page,
                width,
                reply,
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        receiver.recv().map_err(|_| PreviewError::WorkerStopped)?
    }

    /// Blocking control message: don't silently lose a release when render queue is full.
    pub fn release(&self, id: String) -> Result<(), PreviewError> {
        self.sender
            .send(Request::Release(id))
            .map_err(|_| PreviewError::WorkerStopped)
    }
}

fn render_page(
    document: &PdfDocument<'_>,
    index: i32,
    width: i32,
) -> Result<RenderedPage, PreviewError> {
    render_page_layer(document, index, width, false)
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn render_font_and_edit_wait_for_queue_capacity() {
        for kind in 0..3 {
            let (sender, receiver) = mpsc::sync_channel(1);
            sender.send(Request::Release("occupied".into())).unwrap();
            let engine = PreviewEngine { sender };
            let (done, completed) = mpsc::channel();
            let worker = std::thread::spawn(move || {
                let result = match kind {
                    0 => engine
                        .render("document".into(), PathBuf::new(), 0, 800)
                        .map(|_| ()),
                    1 => engine.font("document".into(), 0, 0, 0).map(|_| ()),
                    _ => engine
                        .edit("document".into(), 0, EditAction::Undo)
                        .map(|_| ()),
                };
                done.send(result).unwrap();
            });
            assert_eq!(
                completed.recv_timeout(std::time::Duration::from_millis(100)),
                Err(mpsc::RecvTimeoutError::Timeout)
            );
            assert!(matches!(receiver.recv().unwrap(), Request::Release(_)));
            match receiver
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
            {
                Request::Render { reply, .. } => {
                    reply.send(Err(PreviewError::RenderFailed)).unwrap()
                }
                Request::Font { reply, .. } => reply.send(Err(PreviewError::RenderFailed)).unwrap(),
                Request::Edit { reply, .. } => reply.send(Err(PreviewError::RenderFailed)).unwrap(),
                _ => panic!("unexpected request"),
            }
            assert_eq!(completed.recv().unwrap(), Err(PreviewError::RenderFailed));
            worker.join().unwrap();
        }
    }

    #[test]
    fn editing_layer_waits_for_queue_capacity() {
        let (sender, receiver) = mpsc::sync_channel(1);
        sender.send(Request::Release("occupied".into())).unwrap();
        let engine = PreviewEngine { sender };
        let (done, completed) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            done.send(engine.background("document".into(), 0, 0, 800, vec![0]))
                .unwrap();
        });
        // With the queue full, the request must not immediately return Busy.
        assert_eq!(
            completed.recv_timeout(std::time::Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        );
        assert!(matches!(receiver.recv().unwrap(), Request::Release(_)));
        match receiver
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
        {
            Request::Background { reply, .. } => reply.send(Ok(vec![1, 2, 3])).unwrap(),
            _ => panic!("expected editing background request"),
        }
        assert_eq!(completed.recv().unwrap(), Ok(vec![1, 2, 3]));
        worker.join().unwrap();
    }
}

fn render_page_layer(
    document: &PdfDocument<'_>,
    index: i32,
    width: i32,
    transparent: bool,
) -> Result<RenderedPage, PreviewError> {
    let page_count = document.pages().len();
    if index < 0 || index >= page_count {
        return Err(PreviewError::InvalidPage);
    }
    let page = document
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    render_loaded_page(document, &page, index, width, transparent)
}

fn render_loaded_page(
    document: &PdfDocument<'_>,
    page: &pdfium_render::prelude::PdfPage<'_>,
    index: i32,
    width: i32,
    transparent: bool,
) -> Result<RenderedPage, PreviewError> {
    let page_count = document.pages().len();
    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_maximum_height(2200)
        .render_annotations(!transparent)
        .render_form_data(!transparent)
        .set_clear_color(if transparent {
            PdfColor::new(0, 0, 0, 0)
        } else {
            PdfColor::WHITE
        });
    let bitmap = page
        .render_with_config(&config)
        .map_err(|_| PreviewError::RenderFailed)?;
    let reconstruct_layout = width > 300;
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    let rgba = bitmap.as_rgba_bytes();
    if transparent {
        // Reject an opaque backdrop from a problematic PDF transparency group.
        // Never replace the visible page with such a drag layer.
        let mut area = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
        for object in page.objects().iter() {
            if !object.is_active().map_err(|_| PreviewError::RenderFailed)? {
                continue;
            }
            let q = object.bounds().map_err(|_| PreviewError::RenderFailed)?;
            for (x, y) in [
                (q.x1(), q.y1()),
                (q.x2(), q.y2()),
                (q.x3(), q.y3()),
                (q.x4(), q.y4()),
            ] {
                let (x, y) = page
                    .points_to_pixels(x, y, &config)
                    .map_err(|_| PreviewError::RenderFailed)?;
                area[0] = area[0].min(x.saturating_sub(4));
                area[1] = area[1].min(y.saturating_sub(4));
                area[2] = area[2].max(x.saturating_add(4));
                area[3] = area[3].max(y.saturating_add(4));
            }
        }
        for (i, pixel) in rgba.chunks_exact(4).enumerate() {
            let x = (i % width as usize) as i32;
            let y = (i / width as usize) as i32;
            if pixel[3] > 0 && (x < area[0] || y < area[1] || x > area[2] || y > area[3]) {
                return Err(PreviewError::RenderFailed);
            }
        }
    }
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| PreviewError::RenderFailed)?;
        writer
            .write_image_data(&rgba)
            .map_err(|_| PreviewError::RenderFailed)?;
    }
    Ok(RenderedPage {
        page_count,
        page_index: index,
        width,
        height,
        png,
        text: if !reconstruct_layout || transparent {
            // Thumbnails and transparent drag layers never expose text tools.
            text::PageText::default()
        } else {
            let mut text = text::extract(document, &page, &config);
            if reconstruct_layout {
                crate::layout::reconstruct(&page, &config, &mut text);
            }
            text
        },
        state: EditState::default(),
    })
}
