//! Move text painting instructions while retaining original glyph codes and spacing.
use crate::{render::PreviewError, text::TextObject};
use lopdf::{
    content::{Content, Operation},
    Dictionary, Document, Object, Stream,
};
use std::collections::BTreeSet;

pub(crate) fn translate(
    original: &[u8],
    page_index: i32,
    objects: &[TextObject],
    ids: &BTreeSet<usize>,
    dx: f32,
    dy: f32,
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
    let mut linear = [1.0f32, 0.0, 0.0, 1.0];
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
                let [a, b, c, d] = linear;
                linear = [
                    a * m[0] + c * m[1],
                    b * m[0] + d * m[1],
                    a * m[2] + c * m[3],
                    b * m[2] + d * m[3],
                ];
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
            let [a, b, c, d] = linear;
            let det = a * d - b * c;
            if !det.is_finite() || det.abs() < 1e-8 {
                return Err(PreviewError::UnsupportedText);
            }
            let x = (d * dx - c * dy) / det;
            let y = (a * dy - b * dx) / det;
            if !x.is_finite() || !y.is_finite() {
                return Err(PreviewError::UnsupportedText);
            }
            let translate = |x: f32, y: f32| {
                Operation::new(
                    "cm",
                    vec![1.into(), 0.into(), 0.into(), 1.into(), x.into(), y.into()],
                )
            };
            output.push(translate(x, y));
            output.push(op);
            output.push(translate(-x, -y));
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
