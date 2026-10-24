//! Private messages: native handles must never cross this boundary.
use super::RenderedPage;
use crate::{
    editing::{EditAction, EditState},
    engine::error::EngineError as PreviewError,
};
use std::{path::PathBuf, sync::mpsc::SyncSender};
pub(super) enum Request {
    CopyGraphic {
        id: String,
        revision: u64,
        page: i32,
        object: usize,
        reply: SyncSender<Result<Vec<u8>, PreviewError>>,
    },
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
        include_text: bool,
        progress: Option<Box<dyn Fn(u8) + Send>>,
        reply: SyncSender<Result<RenderedPage, PreviewError>>,
    },
    Release(String),
}
