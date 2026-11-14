//! Source-encoded edits that preserve all other drawing and text instructions.
//! Unsupported or ambiguous mappings fall back to the regular reflow path.
use crate::text::TextObject;
use lopdf::{content::Content, Dictionary, Document, Object, Stream};

pub(crate) fn patch(
    original: &[u8],
    index: i32,
    objects: &[TextObject],
    target: usize,
    value: &str,
) -> Option<Vec<u8>> {
    let mut doc = Document::load_mem(original).ok()?;
    let page = *doc.get_pages().get(&(index as u32 + 1))?;
    let fonts = doc.get_page_fonts(page).ok()?;
    let bytes = doc
        .get_page_content_with_limit(page, 64 * 1024 * 1024)
        .ok()?;
    let mut content = Content::decode_strict(&bytes).ok()?;
    let spans = super::spans::operations(&bytes, &content.operations).ok()?;
    let mut font = Vec::new();
    let mut stack = Vec::new();
    let mut ordinal = 0;
    let mut changed = false;
    let mut replacement = None;
    for (operation_index, op) in content.operations.iter_mut().enumerate() {
        match op.operator.as_str() {
            "q" => stack.push(font.clone()),
            "Q" => font = stack.pop()?,
            "Tf" => font = op.operands.first()?.as_name().ok()?.to_vec(),
            _ => (),
        }
        let parts: Vec<&mut Object> = match op.operator.as_str() {
            "Tj" | "'" | "\"" => vec![op.operands.last_mut()?],
            "TJ" => op
                .operands
                .first_mut()?
                .as_array_mut()
                .ok()?
                .iter_mut()
                .filter(|o| matches!(o, Object::String(_, _)))
                .collect(),
            _ => continue,
        };
        if !parts
            .iter()
            .any(|p| p.as_str().is_ok_and(|s| !s.is_empty()))
        {
            continue;
        }
        let source = objects.get(ordinal)?;
        ordinal += 1;
        let encoding = fonts
            .get(&font)?
            .get_font_encoding_with_limit(&doc, 4 * 1024 * 1024)
            .ok()?;
        let decoded: Vec<String> = parts
            .iter()
            .map(|p| encoding.bytes_to_string(p.as_str().ok()?).ok())
            .collect::<Option<_>>()?;
        if decoded.concat() != source.text {
            return None;
        }
        if source.id != target {
            continue;
        }
        let same_length = value.chars().count() == source.text.chars().count();
        // A single source string can grow without redistributing TJ kerning across
        // string fragments. The caller verifies advance, bounds and other objects.
        if changed || (!same_length && parts.len() != 1) {
            return None;
        }
        let mut chars = value.chars();
        for (part, old) in parts.into_iter().zip(decoded) {
            let next: String = if same_length {
                chars.by_ref().take(old.chars().count()).collect()
            } else {
                value.to_owned()
            };
            if next == old {
                continue;
            }
            // Do not silently re-encode unchanged characters to a different
            // source code when a font has aliases or ligature mappings.
            if encoding.string_to_bytes(&old) != part.as_str().ok()? {
                return None;
            }
            let encoded = encoding.string_to_bytes(&next);
            if encoding.bytes_to_string(&encoded).ok()? != next {
                return None;
            }
            let Object::String(bytes, _) = part else {
                return None;
            };
            *bytes = encoded;
        }
        let operation = lopdf::content::Content {
            operations: vec![op.clone()],
        }
        .encode()
        .ok()?;
        changed = true;
        replacement = Some((spans[operation_index].clone(), operation));
    }
    if !changed || ordinal != objects.len() || !stack.is_empty() {
        return None;
    }
    drop(fonts);
    let (range, operation) = replacement?;
    let mut output = bytes[..range.start].to_vec();
    output.push(b'\n');
    output.extend_from_slice(&operation);
    output.extend_from_slice(&bytes[range.end..]);
    // New private Contents leaves shared streams, font resources and other pages intact.
    let stream = doc.add_object(Stream::new(Dictionary::new(), output));
    doc.get_object_mut(page)
        .ok()?
        .as_dict_mut()
        .ok()?
        .set("Contents", stream);
    let mut result = Vec::new();
    doc.save_to(&mut result).ok()?;
    Some(result)
}
