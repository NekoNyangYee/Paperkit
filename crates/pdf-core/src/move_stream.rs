//! Move text painting instructions while retaining original glyph codes and spacing.
use crate::{error::EngineError as PreviewError, text::TextObject};
use lopdf::{
    content::{Content, Operation},
    Dictionary, Document, Object, Stream,
};
use std::collections::BTreeSet;

pub(crate) fn multiply(a: [f32; 6], b: [f32; 6]) -> [f32; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}
pub(crate) fn inverse(m: [f32; 6]) -> Result<[f32; 6], PreviewError> {
    let det = m[0] * m[3] - m[1] * m[2];
    if !det.is_finite() || det.abs() < 1e-8 {
        return Err(PreviewError::UnsupportedText);
    }
    Ok([
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ])
}
pub(crate) fn transform(
    original: &[u8],
    page_index: i32,
    objects: &[TextObject],
    ids: &BTreeSet<usize>,
    matrix: [f32; 6],
) -> Result<Vec<u8>, PreviewError> {
    let mut doc = Document::load_mem(original).map_err(|_| PreviewError::EditFailed)?;
    let page_id = *doc
        .get_pages()
        .get(&(page_index as u32 + 1))
        .ok_or(PreviewError::InvalidPage)?;
    let bytes = doc
        .get_page_content_with_limit(page_id, 64 * 1024 * 1024)
        .map_err(|_| PreviewError::UnsupportedText)?;
    let content = Content::decode_strict(&bytes).map_err(|_| PreviewError::UnsupportedText)?;
    let shows_text = |op: &Operation| {
        let nonempty = |o: &Object| matches!(o, Object::String(s, _) if !s.is_empty());
        match op.operator.as_str() {
            "Tj" | "'" | "\"" => op.operands.last().is_some_and(nonempty),
            "TJ" => op
                .operands
                .first()
                .and_then(|o| o.as_array().ok())
                .is_some_and(|a| a.iter().any(nonempty)),
            _ => false,
        }
    };
    // Never guess a mapping when PDFium split/merged text-show instructions.
    // The caller additionally verifies each reopened object, glyph bounds and pixels.
    if content
        .operations
        .iter()
        .filter(|op| shows_text(op))
        .count()
        != objects.len()
    {
        return Err(PreviewError::UnsupportedText);
    }
    let mut output = Vec::new();
    let mut linear = [1.0f32, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut stack = Vec::new();
    let mut ordinal = 0;
    for op in content.operations {
        match op.operator.as_str() {
            "q" => stack.push(linear),
            "Q" => linear = stack.pop().ok_or(PreviewError::UnsupportedText)?,
            "cm" => {
                if op.operands.len() != 6 {
                    return Err(PreviewError::UnsupportedText);
                }
                let m = op
                    .operands
                    .iter()
                    .map(|v| v.as_float().map_err(|_| PreviewError::UnsupportedText))
                    .collect::<Result<Vec<_>, _>>()?;
                linear = multiply(
                    linear,
                    m.try_into().map_err(|_| PreviewError::UnsupportedText)?,
                );
            }
            _ => (),
        }
        let selected = if shows_text(&op) {
            let selected = ids.contains(&objects[ordinal].id);
            ordinal += 1;
            selected
        } else {
            false
        };
        if selected {
            let local = multiply(multiply(inverse(linear)?, matrix), linear);
            if local.iter().any(|v| !v.is_finite()) {
                return Err(PreviewError::UnsupportedText);
            }
            let operation =
                |m: [f32; 6]| Operation::new("cm", m.into_iter().map(Object::Real).collect());
            output.push(operation(local));
            output.push(op);
            output.push(operation(inverse(local)?));
        } else {
            output.push(op);
        }
    }
    if !stack.is_empty() {
        return Err(PreviewError::UnsupportedText);
    }
    let content = Content { operations: output }
        .encode()
        .map_err(|_| PreviewError::EditFailed)?;
    // Allocate a page-private stream: other pages may share the old Contents.
    let stream = doc.add_object(Stream::new(Dictionary::new(), content));
    doc.get_object_mut(page_id)
        .and_then(Object::as_dict_mut)
        .map_err(|_| PreviewError::EditFailed)?
        .set("Contents", stream);
    let mut result = Vec::new();
    doc.save_to(&mut result)
        .map_err(|_| PreviewError::EditFailed)?;
    // Verify serialized objects structurally. Only the selected page's Contents
    // and its new stream were changed above; other pages need no rasterization.
    let reopened = Document::load_mem(&result).map_err(|_| PreviewError::VerificationFailed)?;
    for (id, object) in &doc.objects {
        if reopened.objects.get(id) != Some(object) {
            return Err(PreviewError::VerificationFailed);
        }
    }
    Ok(result)
}
