//! Resolve exact original faces and explicitly selected replacements once per face.
//! PDFium writes font resources; the font catalog validates Unicode coverage/embedding.
use crate::{engine::error::EngineError as PreviewError, text::TextObject};
use pdfium_render::prelude::*;
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

fn original_encoding_roundtrips(
    document: &mut PdfDocument<'_>,
    token: PdfFontToken,
    text: &str,
) -> Result<bool, PreviewError> {
    let chars: BTreeSet<char> = text.chars().collect();
    let anchor = chars
        .iter()
        .copied()
        .find(|c| !c.is_whitespace())
        .unwrap_or(' ');
    let probe = format!("{anchor}{}{anchor}", chars.into_iter().collect::<String>());
    let object = PdfPageTextObject::new(document, &probe, token, PdfPoints::new(10.0))
        .map_err(|_| PreviewError::FontUnavailable)?;
    let mut page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::a4())
        .map_err(|_| PreviewError::EditFailed)?;
    let object = page
        .objects_mut()
        .add_text_object(object)
        .map_err(|_| PreviewError::EditFailed)?;
    let matches = object.as_text_object().is_some_and(|o| o.text() == probe);
    drop(object);
    page.delete().map_err(|_| PreviewError::EditFailed)?;
    Ok(matches)
}

pub(super) fn resolve(
    doc: &mut PdfDocument<'_>,
    index: i32,
    sources: &[TextObject],
    new: &[char],
    styles: &[usize],
    value: &str,
    fonts: &Path,
    replacement_font: Option<&str>,
    overrides: &HashMap<usize, String>,
) -> Result<(Vec<PdfFontToken>, Vec<TextObject>, Vec<String>), PreviewError> {
    let page = doc
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let mut tokens = Vec::new();
    let mut expected_styles = sources.to_vec();
    let mut originals = Vec::new();
    let mut original_faces = HashMap::new();
    for source in sources {
        let object = page
            .objects()
            .get(source.id)
            .map_err(|_| PreviewError::StaleObject)?;
        let font = object
            .as_text_object()
            .ok_or(PreviewError::UnsupportedText)?
            .font();
        let token = font.token();
        let original = original_faces.entry(token).or_insert_with(|| {
            let embedded = font.is_embedded().unwrap_or(false);
            let bytes = if embedded && replacement_font.is_none() {
                font.data().ok().map(std::sync::Arc::new)
            } else {
                None
            };
            (token, embedded, bytes)
        });
        originals.push(original.clone());
    }
    let mut needed_by_style = vec![String::new(); sources.len()];
    let mut needed_by_font: HashMap<PdfFontToken, String> = HashMap::new();
    for (&ch, &style) in new.iter().zip(styles).filter(|(ch, _)| **ch != '\n') {
        needed_by_style[style].push(ch);
        if !overrides.contains_key(&sources[style].id) {
            needed_by_font
                .entry(originals[style].0)
                .or_default()
                .push(ch);
        }
    }
    drop(page);
    let replacement = replacement_font
        .map(|name| {
            let bytes = crate::fonts::load(fonts, name, &value.replace('\n', ""))?;
            doc.fonts_mut()
                .load_true_type_from_bytes(&bytes, true)
                .map_err(|_| PreviewError::FontUnavailable)
        })
        .transpose()?;
    let mut recovered_tokens = HashMap::new();
    // A paragraph can contain hundreds of source fragments using the same
    // replacement face. Embed it once, with the union of required characters.
    // Per-fragment embedding made ordinary dialog edits exceed the history cap.
    let mut override_text: HashMap<&str, String> = HashMap::new();
    for (source, needed) in sources.iter().zip(&needed_by_style) {
        if let Some(name) = overrides.get(&source.id) {
            override_text.entry(name).or_default().push_str(needed);
        }
    }
    let mut override_tokens = HashMap::new();
    for (name, needed) in override_text {
        if needed.is_empty() {
            continue;
        }
        let bytes = crate::fonts::load(fonts, name, &needed)?;
        let token = doc
            .fonts_mut()
            .load_true_type_from_bytes(&bytes, true)
            .map_err(|_| PreviewError::FontUnavailable)?;
        override_tokens.insert(name, token);
    }
    for (i, source) in sources.iter().enumerate() {
        let needed = &needed_by_style[i];
        let (token, embedded, bytes) = &originals[i];
        // Removed runs need no font, glyph mapping, or probe object.
        if needed.is_empty() {
            tokens.push(*token);
            continue;
        }
        let face_needed = needed_by_font.get(token).map_or("", String::as_str);
        let usable = if recovered_tokens.contains_key(token) {
            false
        } else if *embedded {
            bytes
                .as_ref()
                .is_some_and(|b| crate::fonts::validate_original(b, &face_needed).is_ok())
        } else {
            crate::text::standard_font(&source.font) && needed.is_ascii()
        };
        if let Some(name) = overrides.get(&source.id) {
            tokens.push(
                *override_tokens
                    .get(name.as_str())
                    .ok_or(PreviewError::FontUnavailable)?,
            );
        } else if let Some(token) = replacement {
            tokens.push(token);
        } else if let Some(recovered) = recovered_tokens.get(token) {
            tokens.push(*recovered);
        } else if usable && *embedded && original_encoding_roundtrips(doc, *token, &face_needed)? {
            recovered_tokens.insert(*token, *token);
            tokens.push(*token);
        } else if usable && *embedded {
            // A Unicode cmap in the font file does not mean the PDF's original
            // encoding can encode new text (even spaces). Load a fresh Unicode
            // font resource while retaining the exact embedded outlines.
            let loaded = doc
                .fonts_mut()
                .load_true_type_from_bytes(bytes.as_ref().unwrap(), true)
                .map_err(|_| PreviewError::FontUnavailable)?;
            recovered_tokens.insert(*token, loaded);
            tokens.push(loaded);
        } else if usable {
            tokens.push(*token);
        } else {
            let bytes = crate::fonts::same_face_in_document(
                &doc,
                &source.font,
                bytes.as_deref().map(Vec::as_slice).filter(|_| *embedded),
                face_needed,
            )?;
            let recovered = doc
                .fonts_mut()
                .load_true_type_from_bytes(&bytes, true)
                .map_err(|_| PreviewError::FontUnavailable)?;
            recovered_tokens.insert(*token, recovered);
            tokens.push(recovered);
        }
        let probe = needed
            .chars()
            .find(|c| !c.is_whitespace())
            .unwrap_or(' ')
            .to_string();
        expected_styles[i].font =
            PdfPageTextObject::new(&doc, probe, tokens[i], PdfPoints::new(source.font_size))
                .map_err(|_| PreviewError::EditFailed)?
                .font()
                .name();
    }
    Ok((tokens, expected_styles, needed_by_style))
}
