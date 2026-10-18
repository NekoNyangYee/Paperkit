//! Blocking API for backend tasks; no native handles are exposed.
use super::{protocol::Request, RenderedPage};
use crate::{
    editing::{EditAction, EditState},
    error::EngineError as PreviewError,
};
use std::{
    path::PathBuf,
    sync::mpsc::{self, SyncSender},
};
/// Only messages cross thread boundaries; PDFium and documents stay on the worker.
#[derive(Clone)]
pub struct Paperframe {
    sender: SyncSender<Request>,
}

impl Paperframe {
    pub fn copy_graphic(
        &self,
        id: String,
        revision: u64,
        page: i32,
        object: usize,
    ) -> Result<Vec<u8>, PreviewError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Request::CopyGraphic {
                id,
                revision,
                page,
                object,
                reply,
            })
            .map_err(|_| PreviewError::WorkerStopped)?;
        receiver.recv().map_err(|_| PreviewError::WorkerStopped)?
    }
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
            .name("paperframe-pdfium".into())
            .spawn(move || super::worker::run(library, font_directory, receiver))
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
        self.render_with_progress(id, path, page, width, None)
    }

    pub fn render_with_progress(
        &self,
        id: String,
        path: PathBuf,
        page: i32,
        width: i32,
        progress: Option<Box<dyn Fn(u8) + Send>>,
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
                progress,
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

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn render_font_and_edit_wait_for_queue_capacity() {
        for kind in 0..3 {
            let (sender, receiver) = mpsc::sync_channel(1);
            sender.send(Request::Release("occupied".into())).unwrap();
            let engine = Paperframe { sender };
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
        let engine = Paperframe { sender };
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
