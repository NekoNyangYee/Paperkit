//! Bounded reflow of a complete, uniformly styled paragraph. Mixed styles remain
//! on the source-range edit path; no PDF overlay is used.
use crate::{
    layout::{self, GroupKind, TextGroup},
    render::PreviewError,
    text::{self, TextObject},
};
use pdfium_render::prelude::*;
use std::collections::{BTreeSet, HashMap};

fn rect(points: &[[f32; 2]]) -> [f32; 4] {
    [
        points.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min),
        points.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min),
        points
            .iter()
            .map(|p| p[0])
            .fold(f32::NEG_INFINITY, f32::max),
        points
            .iter()
            .map(|p| p[1])
            .fold(f32::NEG_INFINITY, f32::max),
    ]
}
fn same_style(a: &TextObject, b: &TextObject) -> bool {
    a.font == b.font
        && a.color == b.color
        && (a.font_size - b.font_size).abs() < 0.01
        && a.matrix[..4]
            .iter()
            .zip(&b.matrix[..4])
            .all(|(x, y)| (x - y).abs() < 0.001)
}

pub(crate) fn eligible(group: &TextGroup, objects: &[TextObject]) -> bool {
    font_eligible(group, objects)
        && group.edit_blocked.is_none()
        && group.runs.iter().all(|r| {
            objects.iter().find(|o| o.id == r.object).is_some_and(|o| {
                o.edit_blocked.is_none()
                    && o.font
                        == objects
                            .iter()
                            .find(|o| o.id == group.runs[0].object)
                            .unwrap()
                            .font
            })
        })
}

pub(crate) fn font_eligible(group: &TextGroup, objects: &[TextObject]) -> bool {
    if group.kind != GroupKind::Paragraph
        || group.uncertain
        || group.runs.is_empty()
        || group.runs.len() > 128
    {
        return false;
    }
    let Some(first) = objects.iter().find(|o| o.id == group.runs[0].object) else {
        return false;
    };
    let ids: BTreeSet<_> = group.runs.iter().map(|r| r.object).collect();
    ids.iter().all(|id| {
        let Some(o) = objects.iter().find(|o| o.id == *id) else {
            return false;
        };
        let ranges: Vec<_> = group.runs.iter().filter(|r| r.object == *id).collect();
        o.font_change_blocked.is_none()
            && o.color == first.color
            && (o.font_size - first.font_size).abs() < 0.01
            && o.matrix[..4]
                .iter()
                .zip(&first.matrix[..4])
                .all(|(a, b)| (a - b).abs() < 0.001)
            && ranges.len() == 1
            && ranges[0].object_start == 0
            && ranges[0].end - ranges[0].start
                >= o.text.trim_end_matches(char::is_whitespace).chars().count()
    })
}

// Preserve every character. Prefer wrapping after a space; CJK can wrap between
// characters. Explicit newlines always consume a line, including empty lines.
fn wrap(
    value: &str,
    width: f32,
    advance: impl Fn(char) -> f32,
) -> Result<Vec<String>, PreviewError> {
    let mut lines = Vec::new();
    for paragraph in value.split('\n') {
        let mut pending = String::new();
        let mut used = 0.0;
        for ch in paragraph.chars() {
            let w = advance(ch);
            if !w.is_finite() || w < 0.0 || w > width + 0.01 {
                return Err(PreviewError::TextOverflow);
            }
            if used + w > width + 0.01 && !pending.is_empty() {
                if let Some((offset, _)) = pending.char_indices().rev().find(|(_, c)| *c == ' ') {
                    let tail = pending.split_off(offset + 1);
                    lines.push(std::mem::replace(&mut pending, tail));
                    used = pending.chars().map(&advance).sum();
                } else {
                    lines.push(std::mem::take(&mut pending));
                    used = 0.0;
                }
                if used + w > width + 0.01 && !pending.is_empty() {
                    lines.push(std::mem::take(&mut pending));
                    used = 0.0;
                }
            }
            pending.push(ch);
            used += w;
        }
        lines.push(pending);
    }
    Ok(lines)
}

pub(crate) fn replace(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    id: usize,
    value: Option<&str>,
    replacement_font: Option<(&std::path::Path, &str)>,
) -> Result<Vec<u8>, PreviewError> {
    let mut candidate = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let page = candidate
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let mut before = text::extract(&candidate, &page, &config);
    layout::reconstruct(&page, &config, &mut before);
    let group = before
        .groups
        .iter()
        .find(|g| g.id == id)
        .ok_or(PreviewError::StaleObject)?;
    let value = value.unwrap_or(&group.text);
    if value.len() > 4096 || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(PreviewError::UnsupportedText);
    }
    if !(if replacement_font.is_some() {
        font_eligible(group, &before.objects)
    } else {
        eligible(group, &before.objects)
    }) {
        return Err(PreviewError::UnsupportedText);
    }
    let ids: BTreeSet<_> = group.runs.iter().map(|r| r.object).collect();
    let first = before
        .objects
        .iter()
        .find(|o| o.id == group.runs[0].object)
        .unwrap();
    let area = rect(&group.bounds.iter().flatten().copied().collect::<Vec<_>>());
    let object = page
        .objects()
        .get(first.id)
        .map_err(|_| PreviewError::StaleObject)?;
    let font = object
        .as_text_object()
        .ok_or(PreviewError::StaleObject)?
        .font();
    let mut preserved = None;
    if replacement_font.is_none()
        && (crate::fonts::known_name(&first.font) || font.is_embedded().unwrap_or(false))
    {
        let value = value.replace('\n', "");
        if !font
            .data()
            .ok()
            .is_some_and(|data| crate::fonts::validate(&data, &value).is_ok())
        {
            preserved = Some(crate::fonts::preserved_bytes(&candidate, &font, &value)?);
        }
    } else if replacement_font.is_none()
        && (!crate::text::standard_font(&first.font)
            || !value
                .chars()
                .all(|c| c == '\n' || c.is_ascii() && !c.is_control()))
    {
        preserved = Some(crate::system_fonts::load(
            &first.font,
            &value.replace('\n', ""),
        )?);
    }
    let original_token = font.token();
    drop(font);
    drop(object);
    drop(page);
    let token = if let Some((directory, id)) = replacement_font {
        let bytes = crate::fonts::load(directory, id, &value.replace('\n', ""))?;
        candidate
            .fonts_mut()
            .load_true_type_from_bytes(&bytes, true)
            .map_err(|_| PreviewError::FontUnavailable)?
    } else if let Some(bytes) = preserved {
        candidate
            .fonts_mut()
            .load_true_type_from_bytes(&bytes, true)
            .map_err(|_| PreviewError::FontUnavailable)?
    } else {
        original_token
    };
    let mut page = candidate
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let size = PdfPoints::new(first.font_size);
    let sentinel = PdfPageTextObject::new(&candidate, "|", token, size)
        .map_err(|_| PreviewError::EditFailed)?;
    let mut expected_style = first.clone();
    expected_style.font = sentinel.font().name();
    let sentinel_right = sentinel
        .bounds()
        .map_err(|_| PreviewError::EditFailed)?
        .x3()
        .value;
    let mut widths = HashMap::new();
    for ch in value.chars().filter(|c| *c != '\n') {
        if widths.contains_key(&ch) {
            continue;
        }
        let probe = PdfPageTextObject::new(&candidate, format!("{ch}|"), token, size)
            .map_err(|_| PreviewError::EditFailed)?;
        let advance = (probe
            .bounds()
            .map_err(|_| PreviewError::EditFailed)?
            .x3()
            .value
            - sentinel_right)
            * first.matrix[0];
        widths.insert(ch, advance);
    }
    let left = first.matrix[4];
    let top_baseline = first.matrix[5];
    let mut baselines: Vec<_> = before
        .objects
        .iter()
        .filter(|o| ids.contains(&o.id))
        .map(|o| o.matrix[5])
        .collect();
    baselines.sort_by(|a, b| b.total_cmp(a));
    baselines.dedup_by(|a, b| (*a - *b).abs() < 0.1);
    let leading = if baselines.len() > 1 {
        baselines
            .windows(2)
            .map(|p| p[0] - p[1])
            .fold(f32::INFINITY, f32::min)
    } else {
        first.font_size * first.matrix[3] * 1.25
    };
    let lines = wrap(value, area[2] - left, |c| widths[&c])?;
    if lines.len() > group.bounds.len() {
        return Err(PreviewError::TextOverflow);
    }
    let mut replacements = Vec::new();
    let mut expected = Vec::new();
    for (line_number, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let mut replacement = PdfPageTextObject::new(&candidate, line, token, size)
            .map_err(|_| PreviewError::EditFailed)?;
        let [a, b, c, d, _, _] = first.matrix;
        let y = top_baseline - line_number as f32 * leading;
        replacement
            .reset_matrix(PdfMatrix::new(a, b, c, d, left, y))
            .map_err(|_| PreviewError::EditFailed)?;
        let [r, g, b, a] = first.color;
        replacement
            .set_fill_color(PdfColor::new(r, g, b, a))
            .map_err(|_| PreviewError::EditFailed)?;
        expected.push((line.trim_end().to_string(), left, y));
        replacements.push(replacement);
    }
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    // Keep non-target objects in their original relative order.
    let first_id = *ids.first().unwrap();
    let mut tail = Vec::new();
    let mut old_id = first_id;
    while page.objects().len() > first_id {
        let object = page
            .objects_mut()
            .remove_object_at_index(first_id)
            .map_err(|_| PreviewError::EditFailed)?;
        if !ids.contains(&old_id) {
            tail.push(object);
        }
        old_id += 1;
    }
    for replacement in replacements {
        page.objects_mut()
            .add_text_object(replacement)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    for object in tail {
        page.objects_mut()
            .add_object(object)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = candidate
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    let bytes = crate::text_spacing::preserve(
        pdfium,
        original,
        bytes,
        index,
        &before.objects,
        &ids,
        expected.len(),
    )?;
    let reopened = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if reopened.pages().len() != baseline.pages().len() {
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
        let old = text::extract_for_verification(&baseline, &old_page, &config);
        let new = text::extract_for_verification(&reopened, &new_page, &config);
        let mut new_ids = BTreeSet::new();
        if page_index == index {
            for (value, x, y) in &expected {
                let matches: Vec<_> = new
                    .objects
                    .iter()
                    .filter(|o| {
                        o.text.trim_end() == value
                            && same_style(&expected_style, o)
                            && (o.matrix[4] - x).abs() < 0.01
                            && (o.matrix[5] - y).abs() < 0.01
                    })
                    .collect();
                if matches.len() != 1 || !new_ids.insert(matches[0].id) {
                    return Err(PreviewError::VerificationFailed);
                }
                let r = rect(&matches[0].bounds);
                if r[0] < area[0] - 0.5
                    || r[1] < area[1] - 0.5
                    || r[2] > area[2] + 0.5
                    || r[3] > area[3] + 0.5
                {
                    return Err(PreviewError::TextOverflow);
                }
                if old
                    .objects
                    .iter()
                    .filter(|o| !ids.contains(&o.id))
                    .any(|o| {
                        let b = rect(&o.bounds);
                        r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]
                    })
                {
                    return Err(PreviewError::TextOverflow);
                }
            }
        }
        let normalize = |objects: Vec<TextObject>, remove: &BTreeSet<usize>| {
            objects
                .into_iter()
                .filter(|o| !remove.contains(&o.id))
                .map(|mut o| {
                    o.id = 0;
                    o.font_object_id = 0;
                    // PDFium synthesizes terminal word spaces based on object
                    // reading order; these are not glyphs in the PDF object.
                    // All geometry/style and outside-region pixels still match.
                    o.text = o.text.trim_end_matches(' ').to_owned();
                    o
                })
                .collect::<Vec<_>>()
        };
        let none = BTreeSet::new();
        let old_remaining = normalize(old.objects, if page_index == index { &ids } else { &none });
        let new_remaining = normalize(new.objects, &new_ids);
        if old.warning != new.warning || old_remaining != new_remaining {
            return Err(PreviewError::VerificationFailed);
        }
        let a = old_page
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let b = new_page
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if a.width() != b.width() || a.height() != b.height() {
            return Err(PreviewError::VerificationFailed);
        }
        let screen: Vec<_> = group.screen_bounds.iter().flatten().collect();
        let x0 = screen.iter().map(|p| p[0]).min().unwrap() - 2;
        let x1 = screen.iter().map(|p| p[0]).max().unwrap() + 2;
        let y0 = screen.iter().map(|p| p[1]).min().unwrap() - 2;
        let y1 = screen.iter().map(|p| p[1]).max().unwrap() + 2;
        for (i, (a_pixel, b_pixel)) in a
            .as_rgba_bytes()
            .chunks_exact(4)
            .zip(b.as_rgba_bytes().chunks_exact(4))
            .enumerate()
        {
            let x = i as i32 % a.width();
            let y = i as i32 / a.width();
            if (page_index != index || x < x0 || x > x1 || y < y0 || y > y1) && a_pixel != b_pixel {
                return Err(PreviewError::VerificationFailed);
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_words_cjk_and_explicit_empty_lines_without_losing_characters() {
        assert_eq!(
            wrap("one two abc", 7.0, |_| 1.0).unwrap(),
            ["one ", "two abc"]
        );
        assert_eq!(
            wrap("한글문장입니다", 3.0, |_| 1.0).unwrap(),
            ["한글문", "장입니", "다"]
        );
        assert_eq!(wrap("a\n\nb", 3.0, |_| 1.0).unwrap(), ["a", "", "b"]);
    }
}
