//! Editable blocks with retained source styles and independently adjustable width.
use crate::{
    error::EngineError as PreviewError,
    layout::{self, GroupKind, TextGroup},
    text::{self, TextObject},
};
use pdfium_render::prelude::*;
use std::{
    collections::{BTreeSet, HashMap},
    path::Path,
};

enum Replacement<'a> {
    Original(usize, f32),
    New(PdfPageTextObject<'a>),
}

pub(crate) fn eligible(g: &TextGroup, objects: &[TextObject]) -> bool {
    g.kind == GroupKind::Paragraph
        && !g.uncertain
        && !g.runs.is_empty()
        && g.runs.len() <= 256
        && g.runs.iter().all(|r| {
            objects.iter().find(|o| o.id == r.object).is_some_and(|o| {
                o.font_change_blocked.is_none()
                    && r.object_start == 0
                    && r.end - r.start >= o.text.trim_end().chars().count()
                    && g.runs.iter().filter(|s| s.object == r.object).count() == 1
            })
        })
}
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

pub(crate) fn replace(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    group_ids: &[usize],
    value: Option<&str>,
    width: Option<f32>,
    height: Option<f32>,
    fonts: &Path,
    replacement_font: Option<&str>,
) -> Result<Vec<u8>, PreviewError> {
    replace_with_fonts(
        pdfium,
        original,
        index,
        group_ids,
        value,
        width,
        height,
        fonts,
        replacement_font,
        &HashMap::new(),
        None,
    )
}

pub(crate) fn replace_with_fonts(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    group_ids: &[usize],
    value: Option<&str>,
    width: Option<f32>,
    height: Option<f32>,
    fonts: &Path,
    replacement_font: Option<&str>,
    overrides: &HashMap<usize, String>,
    alignment: Option<crate::alignment::Alignment>,
) -> Result<Vec<u8>, PreviewError> {
    let mut doc = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let page = doc
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    // Geometry and permissions suffice here. Resolve only the fonts actually
    // used by the new text below, never every original font on the page.
    let mut before = text::extract_for_verification(&doc, &page, &config);
    before.graphics = text::extract_graphics(&page, &config);
    layout::reconstruct(&page, &config, &mut before);
    if group_ids.is_empty() || group_ids.len() > 32 {
        return Err(PreviewError::UnsupportedText);
    }
    let mut selected = group_ids
        .iter()
        .map(|id| {
            before
                .groups
                .iter()
                .find(|g| g.id == *id)
                .ok_or(PreviewError::StaleObject)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if selected.iter().any(|g| !eligible(g, &before.objects)) {
        return Err(PreviewError::UnsupportedText);
    }
    selected.sort_by(|a, b| {
        let ar = rect(&a.bounds.iter().flatten().copied().collect::<Vec<_>>());
        let br = rect(&b.bounds.iter().flatten().copied().collect::<Vec<_>>());
        br[3].total_cmp(&ar[3]).then(ar[0].total_cmp(&br[0]))
    });
    let mut combined = selected[0].clone();
    for next in selected.iter().skip(1) {
        let offset = combined.text.chars().count() + 2;
        combined.text.push_str("\n\n");
        combined.text.push_str(&next.text);
        combined.runs.extend(next.runs.iter().cloned().map(|mut r| {
            r.start += offset;
            r.end += offset;
            r
        }));
        combined.bounds.extend(next.bounds.clone());
        combined.screen_bounds.extend(next.screen_bounds.clone());
    }
    let group = &combined;
    let value = value.unwrap_or(&group.text);
    if value.len() > 32768 || value.chars().any(|c| c.is_control() && c != '\n') {
        return Err(PreviewError::UnsupportedText);
    }

    if !eligible(group, &before.objects) {
        return Err(PreviewError::UnsupportedText);
    }
    let ids: BTreeSet<_> = group.runs.iter().map(|r| r.object).collect();
    if value.trim().is_empty() {
        return delete_text(pdfium, original, index, &ids);
    }
    if overrides.keys().any(|id| !ids.contains(id)) {
        return Err(PreviewError::StaleObject);
    }
    if selected.len() == 1
        && width.is_none()
        && height.is_none()
        && replacement_font.is_none()
        && overrides.is_empty()
        && alignment.is_none()
    {
        if let Some(bytes) = patch_short_edit(
            pdfium,
            original,
            index,
            group,
            value,
            &before.objects,
            &config,
        ) {
            return Ok(bytes);
        }
    }
    let sources: Vec<_> = group
        .runs
        .iter()
        .map(|r| {
            before
                .objects
                .iter()
                .find(|o| o.id == r.object)
                .unwrap()
                .clone()
        })
        .collect();
    let source_lines = crate::alignment::source_lines(&sources);
    let automatic = alignment.is_none();
    let alignment = alignment.unwrap_or_else(|| crate::alignment::detect(&source_lines));
    let area = rect(&group.bounds.iter().flatten().copied().collect::<Vec<_>>());
    let media = page
        .boundaries()
        .media()
        .map_err(|_| PreviewError::UnsupportedText)?
        .bounds;
    let crop = page.boundaries().crop().map(|b| b.bounds).unwrap_or(media);
    let left = sources
        .iter()
        .map(|o| o.matrix[4])
        .fold(f32::INFINITY, f32::min);
    let bottom = media.bottom().value.max(crop.bottom().value);
    let right = media.right().value.min(crop.right().value);
    let top = media.top().value.min(crop.top().value);
    let (fixed, footer_top) = crate::flow_followers::pagination(
        &before,
        [
            media.left().value.max(crop.left().value),
            bottom,
            right,
            top,
        ],
    );
    let bottom = if area[1] > footer_top {
        footer_top
    } else {
        bottom
    };
    let automatic_width = width.is_none();
    // Measure against the page first. The original ink box is a minimum size,
    // not a wrapping constraint, unless the user explicitly sets a width.
    let width = width.unwrap_or(right - left);
    if !width.is_finite()
        || width <= 0.0
        || left + width > right + 0.01
        || height.is_some_and(|h| !h.is_finite() || h <= 0.0)
    {
        return Err(PreviewError::PageOverflow);
    }
    let old: Vec<char> = group.text.chars().collect();
    let new: Vec<char> = value.chars().collect();
    let mut original_styles = vec![usize::MAX; old.len()];
    for (style, r) in group.runs.iter().enumerate() {
        for slot in original_styles.iter_mut().take(r.end).skip(r.start) {
            *slot = style;
        }
    }
    let mut previous = 0;
    for style in &mut original_styles {
        if *style == usize::MAX {
            *style = previous;
        } else {
            previous = *style;
        }
    }
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let inserted_style = original_styles
        .get(prefix)
        .or_else(|| original_styles.last())
        .copied()
        .unwrap_or(0);
    let styles: Vec<usize> = (0..new.len())
        .map(|i| {
            if i < prefix {
                original_styles[i]
            } else if i >= new.len() - suffix {
                original_styles[old.len() - (new.len() - i)]
            } else {
                inserted_style
            }
        })
        .collect();
    let mut tokens = Vec::new();
    let mut expected_styles = sources.clone();
    let mut originals = Vec::new();
    let mut original_faces = HashMap::new();
    for source in &sources {
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
    for (&ch, &style) in new.iter().zip(&styles).filter(|(ch, _)| **ch != '\n') {
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
            let bytes = crate::fonts::load(fonts, name, &needed)?;
            tokens.push(
                doc.fonts_mut()
                    .load_true_type_from_bytes(&bytes, true)
                    .map_err(|_| PreviewError::FontUnavailable)?,
            );
        } else if let Some(token) = replacement {
            tokens.push(token);
        } else if let Some(recovered) = recovered_tokens.get(token) {
            tokens.push(*recovered);
        } else if usable
            && *embedded
            && original_encoding_roundtrips(&mut doc, *token, &face_needed)?
        {
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
    let mut advances = HashMap::new();
    let mut measure_tails = HashMap::new();
    let mut measured_advances = HashMap::new();
    for (&ch, &s) in new.iter().zip(&styles).filter(|(c, _)| **c != '\n') {
        if advances.contains_key(&(s, ch)) {
            continue;
        }
        let size = PdfPoints::new(sources[s].font_size);
        let face_key = (tokens[s], sources[s].font_size.to_bits());
        let metric_key = (face_key, ch);
        let units = if let Some(value) = measured_advances.get(&metric_key) {
            *value
        } else {
            // Measure once per face/size/character, not once per PDF text fragment.
            let (sentinel, tail) = if let Some(cached) = measure_tails.get(&face_key) {
                *cached
            } else {
                let sentinel = needed_by_style[s]
                    .chars()
                    .find(|c| !c.is_whitespace())
                    .unwrap_or(ch);
                let tail = PdfPageTextObject::new(&doc, sentinel.to_string(), tokens[s], size)
                    .map_err(|_| PreviewError::EditFailed)?
                    .bounds()
                    .map_err(|_| PreviewError::EditFailed)?
                    .x3()
                    .value;
                measure_tails.insert(face_key, (sentinel, tail));
                (sentinel, tail)
            };
            let probe = PdfPageTextObject::new(&doc, format!("{ch}{sentinel}"), tokens[s], size)
                .map_err(|_| PreviewError::EditFailed)?
                .bounds()
                .map_err(|_| PreviewError::EditFailed)?
                .x3()
                .value;
            let units = probe - tail;
            measured_advances.insert(metric_key, units);
            units
        };
        let advance = units * sources[s].matrix[0];
        if !advance.is_finite() || advance < 0.0 || advance > width {
            return Err(PreviewError::PageOverflow);
        }
        advances.insert((s, ch), advance);
    }
    // Preserve original visual rows outside the edited character range. PDF
    // reconstruction uses spaces between these rows, not paragraph newlines.
    let mut boundaries = HashMap::new();
    let mut source_rows: Vec<Vec<usize>> = Vec::new();
    let mut previous_source: Option<&TextObject> = None;
    for (source_index, (run, source)) in group.runs.iter().zip(&sources).enumerate() {
        let starts_line = previous_source.is_none_or(|previous| {
            previous.matrix[5] - source.matrix[5]
                > (previous.font_size * previous.matrix[3]).min(source.font_size * source.matrix[3])
                    * 0.5
        });
        if starts_line {
            source_rows.push(Vec::new());
            // The first source row anchors the new paragraph. Prepending text
            // to it must not create a new break before the old first character.
            let mapped = if run.start == 0 || run.start < prefix {
                Some(run.start)
            } else if run.start >= old.len() - suffix {
                Some(new.len() - (old.len() - run.start))
            } else {
                None
            };
            if let Some(at) = mapped.filter(|at| *at < new.len()) {
                let indent = if automatic && alignment == crate::alignment::Alignment::Left {
                    (source.matrix[4] - left).max(0.0).min(width * 0.8)
                } else {
                    0.0
                };
                boundaries.insert(at, (indent, source.matrix[5]));
            }
        }
        source_rows.last_mut().unwrap().push(source_index);
        previous_source = Some(source);
    }
    let first_indent = if automatic && alignment == crate::alignment::Alignment::Left {
        (source_lines[0][1] - left).max(0.0).min(width * 0.8)
    } else {
        0.0
    };
    let width = if automatic_width {
        crate::flow_lines::natural_width(&new, &styles, &advances, first_indent, &boundaries)
            .max((area[2] - left).max(12.0))
            .min(width)
    } else {
        width
    };
    let mut retained_rows = HashMap::new();
    if automatic
        && alignment == crate::alignment::Alignment::Left
        && replacement_font.is_none()
        && overrides.is_empty()
        && width >= area[2] - left - 0.01
    {
        for row in source_rows {
            let start = group.runs[row[0]].start;
            let end = group.runs[*row.last().unwrap()].end;
            let mapped = if end <= prefix {
                Some(start)
            } else if start >= old.len() - suffix {
                Some(new.len() - (old.len() - start))
            } else {
                None
            };
            if let Some(at) = mapped.filter(|at| boundaries.contains_key(at)) {
                let end = at + end - start;
                let next = boundaries
                    .keys()
                    .copied()
                    .filter(|&p| p > at)
                    .min()
                    .unwrap_or(new.len());
                let stop = new[at..next]
                    .iter()
                    .position(|c| *c == '\n')
                    .map_or(next, |n| at + n);
                // An insertion on this same row must still wrap normally.
                if end <= stop && new[end..stop].iter().all(|c| c.is_whitespace()) {
                    retained_rows.insert(at, row);
                }
            }
        }
    }
    let lines = crate::flow_lines::wrap(
        &new,
        &styles,
        &advances,
        width,
        first_indent,
        &boundaries,
        &retained_rows.keys().copied().collect(),
    );
    let mut baselines: Vec<f32> = sources.iter().map(|o| o.matrix[5]).collect();
    baselines.sort_by(|a, b| b.total_cmp(a));
    baselines.dedup_by(|a, b| (*a - *b).abs() < 0.1);
    let default_em = sources[0].font_size * sources[0].matrix[3];
    let mut observed_leading: Vec<_> = baselines
        .windows(2)
        .map(|p| p[0] - p[1])
        .filter(|v| *v > default_em * 0.5 && *v <= default_em * 3.0)
        .collect();
    observed_leading.sort_by(f32::total_cmp);
    // A 1.4em default is only for a single original line. Capping existing
    // leading at that default compressed every double-spaced edited paragraph.
    let leading = observed_leading
        .get(observed_leading.len() / 2)
        .copied()
        .unwrap_or(default_em * 1.4);
    let mut y = baselines[0];
    let mut last_source_baseline = baselines[0];
    let mut expected = Vec::new();
    let mut replacements = Vec::new();
    let mut previous_em = default_em;
    for (line_index, row) in lines.iter().enumerate() {
        let line = &row.indices;
        let em = line
            .iter()
            .map(|&j| sources[styles[j]].font_size * sources[styles[j]].matrix[3])
            .fold(default_em, f32::max);
        if let Some(baseline) = row.baseline {
            let gap = last_source_baseline - baseline;
            y -= if line_index > 0 && gap.abs() < 0.01 {
                leading.max(previous_em.max(em) * 1.15)
            } else {
                gap
            };
            last_source_baseline = baseline;
        } else if line_index > 0 {
            y -= leading.max(previous_em.max(em) * 1.15);
        }
        previous_em = em;
        if let Some(originals) = line.first().and_then(|at| retained_rows.get(at)) {
            let shift = y - sources[originals[0]].matrix[5];
            for &s in originals {
                let source = &sources[s];
                if source
                    .bounds
                    .iter()
                    .any(|p| p[1] + shift < bottom || p[1] + shift > top)
                {
                    return Err(PreviewError::PageOverflow);
                }
                expected.push((
                    source.text.trim_end().to_owned(),
                    source.clone(),
                    source.matrix[4],
                    source.matrix[5] + shift,
                ));
                replacements.push(Replacement::Original(source.id, shift));
            }
            continue;
        }
        let visible_end = line
            .iter()
            .rposition(|&j| new[j] != ' ')
            .map_or(0, |i| i + 1);
        let used: f32 = line[..visible_end]
            .iter()
            .map(|&j| advances[&(styles[j], new[j])])
            .sum();
        let indent = row.indent;
        let mut x = left + indent + crate::alignment::offset(alignment, width, used);
        let spaces = line[..visible_end]
            .iter()
            .filter(|&&j| new[j] == ' ')
            .count();
        let gap = if alignment == crate::alignment::Alignment::Justify
            && line_index + 1 < lines.len()
            && spaces > 0
            && line.last().is_some_and(|j| new.get(j + 1) != Some(&'\n'))
        {
            (width - used).max(0.0) / spaces as f32
        } else {
            0.0
        };
        let mut at = 0;
        while at < line.len() {
            let s = styles[line[at]];
            let start = at;
            while at < line.len()
                && styles[line[at]] == s
                && (gap == 0.0 || at == start || new[line[at - 1]] != ' ')
            {
                at += 1;
            }
            let text: String = line[start..at].iter().map(|&j| new[j]).collect();
            if !text.trim().is_empty() {
                let style = &expected_styles[s];
                let mut object =
                    PdfPageTextObject::new(&doc, &text, tokens[s], PdfPoints::new(style.font_size))
                        .map_err(|_| PreviewError::EditFailed)?;
                let [a, b, c, d, _, _] = style.matrix;
                object
                    .reset_matrix(PdfMatrix::new(a, b, c, d, x, y))
                    .map_err(|_| PreviewError::EditFailed)?;
                let [r, g, b, a] = style.color;
                object
                    .set_fill_color(PdfColor::new(r, g, b, a))
                    .map_err(|_| PreviewError::EditFailed)?;
                let q = object.bounds().map_err(|_| PreviewError::EditFailed)?;
                if q.bottom().value < bottom || q.top().value > top || q.right().value > right {
                    return Err(PreviewError::PageOverflow);
                }
                expected.push((text.trim_end().to_owned(), style.clone(), x, y));
                replacements.push(Replacement::New(object));
            }
            x += line[start..at]
                .iter()
                .map(|&j| advances[&(styles[j], new[j])])
                .sum::<f32>()
                + gap * line[start..at].iter().filter(|&&j| new[j] == ' ').count() as f32;
        }
    }
    let mut page = doc
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    let old_bottom = before
        .objects
        .iter()
        .filter(|o| ids.contains(&o.id))
        .flat_map(|o| o.bounds)
        .map(|p| p[1])
        .fold(f32::INFINITY, f32::min);
    let new_bottom = replacements
        .iter()
        .map(|o| match o {
            Replacement::New(o) => o.bounds().map(|q| q.bottom().value),
            Replacement::Original(id, dy) => Ok(before
                .objects
                .iter()
                .find(|o| o.id == *id)
                .unwrap()
                .bounds
                .iter()
                .map(|p| p[1] + dy)
                .fold(f32::INFINITY, f32::min)),
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| PreviewError::EditFailed)?
        .into_iter()
        .fold(f32::INFINITY, f32::min);
    let growth = (old_bottom - new_bottom).max(0.0);
    let following = if growth > 0.01 {
        crate::flow_followers::Planner::new(&before)
            .excluding(&fixed)
            .find(&ids)
    } else {
        BTreeSet::new()
    };
    // Translate original objects, including drawings, without recreating their
    // text or fonts. Validate the complete plan before changing this private page.
    for &id in &following {
        let object = page
            .objects()
            .get(id)
            .map_err(|_| PreviewError::StaleObject)?;
        let q = object.bounds().map_err(|_| PreviewError::UnsupportedText)?;
        if q.bottom().value - growth < bottom - 0.01 {
            return Err(PreviewError::FollowingContentOverflow);
        }
    }
    for &id in &following {
        page.objects_mut()
            .get(id)
            .map_err(|_| PreviewError::StaleObject)?
            .transform(1.0, 0.0, 0.0, 1.0, 0.0, -growth)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    let mut spacing_sources = before.objects.clone();
    let retained: HashMap<_, _> = replacements
        .iter()
        .filter_map(|r| match r {
            Replacement::Original(id, dy) => Some((*id, *dy)),
            _ => None,
        })
        .collect();
    for object in &mut spacing_sources {
        if following.contains(&object.id) {
            object.matrix[5] -= growth;
        }
        if let Some(dy) = retained.get(&object.id) {
            object.matrix[5] += dy;
        }
    }
    let removed: BTreeSet<_> = ids
        .iter()
        .copied()
        .filter(|id| !retained.contains_key(id))
        .collect();
    let inserted = replacements.len() - retained.len();
    let mut changed_ids = ids.clone();
    for object in before.objects.iter().filter(|o| following.contains(&o.id)) {
        changed_ids.insert(object.id);
        expected.push((
            object.text.trim_end().to_owned(),
            object.clone(),
            object.matrix[4],
            object.matrix[5] - growth,
        ));
    }
    let first = *ids.first().unwrap();
    let mut tail = Vec::new();
    let mut originals = HashMap::new();
    let mut cursor = first;
    while page.objects().len() > first {
        let object = page
            .objects_mut()
            .remove_object_at_index(first)
            .map_err(|_| PreviewError::EditFailed)?;
        if retained.contains_key(&cursor) {
            originals.insert(cursor, object);
        } else if !ids.contains(&cursor) {
            tail.push(object);
        }
        cursor += 1;
    }
    for o in replacements {
        let object = match o {
            Replacement::New(object) => object.into(),
            Replacement::Original(id, dy) => {
                let mut object = originals.remove(&id).ok_or(PreviewError::EditFailed)?;
                if dy.abs() > 0.00001 {
                    object
                        .transform(1.0, 0.0, 0.0, 1.0, 0.0, dy)
                        .map_err(|_| PreviewError::EditFailed)?;
                }
                object
            }
        };
        page.objects_mut()
            .add_object(object)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    for o in tail {
        page.objects_mut()
            .add_object(o)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = doc.save_to_bytes().map_err(|_| PreviewError::EditFailed)?;
    let bytes = crate::text_spacing::preserve(
        pdfium,
        original,
        bytes,
        index,
        &spacing_sources,
        &removed,
        inserted,
    )?;
    verify(
        pdfium,
        original,
        &bytes,
        index,
        &changed_ids,
        &expected,
        Some((&following, -growth)),
        &config,
    )?;
    Ok(bytes)
}

pub(crate) fn delete_text(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    ids: &BTreeSet<usize>,
) -> Result<Vec<u8>, PreviewError> {
    if ids.is_empty() {
        return Err(PreviewError::StaleObject);
    }
    let document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    if !document
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        || !document.signatures().is_empty()
    {
        return Err(PreviewError::UnsupportedText);
    }
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let mut page = document
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let before = text::extract_for_verification(&document, &page, &config);
    for id in ids {
        let object = before
            .objects
            .iter()
            .find(|o| o.id == *id)
            .ok_or(PreviewError::StaleObject)?;
        if object.font_change_blocked.is_some() {
            return Err(PreviewError::UnsupportedText);
        }
    }
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    for id in ids.iter().rev() {
        page.objects_mut()
            .remove_object_at_index(*id)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = document
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    let bytes =
        crate::text_spacing::preserve(pdfium, original, bytes, index, &before.objects, ids, 0)?;
    verify(pdfium, original, &bytes, index, ids, &[], None, &config)?;
    Ok(bytes)
}

fn patch_short_edit(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    group: &TextGroup,
    value: &str,
    objects: &[TextObject],
    config: &PdfRenderConfig,
) -> Option<Vec<u8>> {
    let old: Vec<char> = group.text.chars().collect();
    let new: Vec<char> = value.chars().collect();
    if old.len() != new.len() || old == new {
        return None;
    }
    let start = old.iter().zip(&new).position(|(a, b)| a != b)?;
    let end = old.iter().zip(&new).rposition(|(a, b)| a != b)? + 1;
    if end - start > 32 {
        return None;
    }
    let run = group
        .runs
        .iter()
        .find(|r| r.start <= start && r.end >= end && r.object_start == 0)?;
    let source = objects.iter().find(|o| o.id == run.object)?;
    if run.end - run.start != source.text.chars().count() {
        return None;
    }
    let text: String = new[run.start..run.end].iter().collect();
    let bytes = crate::text_patch::patch(original, index, objects, source.id, &text)?;
    let doc = pdfium.load_pdf_from_byte_vec(bytes.clone(), None).ok()?;
    let page = doc.pages().get(index).ok()?;
    let after = text::extract_for_verification(&doc, &page, config);
    let target = after.objects.iter().find(|o| o.id == source.id)?;
    let a = rect(&source.bounds);
    let b = rect(&target.bounds);
    // This path is for edits that fit the old ink area. Wider edits use reflow.
    if b[0] < a[0] - 0.5 || b[1] < a[1] - 0.5 || b[2] > a[2] + 0.5 || b[3] > a[3] + 0.5 {
        return None;
    }
    drop(page);
    drop(doc);
    verify(
        pdfium,
        original,
        &bytes,
        index,
        &BTreeSet::from([source.id]),
        &[(text, source.clone(), source.matrix[4], source.matrix[5])],
        None,
        config,
    )
    .ok()?;
    Some(bytes)
}

fn verify(
    pdfium: &Pdfium,
    original: &[u8],
    bytes: &[u8],
    index: i32,
    ids: &BTreeSet<usize>,
    expected: &[(String, TextObject, f32, f32)],
    movement: Option<(&BTreeSet<usize>, f32)>,
    config: &PdfRenderConfig,
) -> Result<(), PreviewError> {
    let old = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let new = pdfium
        .load_pdf_from_byte_vec(bytes.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if old.pages().len() != new.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    let structural = lopdf::Document::load_mem(original)
        .ok()
        .zip(lopdf::Document::load_mem(bytes).ok());
    for i in 0..old.pages().len() {
        if i != index
            && structural.as_ref().is_some_and(|(a, b)| {
                crate::pages::unchanged_page(a, b, i as u32 + 1, i as u32 + 1)
            })
        {
            continue;
        }
        let a = old
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let b = new
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let ta = text::extract_for_verification(&old, &a, config);
        let tb = text::extract_for_verification(&new, &b, config);
        let stored = if i == index {
            crate::text_spacing::stored_text(bytes, i, tb.objects.len())
        } else {
            None
        };
        let mut changed = BTreeSet::new();
        let mut regions = Vec::new();
        if i == index {
            for (value, style, x, y) in expected {
                let candidates: Vec<_> = tb
                    .objects
                    .iter()
                    .enumerate()
                    .filter(|(ordinal, o)| {
                        (o.text.trim_end() == value
                            || stored
                                .as_ref()
                                .and_then(|v| v.get(*ordinal))
                                .is_some_and(|s| s.trim_end() == value))
                            && o.font == style.font
                            && o.color == style.color
                            && (o.font_size - style.font_size).abs() < 0.01
                            && o.matrix[..4]
                                .iter()
                                .zip(&style.matrix[..4])
                                .all(|(a, b)| (*a - *b).abs() < 0.00001)
                            && (o.matrix[4] - x).abs() < 0.01
                            && (o.matrix[5] - y).abs() < 0.01
                    })
                    .map(|(_, o)| o)
                    .collect();
                if candidates.len() != 1 || !changed.insert(candidates[0].id) {
                    return Err(PreviewError::ChangedTextMismatch);
                }
                if let Some((following, dy)) = movement {
                    if following.contains(&style.id)
                        && style.bounds.iter().zip(candidates[0].bounds).any(|(p, q)| {
                            (p[0] - q[0]).abs() > 0.02 || (p[1] + dy - q[1]).abs() > 0.02
                        })
                    {
                        return Err(PreviewError::ChangedTextMismatch);
                    }
                }
                regions.push(candidates[0].screen_bounds);
            }
            regions.extend(
                ta.objects
                    .iter()
                    .filter(|o| ids.contains(&o.id))
                    .map(|o| o.screen_bounds),
            );
            if let Some((following, dy)) = movement {
                let old_graphics = text::extract_graphics(&a, config);
                let new_graphics = text::extract_graphics(&b, config);
                if old_graphics.len() != new_graphics.len() {
                    return Err(PreviewError::VerificationFailed);
                }
                for (old, new) in old_graphics.iter().zip(&new_graphics) {
                    let shift = if following.contains(&old.id) { dy } else { 0.0 };
                    let old_object = a
                        .objects()
                        .get(old.id)
                        .map_err(|_| PreviewError::VerificationFailed)?;
                    let new_object = b
                        .objects()
                        .get(new.id)
                        .map_err(|_| PreviewError::VerificationFailed)?;
                    let om = old_object
                        .matrix()
                        .map_err(|_| PreviewError::VerificationFailed)?;
                    let nm = new_object
                        .matrix()
                        .map_err(|_| PreviewError::VerificationFailed)?;
                    if old.kind != new.kind
                        || old.bounds.iter().zip(new.bounds).any(|(p, q)| {
                            (p[0] - q[0]).abs() > 0.02 || (p[1] + shift - q[1]).abs() > 0.02
                        })
                        || [
                            om.a() - nm.a(),
                            om.b() - nm.b(),
                            om.c() - nm.c(),
                            om.d() - nm.d(),
                            om.e() - nm.e(),
                            om.f() + shift - nm.f(),
                        ]
                        .iter()
                        .any(|d| d.abs() > 0.001)
                    {
                        return Err(PreviewError::VerificationFailed);
                    }
                    if following.contains(&old.id) {
                        regions.extend([old.screen_bounds, new.screen_bounds]);
                    }
                }
            }
        }
        let normalize = |objects: Vec<TextObject>, exclude: &BTreeSet<usize>| {
            objects
                .into_iter()
                .filter(|o| !exclude.contains(&o.id))
                .map(|mut o| {
                    o.id = 0;
                    o.font_object_id = 0; // Page-local cache identity changes when objects are replaced.
                    o.text = o.text.trim_end_matches(' ').to_owned();
                    o
                })
                .collect::<Vec<_>>()
        };
        let empty = BTreeSet::new();
        let left = normalize(ta.objects, if i == index { ids } else { &empty });
        let right = normalize(tb.objects, &changed);
        if ta.warning != tb.warning || left != right {
            return Err(PreviewError::UnchangedTextModified);
        }
        let a = a
            .render_with_config(config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let b = b
            .render_with_config(config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if a.width() != b.width() || a.height() != b.height() {
            return Err(PreviewError::VerificationFailed);
        }
        if !crate::verification::unchanged_outside(
            &a.as_rgba_bytes(),
            &b.as_rgba_bytes(),
            a.width() as usize,
            &regions,
        ) {
            return Err(PreviewError::OutsideEditModified);
        }
    }
    Ok(())
}
