use crate::{render::PreviewError, text};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditState {
    pub revision: u64,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditAction {
    TransformGraphic {
        page: i32,
        object: usize,
        matrix: [f32; 6],
    },
    DeleteGraphic {
        page: i32,
        object: usize,
    },
    AlignBlock {
        page: i32,
        groups: Vec<usize>,
        text: Option<String>,
        alignment: crate::alignment::Alignment,
        width: Option<f32>,
        height: Option<f32>,
        font: Option<String>,
    },
    FlexibleEdit {
        page: i32,
        groups: Vec<usize>,
        object: Option<usize>,
        text: String,
        #[serde(deserialize_with = "deserialize_font_overrides")]
        fonts: std::collections::HashMap<usize, String>,
        width: Option<f32>,
        height: Option<f32>,
    },
    FlowBlocks {
        page: i32,
        groups: Vec<usize>,
        text: String,
        width: Option<f32>,
        height: Option<f32>,
    },
    FlowBlock {
        page: i32,
        group: usize,
        text: String,
        width: Option<f32>,
        height: Option<f32>,
    },
    EditWithFallback {
        page: i32,
        group: Option<usize>,
        object: Option<usize>,
        text: String,
    },
    Move {
        page: i32,
        group: Option<usize>,
        object: Option<usize>,
        dx: f32,
        dy: f32,
    },
    ChangeBlockFont {
        page: i32,
        group: usize,
        font: String,
        text: Option<String>,
        width: Option<f32>,
        height: Option<f32>,
    },
    ReflowBlock {
        page: i32,
        group: usize,
        text: String,
    },
    ReplaceGroup {
        page: i32,
        group: usize,
        text: String,
    },
    ChangeFont {
        page: i32,
        object: usize,
        font: String,
    },
    Replace {
        page: i32,
        object: usize,
        text: String,
    },
    Undo,
    Redo,
    Save {
        path: PathBuf,
    },
}

// JSON object keys are strings. Internally tagged enum deserialization buffers
// these keys, so deserialize them explicitly before converting to object IDs.
fn deserialize_font_overrides<'de, D>(
    deserializer: D,
) -> Result<std::collections::HashMap<usize, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let fonts = std::collections::HashMap::<String, String>::deserialize(deserializer)?;
    fonts
        .into_iter()
        .map(|(key, font)| {
            let id = key.parse::<usize>().map_err(serde::de::Error::custom)?;
            if key != id.to_string() {
                return Err(serde::de::Error::custom("invalid font object ID"));
            }
            Ok((id, font))
        })
        .collect()
}

#[cfg(test)]
mod action_tests {
    use super::EditAction;

    #[test]
    fn accepts_json_font_keys_in_tagged_edit_action() {
        let json = r#"{"kind":"flexibleEdit","page":0,"groups":[],"object":258,"text":"수정","fonts":{"258":"pretendard"}}"#;
        let actions = [
            serde_json::from_str::<EditAction>(json).unwrap(),
            serde_json::from_value::<EditAction>(serde_json::from_str(json).unwrap()).unwrap(),
        ];
        for action in actions {
            let EditAction::FlexibleEdit { object, fonts, .. } = action else {
                panic!("wrong action")
            };
            assert_eq!(object, Some(258));
            assert_eq!(fonts.get(&258).map(String::as_str), Some("pretendard"));
        }
    }

    #[test]
    fn rejects_invalid_font_object_ids() {
        for key in [
            "-1",
            "1.5",
            "unknown",
            "0258",
            "+258",
            "184467440737095516160",
        ] {
            let value = serde_json::json!({"kind":"flexibleEdit","page":0,"groups":[1],"text":"text","fonts":{key:"pretendard"}});
            assert!(
                serde_json::from_value::<EditAction>(value).is_err(),
                "{key}"
            );
        }
        let value = serde_json::json!({"kind":"flexibleEdit","page":0,"groups":[1],"text":"text","fonts":{}});
        assert!(serde_json::from_value::<EditAction>(value).is_ok());
    }
}

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
            action @ (EditAction::TransformGraphic { .. }
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
                let bytes = match action {
                    EditAction::TransformGraphic {
                        page,
                        object,
                        matrix,
                    } => crate::graphics::edit(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        object,
                        Some(matrix),
                    )?,
                    EditAction::DeleteGraphic { page, object } => crate::graphics::edit(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        object,
                        None,
                    )?,
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
                        self.bytes.as_ref().unwrap(),
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
                            if !groups.is_empty()
                                || fonts.len() != 1
                                || !fonts.contains_key(&object)
                            {
                                return Err(PreviewError::UnsupportedText);
                            }
                            replace(
                                pdfium,
                                self.bytes.as_ref().unwrap(),
                                page,
                                object,
                                Some(&text),
                                Some((font_directory, &fonts[&object])),
                            )?
                        } else {
                            crate::flow::replace_with_fonts(
                                pdfium,
                                self.bytes.as_ref().unwrap(),
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
                        self.bytes.as_ref().unwrap(),
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
                        self.bytes.as_ref().unwrap(),
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
                        self.bytes.as_ref().unwrap(),
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
                        self.bytes.as_ref().unwrap(),
                        page,
                        object,
                        Some(&text),
                        Some((font_directory, "pretendard")),
                    )?,
                    EditAction::EditWithFallback { .. } => {
                        return Err(PreviewError::UnsupportedText)
                    }
                    EditAction::Move {
                        page,
                        group,
                        object,
                        dx,
                        dy,
                    } => crate::movement::translate(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        group,
                        object,
                        dx,
                        dy,
                    )?,
                    EditAction::ReflowBlock { page, group, text } => crate::block::replace(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        group,
                        Some(&text),
                        None,
                    )?,
                    EditAction::ChangeBlockFont {
                        page,
                        group,
                        font,
                        text,
                        width,
                        height,
                    } => crate::flow::replace(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        &[group],
                        text.as_deref(),
                        width,
                        height,
                        font_directory,
                        Some(&font),
                    )?,
                    EditAction::ReplaceGroup { page, group, text } => {
                        replace_group(pdfium, self.bytes.as_ref().unwrap(), page, group, &text)?
                    }
                    EditAction::Replace { page, object, text } => replace(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        object,
                        Some(&text),
                        None,
                    )?,
                    EditAction::ChangeFont { page, object, font } => replace(
                        pdfium,
                        self.bytes.as_ref().unwrap(),
                        page,
                        object,
                        None,
                        Some((font_directory, &font)),
                    )?,
                    _ => unreachable!(),
                };
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
        self.state.can_undo = !self.undo.is_empty();
        self.state.can_redo = !self.redo.is_empty();
        Ok(self.state.clone())
    }
}

fn replace_group(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    id: usize,
    value: &str,
) -> Result<Vec<u8>, PreviewError> {
    let document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let page = document
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let mut text = crate::text::extract(&document, &page, &config);
    crate::layout::reconstruct(&page, &config, &mut text);
    let group = text
        .groups
        .iter()
        .find(|g| g.id == id)
        .ok_or(PreviewError::StaleObject)?;
    if value.trim().is_empty()
        && group.runs.iter().all(|run| {
            run.object_start == 0
                && text
                    .objects
                    .iter()
                    .find(|o| o.id == run.object)
                    .is_some_and(|o| run.end - run.start >= o.text.trim_end().chars().count())
        })
    {
        let ids = group.runs.iter().map(|run| run.object).collect();
        return crate::flow::delete_text(pdfium, original, index, &ids);
    }
    if group.edit_blocked.is_some() {
        return Err(PreviewError::UnsupportedText);
    }
    if value.len() > 4096 || value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(PreviewError::UnsupportedText);
    }
    let old: Vec<_> = group.text.chars().collect();
    let new: Vec<_> = value.chars().collect();
    let mut changes = std::collections::BTreeMap::<usize, Vec<char>>::new();
    // A complete single source object can retain the existing variable-length edit path.
    if group.runs.len() == 1 {
        let run = &group.runs[0];
        let object = text
            .objects
            .iter()
            .find(|o| o.id == run.object)
            .ok_or(PreviewError::StaleObject)?;
        if run.start == 0
            && run.end == old.len()
            && run.object_start == 0
            && object.text.chars().count() == old.len()
        {
            return replace(pdfium, original, index, object.id, Some(value), None);
        }
    }
    if old.len() != new.len() {
        return Err(PreviewError::LayoutReflowRequired);
    }
    let mut mapped = vec![false; new.len()];
    for run in &group.runs {
        let object = text
            .objects
            .iter()
            .find(|o| o.id == run.object)
            .ok_or(PreviewError::StaleObject)?;
        let chars = changes
            .entry(run.object)
            .or_insert_with(|| object.text.chars().collect());
        for i in run.start..run.end {
            chars[run.object_start + i - run.start] = new[i];
            mapped[i] = true;
        }
    }
    if old
        .iter()
        .zip(&new)
        .enumerate()
        .any(|(i, (a, b))| (!mapped[i] || a.is_whitespace() || b.is_whitespace()) && a != b)
    {
        return Err(PreviewError::LayoutReflowRequired);
    }
    let text_page = page.text().map_err(|_| PreviewError::VerificationFailed)?;
    let mut cells = std::collections::BTreeMap::new();
    for id in changes.keys() {
        let object = page
            .objects()
            .get(*id)
            .map_err(|_| PreviewError::StaleObject)?;
        let object = object.as_text_object().ok_or(PreviewError::StaleObject)?;
        let chars = text_page
            .chars_for_object(object)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let mut cell = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for c in chars.iter() {
            let b = c
                .loose_bounds()
                .map_err(|_| PreviewError::VerificationFailed)?;
            cell = [
                cell[0].min(b.left().value),
                cell[1].min(b.bottom().value),
                cell[2].max(b.right().value),
                cell[3].max(b.top().value),
            ];
        }
        if !cell.iter().all(|v| v.is_finite()) {
            return Err(PreviewError::VerificationFailed);
        }
        cells.insert(*id, cell);
    }
    drop(text_page);
    drop(page);
    drop(document);
    // Each source update is verified on private bytes. Commit only the final result;
    // failure at any point leaves active document, revision and history unchanged.
    let mut bytes = original.to_vec();
    for (object, chars) in changes {
        let value: String = chars.into_iter().collect();
        if text
            .objects
            .iter()
            .any(|o| o.id == object && o.text == value)
        {
            continue;
        }
        bytes = replace_with_bounds(
            pdfium,
            &bytes,
            index,
            object,
            Some(&value),
            None,
            cells.get(&object).copied(),
        )?;
    }
    let verified = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let page = verified
        .pages()
        .get(index)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let mut rebuilt = crate::text::extract(&verified, &page, &config);
    crate::layout::reconstruct(&page, &config, &mut rebuilt);
    if !rebuilt
        .groups
        .iter()
        .any(|g| g.kind == group.kind && g.text == value && g.runs == group.runs)
    {
        return Err(PreviewError::VerificationFailed);
    }
    Ok(bytes)
}

fn replace(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    id: usize,
    value: Option<&str>,
    font: Option<(&Path, &str)>,
) -> Result<Vec<u8>, PreviewError> {
    replace_with_bounds(pdfium, original, index, id, value, font, None)
}

fn replace_with_bounds(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    id: usize,
    value: Option<&str>,
    font: Option<(&Path, &str)>,
    cell: Option<[f32; 4]>,
) -> Result<Vec<u8>, PreviewError> {
    if value.is_some_and(|text| text.trim().is_empty()) {
        return crate::flow::delete_text(
            pdfium,
            original,
            index,
            &std::collections::BTreeSet::from([id]),
        );
    }
    // All mutations happen on a private candidate. Any failure leaves the active document untouched.
    let mut candidate = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let before;
    let original_objects;
    {
        let page = candidate
            .pages()
            .get(index)
            .map_err(|_| PreviewError::InvalidPage)?;
        let objects = text::extract(&candidate, &page, &config);
        original_objects = objects.objects;
        before = original_objects
            .iter()
            .find(|o| o.id == id)
            .cloned()
            .ok_or(PreviewError::StaleObject)?;
    }
    let value = value.unwrap_or(&before.text);
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(PreviewError::UnsupportedText);
    }
    let preserved = if font.is_none() && before.font_change_blocked.is_none() {
        let page = candidate
            .pages()
            .get(index)
            .map_err(|_| PreviewError::InvalidPage)?;
        let object = page
            .objects()
            .get(id)
            .map_err(|_| PreviewError::StaleObject)?;
        let original = object
            .as_text_object()
            .ok_or(PreviewError::UnsupportedText)?
            .font();
        let embedded = original.is_embedded().unwrap_or(false);
        let reusable = if embedded {
            original
                .data()
                .ok()
                .is_some_and(|bytes| crate::fonts::validate_original(&bytes, value).is_ok())
        } else {
            crate::text::standard_font(&before.font) && value.is_ascii()
        };
        if reusable {
            None
        } else {
            Some(crate::fonts::preserved_bytes(&candidate, &original, value)?)
        }
    } else {
        None
    };
    let token = if let Some((directory, font)) = font {
        if before.font_change_blocked.is_some() {
            return Err(PreviewError::UnsupportedText);
        }
        let bytes = crate::fonts::load(directory, font, value)?;
        Some(
            candidate
                .fonts_mut()
                .load_true_type_from_bytes(&bytes, true)
                .map_err(|_| PreviewError::FontUnavailable)?,
        )
    } else if let Some(bytes) = preserved {
        Some(
            candidate
                .fonts_mut()
                .load_true_type_from_bytes(&bytes, true)
                .map_err(|_| PreviewError::FontUnavailable)?,
        )
    } else {
        None
    };
    let font_replaced = token.is_some();
    let expected_font;
    {
        let mut page = candidate
            .pages()
            .get(index)
            .map_err(|_| PreviewError::InvalidPage)?;
        if token.is_none() && before.edit_blocked.is_some() {
            return Err(PreviewError::UnsupportedText);
        }
        if let Some(token) = token {
            page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
            let mut replacement =
                PdfPageTextObject::new(&candidate, value, token, PdfPoints::new(before.font_size))
                    .map_err(|_| PreviewError::EditFailed)?;
            let [a, b, c, d, e, f] = before.matrix;
            replacement
                .reset_matrix(PdfMatrix::new(a, b, c, d, e, f))
                .map_err(|_| PreviewError::EditFailed)?;
            let [r, g, b, a] = before.color;
            replacement
                .set_fill_color(PdfColor::new(r, g, b, a))
                .map_err(|_| PreviewError::EditFailed)?;
            expected_font = replacement.font().name();
            let object_index = id.try_into().map_err(|_| PreviewError::StaleObject)?;
            let mut tail = Vec::new();
            while page.objects().len() > object_index {
                tail.push(
                    page.objects_mut()
                        .remove_object_at_index(object_index)
                        .map_err(|_| PreviewError::EditFailed)?,
                );
            }
            if tail.is_empty() {
                return Err(PreviewError::StaleObject);
            }
            page.objects_mut()
                .add_text_object(replacement)
                .map_err(|_| PreviewError::EditFailed)?;
            for object in tail.into_iter().skip(1) {
                page.objects_mut()
                    .add_object(object)
                    .map_err(|_| PreviewError::EditFailed)?;
            }
        } else {
            let mut object = page
                .objects()
                .get(id.try_into().map_err(|_| PreviewError::StaleObject)?)
                .map_err(|_| PreviewError::StaleObject)?;
            let text_object = object
                .as_text_object_mut()
                .ok_or(PreviewError::StaleObject)?;
            if crate::fonts::known_name(&before.font)
                || text_object.font().is_embedded().unwrap_or(false)
            {
                let data = text_object
                    .font()
                    .data()
                    .map_err(|_| PreviewError::FontUnavailable)?;
                crate::fonts::validate(&data, value)?;
            } else if !value.bytes().all(|b| (32..=126).contains(&b)) {
                return Err(PreviewError::UnsupportedText);
            }
            expected_font = before.font.clone();
            let mut applied_value = value.to_owned();
            if cell.is_some() {
                let text_page = page.text().map_err(|_| PreviewError::VerificationFailed)?;
                let chars = text_page
                    .chars_for_object(text_object)
                    .map_err(|_| PreviewError::VerificationFailed)?;
                let actual: Option<String> = chars.iter().map(|c| c.unicode_char()).collect();
                let actual = actual.ok_or(PreviewError::VerificationFailed)?;
                if before.text.strip_prefix(&actual).is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.chars().all(char::is_whitespace)
                }) {
                    // Do not turn PDFium's generated trailing word space into a
                    // real glyph, which would change source ranges on reopening.
                    applied_value = value.chars().take(actual.chars().count()).collect();
                }
            }
            text_object
                .set_text(applied_value)
                .map_err(|_| PreviewError::EditFailed)?;
        }
        page.regenerate_content()
            .map_err(|_| PreviewError::EditFailed)?;
    }
    let bytes = candidate
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    let bytes = crate::text_spacing::preserve(
        pdfium,
        original,
        bytes,
        index,
        &original_objects,
        &std::collections::BTreeSet::from([id]),
        1,
    )?;
    let reopened = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let page = reopened
        .pages()
        .get(index)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let objects = text::extract(&reopened, &page, &config);
    let after = objects
        .objects
        .iter()
        .find(|o| {
            if font_replaced {
                o.text.trim_end_matches(' ') == value.trim_end_matches(' ')
                    && o.font == expected_font
                    && o.matrix
                        .iter()
                        .zip(before.matrix)
                        .all(|(a, b)| (a - b).abs() <= 0.01)
            } else {
                o.id == id
            }
        })
        .ok_or(PreviewError::VerificationFailed)?;
    let after_id = after.id;
    // PDFium adds terminal word spaces from neighbouring object positions.
    // These are extraction separators, not changes to the stored glyphs.
    // Keep the geometry, style and untouched-region pixel checks below.
    if after.text.trim_end_matches(' ') != value.trim_end_matches(' ')
        || expected_font != after.font
        || before.color != after.color
        || (before.font_size - after.font_size).abs() > 0.01
        || before
            .matrix
            .iter()
            .zip(after.matrix)
            .any(|(a, b)| (a - b).abs() > 0.01)
    {
        return Err(PreviewError::ChangedTextMismatch);
    }
    // No automatic reflow. Font changes allow bounded bearing/height differences,
    // while the right edge stays within the original width (plus rounding tolerance).
    let min_x = before
        .bounds
        .iter()
        .map(|p| p[0])
        .fold(f32::INFINITY, f32::min)
        - if font_replaced {
            before.font_size * before.matrix[0] * 0.15
        } else {
            0.5
        };
    let max_x = before
        .bounds
        .iter()
        .map(|p| p[0])
        .fold(f32::NEG_INFINITY, f32::max)
        + 0.5;
    let min_y = before
        .bounds
        .iter()
        .map(|p| p[1])
        .fold(f32::INFINITY, f32::min)
        - if font_replaced {
            before.font_size * before.matrix[3] * 0.25
        } else {
            1.0
        };
    let max_y = before
        .bounds
        .iter()
        .map(|p| p[1])
        .fold(f32::NEG_INFINITY, f32::max)
        + if font_replaced {
            before.font_size * before.matrix[3] * 0.25
        } else {
            1.0
        };
    // Fixed-length group edits may use the original glyph advance cells, rather
    // than the old letter's ink shape. This permits different Hangul syllables
    // without allowing wider text or a new overlap with adjacent objects.
    let [min_x, min_y, max_x, max_y] = cell
        .map(|r| [r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5])
        .unwrap_or([min_x, min_y, max_x, max_y]);
    if after
        .bounds
        .iter()
        .any(|p| p[0] < min_x || p[0] > max_x || p[1] < min_y || p[1] > max_y)
    {
        return Err(PreviewError::TextOverflow);
    }
    if font_replaced || cell.is_some() {
        let rect = |o: &text::TextObject| {
            [
                o.bounds.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min),
                o.bounds.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min),
                o.bounds
                    .iter()
                    .map(|p| p[0])
                    .fold(f32::NEG_INFINITY, f32::max),
                o.bounds
                    .iter()
                    .map(|p| p[1])
                    .fold(f32::NEG_INFINITY, f32::max),
            ]
        };
        let overlaps =
            |a: [f32; 4], b: [f32; 4]| a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
        if objects.objects.iter().any(|other| {
            other.id != after_id
                && overlaps(rect(after), rect(other))
                && !overlaps(rect(&before), rect(other))
        }) {
            return Err(PreviewError::TextOverflow);
        }
    }
    let allowed_screen: Vec<_> = before
        .screen_bounds
        .iter()
        .chain(after.screen_bounds.iter())
        .copied()
        .collect();
    drop(page);
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if baseline.pages().len() != reopened.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    for page_index in 0..baseline.pages().len() {
        let old_page = baseline
            .pages()
            .get(page_index)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let new_page = reopened
            .pages()
            .get(page_index)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let old_objects = text::extract_for_verification(&baseline, &old_page, &config);
        let new_objects = text::extract_for_verification(&reopened, &new_page, &config);
        let mut old_remaining: Vec<_> = old_objects
            .objects
            .iter()
            .filter(|o| page_index != index || o.id != id)
            .cloned()
            .collect();
        let mut new_remaining: Vec<_> = new_objects
            .objects
            .iter()
            .filter(|o| page_index != index || o.id != after_id)
            .cloned()
            .collect();
        for object in old_remaining.iter_mut().chain(new_remaining.iter_mut()) {
            object.id = 0;
            object.font_object_id = 0;
            object.text = object.text.trim_end_matches(' ').to_owned();
        }
        if old_objects.warning != new_objects.warning || old_remaining != new_remaining {
            return Err(PreviewError::UnchangedTextModified);
        }
        let old_bitmap = old_page
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let new_bitmap = new_page
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if old_bitmap.width() != new_bitmap.width() || old_bitmap.height() != new_bitmap.height() {
            return Err(PreviewError::VerificationFailed);
        }
        let old_pixels = old_bitmap.as_rgba_bytes();
        let new_pixels = new_bitmap.as_rgba_bytes();
        let left = allowed_screen.iter().map(|p| p[0]).min().unwrap() - 3;
        let right = allowed_screen.iter().map(|p| p[0]).max().unwrap() + 3;
        let top = allowed_screen.iter().map(|p| p[1]).min().unwrap() - 3;
        let bottom = allowed_screen.iter().map(|p| p[1]).max().unwrap() + 3;
        for (pixel, (old, new)) in old_pixels
            .chunks_exact(4)
            .zip(new_pixels.chunks_exact(4))
            .enumerate()
        {
            let x = pixel as i32 % old_bitmap.width();
            let y = pixel as i32 / old_bitmap.width();
            if (page_index != index || x < left || x > right || y < top || y > bottom) && old != new
            {
                return Err(PreviewError::VerificationFailed);
            }
        }
    }
    Ok(bytes)
}
