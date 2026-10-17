//! Routes a mutation to its implementation and returns verified candidate bytes.
use super::{
    action::EditAction,
    replace::{replace, replace_group},
};
use crate::error::EngineError as PreviewError;
use pdfium_render::prelude::*;
use std::path::Path;
pub(super) fn apply(
    pdfium: &Pdfium,
    original: &[u8],
    action: EditAction,
    font_directory: &Path,
) -> Result<Vec<u8>, PreviewError> {
    Ok(match action {
        EditAction::Page {
            page,
            operation,
            destination,
        } => crate::pages::edit(pdfium, original, page, operation, destination)?,
        EditAction::TransformGraphic {
            page,
            object,
            matrix,
        } => crate::graphics::edit(pdfium, original, page, object, Some(matrix))?,
        EditAction::DeleteGraphic { page, object } => {
            crate::graphics::edit(pdfium, original, page, object, None)?
        }
        EditAction::AlignBlock {
            page,
            groups,
            text,
            alignment,
            width,
            height,
            font,
        } => crate::flow::replace_with_fonts(
            pdfium,
            original,
            page,
            &groups,
            text.as_deref(),
            width,
            height,
            font_directory,
            font.as_deref(),
            &std::collections::HashMap::new(),
            Some(alignment),
        )?,
        EditAction::FlexibleEdit {
            page,
            groups,
            object,
            text,
            fonts,
            width,
            height,
        } => {
            if let Some(object) = object {
                if !groups.is_empty() || fonts.len() != 1 || !fonts.contains_key(&object) {
                    return Err(PreviewError::UnsupportedText);
                }
                replace(
                    pdfium,
                    original,
                    page,
                    object,
                    Some(&text),
                    Some((font_directory, &fonts[&object])),
                )?
            } else {
                crate::flow::replace_with_fonts(
                    pdfium,
                    original,
                    page,
                    &groups,
                    Some(&text),
                    width,
                    height,
                    font_directory,
                    None,
                    &fonts,
                    None,
                )?
            }
        }
        EditAction::FlowBlocks {
            page,
            groups,
            text,
            width,
            height,
        } => crate::flow::replace(
            pdfium,
            original,
            page,
            &groups,
            Some(&text),
            width,
            height,
            font_directory,
            None,
        )?,
        EditAction::FlowBlock {
            page,
            group,
            text,
            width,
            height,
        } => crate::flow::replace(
            pdfium,
            original,
            page,
            &[group],
            Some(&text),
            width,
            height,
            font_directory,
            None,
        )?,
        EditAction::EditWithFallback {
            page,
            group: Some(group),
            object: None,
            text,
        } => crate::block::replace(
            pdfium,
            original,
            page,
            group,
            Some(&text),
            Some((font_directory, "pretendard")),
        )?,
        EditAction::EditWithFallback {
            page,
            group: None,
            object: Some(object),
            text,
        } => replace(
            pdfium,
            original,
            page,
            object,
            Some(&text),
            Some((font_directory, "pretendard")),
        )?,
        EditAction::EditWithFallback { .. } => return Err(PreviewError::UnsupportedText),
        EditAction::Move {
            page,
            group,
            object,
            dx,
            dy,
        } => crate::movement::translate(pdfium, original, page, group, object, dx, dy)?,
        EditAction::ReflowBlock { page, group, text } => {
            crate::block::replace(pdfium, original, page, group, Some(&text), None)?
        }
        EditAction::ChangeBlockFont {
            page,
            group,
            font,
            text,
            width,
            height,
        } => crate::flow::replace(
            pdfium,
            original,
            page,
            &[group],
            text.as_deref(),
            width,
            height,
            font_directory,
            Some(&font),
        )?,
        EditAction::ReplaceGroup { page, group, text } => {
            replace_group(pdfium, original, page, group, &text)?
        }
        EditAction::Replace { page, object, text } => {
            replace(pdfium, original, page, object, Some(&text), None)?
        }
        EditAction::ChangeFont { page, object, font } => replace(
            pdfium,
            original,
            page,
            object,
            None,
            Some((font_directory, &font)),
        )?,
        EditAction::Undo | EditAction::Redo | EditAction::Save { .. } => {
            return Err(PreviewError::UnsupportedText)
        }
    })
}
