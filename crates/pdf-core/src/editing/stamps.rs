//! Centered transparent image stamps, committed as one edit across all target pages.
use crate::{engine::error::EngineError, text};
use pdfium_render::prelude::*;

struct Change {
    page: i32,
    count: usize,
    region: [[i32; 2]; 4],
    objects: Vec<text::TextObject>,
}

// None for width_ratio inserts a signature with a 144 × 72 pt bounding box.
// A watermark's width is relative to each visible, rotated/cropped page.
pub(super) fn insert(
    pdfium: &Pdfium,
    original: &[u8],
    index: Option<i32>,
    png: &[u8],
    width_ratio: Option<f32>,
) -> Result<Vec<u8>, EngineError> {
    if width_ratio.is_some_and(|ratio| !ratio.is_finite() || !(0.1..=0.9).contains(&ratio)) {
        return Err(EngineError::UnsupportedText);
    }
    let cleaned;
    let original = if width_ratio.is_some() {
        cleaned = remove(pdfium, original, index)?;
        cleaned.as_slice()
    } else {
        original
    };
    let document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| EngineError::EditFailed)?;
    if !document
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        || !document.signatures().is_empty()
    {
        return Err(EngineError::UnsupportedText);
    }
    if index.is_some_and(|page| page < 0 || page >= document.pages().len()) {
        return Err(EngineError::InvalidPage);
    }
    let targets: Vec<_> = match index {
        Some(page) => vec![page],
        None => (0..document.pages().len()).collect(),
    };
    if targets.is_empty() {
        return Err(EngineError::InvalidPage);
    }
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let mut changes = Vec::with_capacity(targets.len());
    for index in targets {
        let mut object = super::graphics::image_from_png(&document, png)?;
        let mut page = document
            .pages()
            .get(index)
            .map_err(|_| EngineError::InvalidPage)?;
        let before = text::extract_for_verification(&document, &page, &config);
        let bounds = object.bounds().map_err(|_| EngineError::EditFailed)?;
        let aspect = bounds.width().value / bounds.height().value;
        let bitmap = page
            .render_with_config(&config)
            .map_err(|_| EngineError::EditFailed)?;
        let width = bitmap.width() as f32;
        let height = bitmap.height() as f32;
        drop(bitmap);
        let desired = match width_ratio {
            Some(ratio) => width * ratio,
            None => {
                let pixels_per_point = width / page.width().value;
                (144.0 * pixels_per_point).min(72.0 * pixels_per_point * aspect)
            }
        };
        let stamp_width = desired.min(width * 0.9).min(height * 0.8 * aspect).round() as i32;
        let stamp_height = (stamp_width as f32 / aspect).round() as i32;
        if stamp_width < 1 || stamp_height < 1 {
            return Err(EngineError::PageOverflow);
        }
        let left = ((width as i32 - stamp_width) / 2).max(0);
        let top = ((height as i32 - stamp_height) / 2).max(0);
        let right = left + stamp_width;
        let bottom = top + stamp_height;
        // Device coordinates account for page rotation and nonzero crop origins.
        let convert = |x, y| {
            page.pixels_to_points(x, y, &config)
                .map_err(|_| EngineError::EditFailed)
        };
        let (x, y) = convert(left, bottom)?;
        let (right_x, right_y) = convert(right, bottom)?;
        let (top_x, top_y) = convert(left, top)?;
        object
            .reset_matrix(PdfMatrix::new(
                right_x.value - x.value,
                right_y.value - y.value,
                top_x.value - x.value,
                top_y.value - y.value,
                x.value,
                y.value,
            ))
            .map_err(|_| EngineError::EditFailed)?;
        let count = page.objects().len();
        page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
        page.objects_mut()
            .add_object(object)
            .map_err(|_| EngineError::EditFailed)?;
        page.regenerate_content()
            .map_err(|_| EngineError::EditFailed)?;
        changes.push(Change {
            page: index,
            count,
            region: [[left, top], [right, top], [right, bottom], [left, bottom]],
            objects: before.objects,
        });
    }
    let mut bytes = document
        .save_to_bytes()
        .map_err(|_| EngineError::EditFailed)?;
    for change in &changes {
        bytes = crate::content_stream::text_spacing::preserve(
            pdfium,
            original,
            bytes,
            change.page,
            &change.objects,
            &Default::default(),
            0,
        )?;
    }
    if width_ratio.is_some() {
        bytes = crate::content_stream::watermarks::tag(
            &bytes,
            &changes.iter().map(|change| change.page).collect::<Vec<_>>(),
        )?;
    }
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| EngineError::VerificationFailed)?;
    let reopened = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| EngineError::VerificationFailed)?;
    if baseline.pages().len() != reopened.pages().len() {
        return Err(EngineError::VerificationFailed);
    }
    for index in 0..baseline.pages().len() {
        let old = baseline
            .pages()
            .get(index)
            .map_err(|_| EngineError::VerificationFailed)?;
        let new = reopened
            .pages()
            .get(index)
            .map_err(|_| EngineError::VerificationFailed)?;
        let change = changes.iter().find(|change| change.page == index);
        if change.is_some_and(|change| new.objects().len() != change.count + 1) {
            return Err(EngineError::VerificationFailed);
        }
        let a = old
            .render_with_config(&config)
            .map_err(|_| EngineError::VerificationFailed)?;
        let b = new
            .render_with_config(&config)
            .map_err(|_| EngineError::VerificationFailed)?;
        if a.width() != b.width()
            || a.height() != b.height()
            || !super::verification::unchanged_outside(
                &a.as_rgba_bytes(),
                &b.as_rgba_bytes(),
                a.width() as usize,
                change
                    .map(|change| std::slice::from_ref(&change.region))
                    .unwrap_or(&[]),
            )
        {
            return Err(EngineError::OutsideEditModified);
        }
    }
    Ok(bytes)
}

pub(super) fn remove(
    pdfium: &Pdfium,
    original: &[u8],
    index: Option<i32>,
) -> Result<Vec<u8>, EngineError> {
    use crate::content_stream::watermarks;
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| EngineError::EditFailed)?;
    if !baseline
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        || !baseline.signatures().is_empty()
    {
        return Err(EngineError::UnsupportedText);
    }
    if index.is_some_and(|page| page < 0 || page >= baseline.pages().len()) {
        return Err(EngineError::InvalidPage);
    }
    let targets: Vec<_> = watermarks::pages(original)
        .into_iter()
        .filter(|page| index.is_none_or(|index| index == *page))
        .collect();
    if targets.is_empty() {
        return Ok(original.to_vec());
    }
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let bytes = watermarks::remove(original, &targets)?;
    let candidate = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| EngineError::VerificationFailed)?;
    for index in targets {
        let old = baseline
            .pages()
            .get(index)
            .map_err(|_| EngineError::InvalidPage)?;
        let new = candidate
            .pages()
            .get(index)
            .map_err(|_| EngineError::VerificationFailed)?;
        let (marked, count) = watermarks::draws(original, index)?;
        let draws: Vec<_> = old
            .objects()
            .iter()
            .enumerate()
            .filter(|(_, object)| {
                object.as_image_object().is_some() || object.as_x_object_form_object().is_some()
            })
            .collect();
        // Refuse ambiguous mappings (for example inline images) instead of deleting unrelated content.
        if draws.len() != count || new.objects().len() + marked.len() != old.objects().len() {
            return Err(EngineError::VerificationFailed);
        }
        let graphics = text::extract_graphics(&old, &config);
        let mut regions = Vec::new();
        for ordinal in marked {
            let (id, object) = &draws[ordinal];
            if object.as_image_object().is_none() {
                return Err(EngineError::VerificationFailed);
            }
            regions.push(
                graphics
                    .iter()
                    .find(|graphic| graphic.id == *id)
                    .ok_or(EngineError::VerificationFailed)?
                    .screen_bounds,
            );
        }
        let old_text = text::extract_for_verification(&baseline, &old, &config);
        let new_text = text::extract_for_verification(&candidate, &new, &config);
        if old_text.objects.len() != new_text.objects.len()
            || old_text
                .objects
                .iter()
                .zip(&new_text.objects)
                .any(|(a, b)| {
                    a.text != b.text
                        || a.bounds != b.bounds
                        || a.matrix != b.matrix
                        || a.font != b.font
                        || a.color != b.color
                })
        {
            return Err(EngineError::VerificationFailed);
        }
        let a = old
            .render_with_config(&config)
            .map_err(|_| EngineError::VerificationFailed)?;
        let b = new
            .render_with_config(&config)
            .map_err(|_| EngineError::VerificationFailed)?;
        if a.width() != b.width()
            || a.height() != b.height()
            || !super::verification::unchanged_outside(
                &a.as_rgba_bytes(),
                &b.as_rgba_bytes(),
                a.width() as usize,
                &regions,
            )
        {
            return Err(EngineError::OutsideEditModified);
        }
    }
    Ok(bytes)
}
