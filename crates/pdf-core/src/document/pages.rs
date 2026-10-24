//! Transactional page operations. Existing pages are never rebuilt as images.
use crate::engine::error::EngineError as PreviewError;
use lopdf::{Document, Object};
use pdfium_render::prelude::*;
use serde::Deserialize;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PageOperation {
    Move,
    Duplicate,
    Rotate,
    Delete,
}

pub(crate) fn edit(
    pdfium: &Pdfium,
    bytes: &[u8],
    page: i32,
    operation: PageOperation,
    destination: Option<i32>,
) -> Result<Vec<u8>, PreviewError> {
    let source = pdfium
        .load_pdf_from_byte_vec(bytes.to_vec(), None)
        .map_err(|_| PreviewError::InvalidDocument)?;
    let count = source.pages().len();
    if page < 0 || page >= count {
        return Err(PreviewError::InvalidPage);
    }
    if !source
        .permissions()
        .can_assemble_document()
        .unwrap_or(false)
        || !source.signatures().is_empty()
    {
        return Err(PreviewError::UnsupportedText);
    }
    let mut mapping: Vec<i32> = (0..count).collect();
    let mut candidate = pdfium
        .load_pdf_from_byte_vec(bytes.to_vec(), None)
        .map_err(|_| PreviewError::InvalidDocument)?;
    let output = match operation {
        PageOperation::Move => {
            let target = destination
                .filter(|n| *n >= 0 && *n < count)
                .ok_or(PreviewError::InvalidPage)?;
            let moved = mapping.remove(page as usize);
            mapping.insert(target as usize, moved);
            reorder(bytes, &mapping)?
        }
        PageOperation::Duplicate => {
            candidate
                .pages_mut()
                .copy_page_from_document(&source, page, page + 1)
                .map_err(|_| PreviewError::EditFailed)?;
            mapping.insert(page as usize + 1, page);
            candidate
                .save_to_bytes()
                .map_err(|_| PreviewError::EditFailed)?
        }
        PageOperation::Delete => {
            if count <= 1 {
                return Err(PreviewError::LastPage);
            }
            candidate
                .pages()
                .get(page)
                .map_err(|_| PreviewError::InvalidPage)?
                .delete()
                .map_err(|_| PreviewError::EditFailed)?;
            mapping.remove(page as usize);
            candidate
                .save_to_bytes()
                .map_err(|_| PreviewError::EditFailed)?
        }
        PageOperation::Rotate => {
            let mut target = candidate
                .pages()
                .get(page)
                .map_err(|_| PreviewError::InvalidPage)?;
            let rotation = next_rotation(target.rotation().map_err(|_| PreviewError::EditFailed)?);
            target.set_rotation(rotation);
            drop(target);
            candidate
                .save_to_bytes()
                .map_err(|_| PreviewError::EditFailed)?
        }
    };
    let reopened = pdfium
        .load_pdf_from_byte_vec(output.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if reopened.pages().len() as usize != mapping.len() {
        return Err(PreviewError::VerificationFailed);
    }
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let structural = Document::load_mem(bytes)
        .ok()
        .zip(Document::load_mem(&output).ok());
    for (index, original) in mapping.into_iter().enumerate() {
        // Exact page attributes and referenced object bytes prove unchanged rendering.
        // Rewritten IDs or any uncertainty fall back to the existing pixel comparison.
        if !(matches!(operation, PageOperation::Rotate) && original == page)
            && structural.as_ref().is_some_and(|(before, after)| {
                unchanged_page(before, after, original as u32 + 1, index as u32 + 1)
            })
        {
            continue;
        }
        let mut before = source
            .pages()
            .get(original)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if matches!(operation, PageOperation::Rotate) && original == page {
            before.set_rotation(next_rotation(
                before
                    .rotation()
                    .map_err(|_| PreviewError::VerificationFailed)?,
            ));
        }
        let after = reopened
            .pages()
            .get(index as i32)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let a = before
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let b = after
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if a.width() != b.width()
            || a.height() != b.height()
            || a.as_rgba_bytes() != b.as_rgba_bytes()
        {
            return Err(PreviewError::VerificationFailed);
        }
    }
    Ok(output)
}

pub(crate) fn unchanged_page(before: &Document, after: &Document, old: u32, new: u32) -> bool {
    let check = || -> Option<bool> {
        let a = *before.get_pages().get(&old)?;
        let b = *after.get_pages().get(&new)?;
        let mut left = effective_page(before, a)?;
        let mut right = effective_page(after, b)?;
        left.remove(b"Parent");
        right.remove(b"Parent");
        let mut visited = std::collections::BTreeSet::new();
        Some(same_object_graph(
            before,
            after,
            &Object::Dictionary(left),
            &Object::Dictionary(right),
            &mut visited,
            0,
        ))
    };
    check().unwrap_or(false)
}

fn effective_page(doc: &Document, id: lopdf::ObjectId) -> Option<lopdf::Dictionary> {
    let mut page = doc.get_dictionary(id).ok()?.clone();
    let mut parent = page.get(b"Parent").ok().and_then(|v| v.as_reference().ok());
    let mut visited = std::collections::BTreeSet::new();
    while let Some(id) = parent {
        if !visited.insert(id) {
            return None;
        }
        let ancestor = doc.get_dictionary(id).ok()?;
        for key in [b"Resources".as_slice(), b"MediaBox", b"CropBox", b"Rotate"] {
            if !page.has(key) {
                if let Ok(value) = ancestor.get(key) {
                    page.set(key, value.clone());
                }
            }
        }
        parent = ancestor
            .get(b"Parent")
            .ok()
            .and_then(|v| v.as_reference().ok());
    }
    Some(page)
}

fn same_object_graph(
    before: &Document,
    after: &Document,
    a: &Object,
    b: &Object,
    visited: &mut std::collections::BTreeSet<lopdf::ObjectId>,
    depth: usize,
) -> bool {
    if depth > 64 {
        return false;
    }
    match (a, b) {
        (Object::Reference(id), Object::Reference(other)) if id == other => {
            if !visited.insert(*id) {
                return true;
            }
            match (before.get_object(*id), after.get_object(*id)) {
                (Ok(left), Ok(right)) => {
                    same_object_graph(before, after, left, right, visited, depth + 1)
                }
                _ => false,
            }
        }
        (Object::Array(left), Object::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(a, b)| same_object_graph(before, after, a, b, visited, depth + 1))
        }
        (Object::Dictionary(left), Object::Dictionary(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, a)| {
                    right
                        .get(key)
                        .is_ok_and(|b| same_object_graph(before, after, a, b, visited, depth + 1))
                })
        }
        (Object::Stream(left), Object::Stream(right)) => {
            left.content == right.content
                && same_object_graph(
                    before,
                    after,
                    &Object::Dictionary(left.dict.clone()),
                    &Object::Dictionary(right.dict.clone()),
                    visited,
                    depth + 1,
                )
        }
        (Object::Null, Object::Null) => true,
        (Object::Boolean(a), Object::Boolean(b)) => a == b,
        (Object::Integer(a), Object::Integer(b)) => a == b,
        (Object::Real(a), Object::Real(b)) => a == b,
        (Object::Name(a), Object::Name(b)) => a == b,
        (Object::String(a, _), Object::String(b, _)) => a == b,
        _ => false,
    }
}

fn next_rotation(rotation: PdfPageRenderRotation) -> PdfPageRenderRotation {
    match rotation {
        PdfPageRenderRotation::None => PdfPageRenderRotation::Degrees90,
        PdfPageRenderRotation::Degrees90 => PdfPageRenderRotation::Degrees180,
        PdfPageRenderRotation::Degrees180 => PdfPageRenderRotation::Degrees270,
        PdfPageRenderRotation::Degrees270 => PdfPageRenderRotation::None,
    }
}

fn reorder(bytes: &[u8], order: &[i32]) -> Result<Vec<u8>, PreviewError> {
    let work = || -> Result<Vec<u8>, lopdf::Error> {
        let mut doc = Document::load_mem(bytes)?;
        let pages: Vec<_> = doc.get_pages().values().copied().collect();
        let root = doc.catalog()?.get(b"Pages")?.as_reference()?;
        // Materialize inherited attributes before flattening the page tree.
        for id in &pages {
            let mut page = doc.get_object(*id)?.as_dict()?.clone();
            let mut parent = page.get(b"Parent")?.as_reference()?;
            let mut visited = std::collections::BTreeSet::new();
            while visited.insert(parent) {
                let ancestor = doc.get_object(parent)?.as_dict()?;
                for key in [b"Resources".as_slice(), b"MediaBox", b"CropBox", b"Rotate"] {
                    if !page.has(key) {
                        if let Ok(value) = ancestor.get(key) {
                            page.set(key, value.clone());
                        }
                    }
                }
                match ancestor.get(b"Parent").and_then(Object::as_reference) {
                    Ok(next) => parent = next,
                    Err(_) => break,
                }
            }
            page.set("Parent", root);
            doc.objects.insert(*id, Object::Dictionary(page));
        }
        let tree = doc.get_object_mut(root)?.as_dict_mut()?;
        tree.set(
            "Kids",
            order
                .iter()
                .map(|i| Object::Reference(pages[*i as usize]))
                .collect::<Vec<_>>(),
        );
        tree.set("Count", pages.len() as i64);
        let mut out = Vec::new();
        doc.save_to(&mut out)?;
        Ok(out)
    };
    work().map_err(|_| PreviewError::EditFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structural_check_follows_resources_and_stream_bytes() {
        let mut before = Document::with_version("1.7");
        let stream = before.add_object(lopdf::Stream::new(
            lopdf::Dictionary::new(),
            b"original".to_vec(),
        ));
        let mut after = before.clone();
        let reference = Object::Reference(stream);
        assert!(same_object_graph(
            &before,
            &after,
            &reference,
            &reference,
            &mut Default::default(),
            0
        ));
        after
            .get_object_mut(stream)
            .unwrap()
            .as_stream_mut()
            .unwrap()
            .content = b"modified".to_vec();
        assert!(!same_object_graph(
            &before,
            &after,
            &reference,
            &reference,
            &mut Default::default(),
            0
        ));
        let left = Object::Array(vec![reference]);
        assert!(!same_object_graph(
            &before,
            &after,
            &left,
            &left,
            &mut Default::default(),
            0
        ));
    }
}
