//! Restore spacing and the stroke coordinate system lost by PDFium regeneration.
use crate::{engine::error::EngineError as PreviewError, text::TextObject};
use lopdf::{
    content::{Content, Operation},
    Dictionary, Document, Object, Stream,
};
use std::collections::BTreeSet;

fn text_show(op: &Operation) -> bool {
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
}

/// Decode stored text rather than PDFium's layout analysis, which can collapse
/// consecutive spaces. Only accept a flat, one-show-per-object page mapping.
pub(crate) fn stored_text(bytes: &[u8], index: i32, count: usize) -> Option<Vec<String>> {
    let doc = Document::load_mem(bytes).ok()?;
    let page = *doc.get_pages().get(&(index as u32 + 1))?;
    if doc.objects.values().any(|o| {
        o.as_stream()
            .ok()
            .is_some_and(|s| s.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Form"))
    }) {
        return None;
    }
    let fonts = doc.get_page_fonts(page).ok()?;
    let data = doc
        .get_page_content_with_limit(page, 64 * 1024 * 1024)
        .ok()?;
    let content = Content::decode_strict(&data).ok()?;
    let mut font = Vec::new();
    let mut stack = Vec::new();
    let mut values = Vec::new();
    let mut encodings = std::collections::BTreeMap::new();
    for op in content.operations {
        match op.operator.as_str() {
            "q" => stack.push(font.clone()),
            "Q" => font = stack.pop()?,
            "Tf" => font = op.operands.first()?.as_name().ok()?.to_vec(),

            _ => (),
        }
        if text_show(&op) {
            if !encodings.contains_key(&font) {
                let encoding = fonts
                    .get(&font)?
                    .get_font_encoding_with_limit(&doc, 4 * 1024 * 1024)
                    .ok()?;
                encodings.insert(font.clone(), encoding);
            }
            let encoding = encodings.get(&font)?;
            let mut value = String::new();
            if op.operator == "TJ" {
                for item in op.operands.first()?.as_array().ok()? {
                    if let Object::String(data, _) = item {
                        value.push_str(&encoding.bytes_to_string(data).ok()?);
                    }
                }
            } else {
                value = encoding
                    .bytes_to_string(op.operands.last()?.as_str().ok()?)
                    .ok()?;
            }
            values.push(value);
        }
    }
    (values.len() == count).then_some(values)
}
#[derive(Clone, Copy)]
struct State {
    spacing: [f32; 2],
    ctm: [f32; 6],
    tm: [f32; 6],
    line: [f32; 6],
    leading: f32,
    horizontal: f32,
    rise: f32,
    width: f32,
    mode: i32,
}
impl State {
    fn stroked(&self) -> bool {
        matches!(self.mode, 1 | 2 | 5 | 6)
    }
}
fn spacing(operations: &[Operation]) -> Result<Vec<State>, PreviewError> {
    let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut state = State {
        spacing: [0.0, 0.0],
        ctm: identity,
        tm: identity,
        line: identity,
        leading: 0.0,
        horizontal: 100.0,
        rise: 0.0,
        width: 1.0,
        mode: 0,
    };
    let mut stack = Vec::new();
    let mut values = Vec::new();
    let mut positioned = false;
    for op in operations {
        let number = |i: usize| {
            op.operands
                .get(i)
                .and_then(|v| v.as_float().ok())
                .filter(|v| v.is_finite())
                .ok_or(PreviewError::VerificationFailed)
        };
        match op.operator.as_str() {
            "q" => stack.push(state),
            "Q" => state = stack.pop().ok_or(PreviewError::VerificationFailed)?,
            "BT" => {
                state.tm = identity;
                state.line = identity;
                positioned = true;
            }
            "cm" => {
                let mut m = identity;
                for (i, v) in m.iter_mut().enumerate() {
                    *v = number(i)?;
                }
                state.ctm = crate::content_stream::movement::multiply(state.ctm, m);
            }
            "Tm" => {
                for (i, v) in state.tm.iter_mut().enumerate() {
                    *v = number(i)?;
                }
                positioned = true;
                state.line = state.tm;
            }
            "Td" | "TD" => {
                let x = number(0)?;
                let y = number(1)?;
                if op.operator == "TD" {
                    state.leading = -y;
                }
                state.line = crate::content_stream::movement::multiply(
                    state.line,
                    [1.0, 0.0, 0.0, 1.0, x, y],
                );
                state.tm = state.line;
                positioned = true;
            }
            "T*" | "'" | "\"" => {
                state.line = crate::content_stream::movement::multiply(
                    state.line,
                    [1.0, 0.0, 0.0, 1.0, 0.0, -state.leading],
                );
                state.tm = state.line;
                positioned = true;
                if op.operator == "\"" {
                    state.spacing = [number(1)?, number(0)?];
                }
            }
            "TL" => state.leading = number(0)?,
            "Tz" => state.horizontal = number(0)?,
            "Ts" => state.rise = number(0)?,
            "Tr" => state.mode = number(0)? as i32,
            "w" => state.width = number(0)?,
            "Tc" => state.spacing[0] = number(0)?,
            "Tw" => state.spacing[1] = number(0)?,
            _ => (),
        }
        if text_show(op) {
            if state.stroked() && !positioned {
                return Err(PreviewError::VerificationFailed);
            }
            values.push(state);
            positioned = false;
        }
    }
    Ok(values)
}

pub(crate) fn preserve(
    pdfium: &pdfium_render::prelude::Pdfium,
    original: &[u8],
    edited: Vec<u8>,
    index: i32,
    objects: &[TextObject],
    removed: &BTreeSet<usize>,
    inserted: usize,
) -> Result<Vec<u8>, PreviewError> {
    let old = Document::load_mem(original).map_err(|_| PreviewError::VerificationFailed)?;
    let page_number = index as u32 + 1;
    let old_page = *old
        .get_pages()
        .get(&page_number)
        .ok_or(PreviewError::InvalidPage)?;
    let decode = |doc: &Document, page| {
        let bytes = doc
            .get_page_content_with_limit(page, 64 * 1024 * 1024)
            .map_err(|_| PreviewError::VerificationFailed)?;
        Content::decode_strict(&bytes).map_err(|_| PreviewError::VerificationFailed)
    };
    let source = spacing(&decode(&old, old_page)?.operations)?;
    if source
        .iter()
        .all(|s| s.spacing == [0.0, 0.0] && !s.stroked())
    {
        return Ok(edited);
    }
    if source.len() != objects.len() {
        return Err(PreviewError::VerificationFailed);
    }
    let snapshot = pdfium
        .load_pdf_from_byte_vec(edited.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let page = snapshot
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let config = pdfium_render::prelude::PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let candidates = crate::text::extract_for_verification(&snapshot, &page, &config).objects;
    if candidates.len() != objects.len() - removed.len() + inserted {
        return Err(PreviewError::VerificationFailed);
    }
    let mut expected = vec![None; candidates.len()];
    for (o, mut s) in objects
        .iter()
        .zip(source)
        .filter(|(o, _)| !removed.contains(&o.id))
    {
        let matches: Vec<_> = candidates
            .iter()
            .enumerate()
            .filter(|(_, n)| {
                n.text.trim_end() == o.text.trim_end()
                    && n.font == o.font
                    && n.color == o.color
                    && (n.font_size - o.font_size).abs() < 0.001
                    && n.matrix
                        .iter()
                        .zip(o.matrix)
                        .all(|(a, b)| (*a - b).abs() < 0.001)
            })
            .map(|(i, _)| i)
            .collect();
        if matches.len() != 1 || expected[matches[0]].is_some() {
            return Err(PreviewError::VerificationFailed);
        }
        if s.stroked() {
            let original = crate::content_stream::movement::multiply(
                s.ctm,
                crate::content_stream::movement::multiply(
                    s.tm,
                    [s.horizontal / 100.0, 0.0, 0.0, 1.0, 0.0, s.rise],
                ),
            );
            let inverse = crate::content_stream::movement::inverse(s.ctm)?;
            let dx = o.matrix[4] - original[4];
            let dy = o.matrix[5] - original[5];
            s.tm[4] += inverse[0] * dx + inverse[2] * dy;
            s.tm[5] += inverse[1] * dx + inverse[3] * dy;
        }
        expected[matches[0]] = Some(s);
    }
    let mut doc = Document::load_mem(&edited).map_err(|_| PreviewError::VerificationFailed)?;
    let page = *doc
        .get_pages()
        .get(&page_number)
        .ok_or(PreviewError::InvalidPage)?;
    let content = decode(&doc, page)?;
    let current = spacing(&content.operations)?;
    if current.len() != expected.len() {
        return Err(PreviewError::VerificationFailed);
    }
    let mut output = Vec::new();
    let mut ordinal = 0;
    let mut shows_in_text_object = 0;
    let mut restored_stroke = false;
    for op in content.operations {
        if op.operator == "BT" {
            shows_in_text_object = 0;
            restored_stroke = false;
        }
        if text_show(&op) {
            if restored_stroke {
                return Err(PreviewError::VerificationFailed);
            }
            let previous = current[ordinal];
            let target = expected[ordinal].unwrap_or(previous);
            ordinal += 1;
            shows_in_text_object += 1;
            if target.stroked() {
                restored_stroke = true;
                if shows_in_text_object != 1 || !matches!(op.operator.as_str(), "Tj" | "TJ") {
                    return Err(PreviewError::VerificationFailed);
                }
                // A text matrix scales glyph outlines, but not their stroke
                // width. Keep the original graphics CTM for stroked headings;
                // copying only the raw pen width makes them many times thicker.
                let local = crate::content_stream::movement::multiply(
                    crate::content_stream::movement::inverse(previous.ctm)?,
                    target.ctm,
                );
                output.push(Operation::new("q", vec![]));
                output.push(Operation::new(
                    "cm",
                    local.into_iter().map(Object::Real).collect(),
                ));
                output.push(Operation::new(
                    "Tm",
                    target.tm.into_iter().map(Object::Real).collect(),
                ));
                output.push(Operation::new("w", vec![target.width.into()]));
                output.push(Operation::new("Tz", vec![target.horizontal.into()]));
                output.push(Operation::new("Ts", vec![target.rise.into()]));
                output.push(Operation::new("Tc", vec![target.spacing[0].into()]));
                output.push(Operation::new("Tw", vec![target.spacing[1].into()]));
                output.push(op);
                output.push(Operation::new("Q", vec![]));
                continue;
            }
            if target.spacing != previous.spacing {
                if !matches!(op.operator.as_str(), "Tj" | "TJ") {
                    return Err(PreviewError::VerificationFailed);
                }
                output.push(Operation::new("Tc", vec![target.spacing[0].into()]));
                output.push(Operation::new("Tw", vec![target.spacing[1].into()]));
                output.push(op);
                output.push(Operation::new("Tc", vec![previous.spacing[0].into()]));
                output.push(Operation::new("Tw", vec![previous.spacing[1].into()]));
                continue;
            }
        }
        output.push(op);
    }
    let bytes = Content { operations: output }
        .encode()
        .map_err(|_| PreviewError::VerificationFailed)?;
    let stream = doc.add_object(Stream::new(Dictionary::new(), bytes));
    doc.get_object_mut(page)
        .and_then(Object::as_dict_mut)
        .map_err(|_| PreviewError::VerificationFailed)?
        .set("Contents", stream);
    let mut result = Vec::new();
    doc.save_to(&mut result)
        .map_err(|_| PreviewError::VerificationFailed)?;
    Ok(result)
}
