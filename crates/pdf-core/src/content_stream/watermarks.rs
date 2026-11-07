//! A private marked-content tag keeps managed watermarks distinct from other images.
use crate::engine::error::EngineError;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, Stream,
};
pub(crate) const TAG: &[u8] = b"PaperkitWatermark";
const SETTINGS_KEY: &[u8] = b"PaperkitWatermarkSettings";

pub(crate) fn settings(bytes: &[u8], index: i32) -> Option<crate::editing::WatermarkSettings> {
    let doc = Document::load_mem(bytes).ok()?;
    let page = *doc.get_pages().get(&(index as u32 + 1))?;
    let value = doc.get_dictionary(page).ok()?.get(SETTINGS_KEY).ok()?;
    let (_, value) = doc.dereference(value).ok()?;
    let bytes = value.as_str().ok()?;
    if bytes.len() > 7 * 1024 * 1024 {
        return None;
    }
    let settings: crate::editing::WatermarkSettings = serde_json::from_slice(bytes).ok()?;
    settings.valid().then_some(settings)
}

pub(crate) fn write_settings(
    bytes: &[u8],
    index: Option<i32>,
    settings: Option<&crate::editing::WatermarkSettings>,
) -> Result<Vec<u8>, EngineError> {
    let mut doc = Document::load_mem(bytes).map_err(|_| EngineError::EditFailed)?;
    let reference = settings
        .map(|settings| {
            serde_json::to_vec(settings)
                .map(|bytes| {
                    doc.add_object(Object::String(bytes, lopdf::StringFormat::Hexadecimal))
                })
                .map_err(|_| EngineError::EditFailed)
        })
        .transpose()?;
    for (number, page) in doc.get_pages() {
        if index.is_some_and(|index| number as i32 != index + 1) {
            continue;
        }
        let page = doc
            .get_dictionary_mut(page)
            .map_err(|_| EngineError::EditFailed)?;
        if let Some(reference) = reference {
            page.set(SETTINGS_KEY, reference);
        } else {
            page.remove(SETTINGS_KEY);
        }
    }
    let mut output = Vec::new();
    doc.save_to(&mut output)
        .map_err(|_| EngineError::EditFailed)?;
    Ok(output)
}

fn content(doc: &Document, page: lopdf::ObjectId) -> Result<Content<Vec<Operation>>, EngineError> {
    let bytes = doc
        .get_page_content_with_limit(page, 64 * 1024 * 1024)
        .map_err(|_| EngineError::EditFailed)?;
    Content::decode_strict(&bytes).map_err(|_| EngineError::EditFailed)
}
fn marked_draws(ops: &[Operation]) -> Result<Vec<usize>, EngineError> {
    let mut stack = Vec::new();
    let mut result = Vec::new();
    let mut draw = 0;
    for op in ops {
        match op.operator.as_str() {
            "BMC" | "BDC" => {
                stack.push(op.operands.first().and_then(|o| o.as_name().ok()) == Some(TAG))
            }
            "EMC" => {
                stack.pop().ok_or(EngineError::EditFailed)?;
            }
            "Do" | "BI" => {
                if stack.iter().any(|marked| *marked) {
                    result.push(draw);
                }
                draw += 1;
            }
            _ => (),
        }
    }
    if !stack.is_empty() {
        return Err(EngineError::EditFailed);
    }
    Ok(result)
}
pub(crate) fn pages(bytes: &[u8]) -> Vec<i32> {
    let Ok(doc) = Document::load_mem(bytes) else {
        return Vec::new();
    };
    doc.get_pages()
        .into_iter()
        .filter_map(|(index, page)| {
            let content = content(&doc, page).ok()?;
            (!marked_draws(&content.operations).ok()?.is_empty()).then_some(index as i32 - 1)
        })
        .collect()
}
pub(crate) fn draws(bytes: &[u8], index: i32) -> Result<(Vec<usize>, usize), EngineError> {
    let doc = Document::load_mem(bytes).map_err(|_| EngineError::EditFailed)?;
    let page = *doc
        .get_pages()
        .get(&(index as u32 + 1))
        .ok_or(EngineError::InvalidPage)?;
    let content = content(&doc, page)?;
    let count = content
        .operations
        .iter()
        .filter(|op| matches!(op.operator.as_str(), "Do" | "BI"))
        .count();
    Ok((marked_draws(&content.operations)?, count))
}
pub(crate) fn remove(bytes: &[u8], targets: &[i32]) -> Result<Vec<u8>, EngineError> {
    let mut doc = Document::load_mem(bytes).map_err(|_| EngineError::EditFailed)?;
    let pages = doc.get_pages();
    for &index in targets {
        let page = *pages
            .get(&(index as u32 + 1))
            .ok_or(EngineError::InvalidPage)?;
        let mut contents = Vec::new();
        for stream_id in doc.get_page_contents(page) {
            let bytes = doc
                .get_object(stream_id)
                .and_then(Object::as_stream)
                .and_then(|stream| stream.get_plain_content_with_limit(64 * 1024 * 1024))
                .map_err(|_| EngineError::EditFailed)?;
            // Keep original streams byte-for-byte, particularly inline images
            // that lopdf can read but cannot faithfully encode back as operators.
            if !bytes.windows(TAG.len()).any(|part| part == TAG) {
                contents.push(Object::Reference(stream_id));
                continue;
            }
            let mut content =
                Content::decode_strict(&bytes).map_err(|_| EngineError::EditFailed)?;
            let marked = marked_draws(&content.operations)?;
            if marked.is_empty() {
                contents.push(Object::Reference(stream_id));
                continue;
            }
            if content.operations.iter().any(|op| op.operator == "BI") {
                return Err(EngineError::UnsupportedText);
            }
            let mut draw = 0;
            content.operations.retain(|op| {
                if op.operator != "Do" {
                    return true;
                }
                let keep = !marked.contains(&draw);
                draw += 1;
                keep
            });
            let stream = Stream::new(
                dictionary! {},
                content.encode().map_err(|_| EngineError::EditFailed)?,
            );
            contents.push(Object::Reference(doc.add_object(stream)));
        }
        doc.get_object_mut(page)
            .and_then(Object::as_dict_mut)
            .map_err(|_| EngineError::EditFailed)?
            .set("Contents", contents);
        doc.get_dictionary_mut(page)
            .map_err(|_| EngineError::EditFailed)?
            .remove(SETTINGS_KEY);
    }
    let mut output = Vec::new();
    doc.save_to(&mut output)
        .map_err(|_| EngineError::EditFailed)?;
    Ok(output)
}
