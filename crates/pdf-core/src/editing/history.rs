//! Atomic commit, revision checks, undo/redo and save state.
use super::action::{EditAction, EditState};
use crate::error::EngineError as PreviewError;
use pdfium_render::prelude::*;
use std::path::Path;
#[derive(Default)]
pub(crate) struct History {
    pub state: EditState,
    bytes: Option<Vec<u8>>,
    saved: Option<Vec<u8>>,
    undo: Vec<Vec<u8>>,
    redo: Vec<Vec<u8>>,
}

impl History {
    pub fn apply<'a>(
        &mut self,
        pdfium: &'a Pdfium,
        document: &mut PdfDocument<'a>,
        revision: u64,
        action: EditAction,
        font_directory: &Path,
    ) -> Result<EditState, PreviewError> {
        if revision != self.state.revision {
            return Err(PreviewError::StaleObject);
        }
        if self.bytes.is_none() {
            let bytes = document
                .save_to_bytes()
                .map_err(|_| PreviewError::EditFailed)?;
            if bytes.len() > 32 * 1024 * 1024 {
                return Err(PreviewError::EditTooLarge);
            }
            self.saved = Some(bytes.clone());
            self.bytes = Some(bytes);
        }
        match action {
            EditAction::Save { path } => {
                crate::save::save_new(pdfium, document, self.bytes.as_ref().unwrap(), &path)?;
                self.saved = self.bytes.clone();
            }
            action @ (EditAction::Page { .. }
            | EditAction::ScaleText { .. }
            | EditAction::PasteGraphic { .. }
            | EditAction::PasteImage { .. }
            | EditAction::TransformGraphic { .. }
            | EditAction::DeleteGraphic { .. }
            | EditAction::AlignBlock { .. }
            | EditAction::Replace { .. }
            | EditAction::FlexibleEdit { .. }
            | EditAction::Move { .. }
            | EditAction::FlowBlock { .. }
            | EditAction::FlowBlocks { .. }
            | EditAction::EditWithFallback { .. }
            | EditAction::ChangeFont { .. }
            | EditAction::ReflowBlock { .. }
            | EditAction::ChangeBlockFont { .. }
            | EditAction::ReplaceGroup { .. }) => {
                let bytes = super::dispatch::apply(
                    pdfium,
                    self.bytes.as_ref().unwrap(),
                    action,
                    font_directory,
                )?;
                if bytes.len() > 32 * 1024 * 1024 {
                    return Err(PreviewError::EditTooLarge);
                }
                let candidate = pdfium
                    .load_pdf_from_byte_vec(bytes.clone(), None)
                    .map_err(|_| PreviewError::EditFailed)?;
                self.undo.push(self.bytes.replace(bytes).unwrap());
                self.redo.clear();
                // Bound snapshot memory and retain the most recent undo steps.
                while self.undo.len() > 20
                    || self.undo.iter().map(Vec::len).sum::<usize>() > 128 * 1024 * 1024
                {
                    self.undo.remove(0);
                }
                *document = candidate;
                self.state.revision += 1;
            }
            EditAction::Undo | EditAction::Redo => {
                let undo = matches!(action, EditAction::Undo);
                let from = if undo { &mut self.undo } else { &mut self.redo };
                let bytes = from.last().ok_or(PreviewError::NoHistory)?;
                let candidate = pdfium
                    .load_pdf_from_byte_vec(bytes.clone(), None)
                    .map_err(|_| PreviewError::EditFailed)?;
                let previous = self.bytes.replace(from.pop().unwrap()).unwrap();
                if undo {
                    self.redo.push(previous);
                } else {
                    self.undo.push(previous);
                }
                *document = candidate;
                self.state.revision += 1;
            }
        }
        self.state.dirty = self.bytes != self.saved;
        self.state.page_count = Some(document.pages().len());
        self.state.can_undo = !self.undo.is_empty();
        self.state.can_redo = !self.redo.is_empty();
        Ok(self.state.clone())
    }
}
