//! Translate complete text objects without changing fonts or rebuilding text.
use crate::{error::EngineError as PreviewError, layout, text};
use pdfium_render::prelude::*;
use std::collections::BTreeSet;

pub(crate) fn translate(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    group: Option<usize>,
    object: Option<usize>,
    dx: f32,
    dy: f32,
) -> Result<Vec<u8>, PreviewError> {
    if !dx.is_finite() || !dy.is_finite() || group.is_some() == object.is_some() {
        return Err(PreviewError::UnsupportedText);
    }
    let document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let config = PdfRenderConfig::new()
        .set_target_width(800)
        .set_maximum_height(2200);
    let page = document
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    let mut before = text::extract(&document, &page, &config);
    layout::reconstruct(&page, &config, &mut before);
    let ids: BTreeSet<usize> = if let Some(id) = group {
        let g = before
            .groups
            .iter()
            .find(|g| g.id == id)
            .ok_or(PreviewError::StaleObject)?;
        if g.uncertain {
            return Err(PreviewError::UnsupportedText);
        }
        for run in &g.runs {
            let o = before
                .objects
                .iter()
                .find(|o| o.id == run.object)
                .ok_or(PreviewError::StaleObject)?;
            if run.object_start != 0
                || run.end - run.start < o.text.trim_end().chars().count()
                || g.runs.iter().filter(|r| r.object == run.object).count() != 1
            {
                return Err(PreviewError::UnsupportedText);
            }
        }
        g.runs.iter().map(|r| r.object).collect()
    } else {
        BTreeSet::from([object.unwrap()])
    };
    if ids.is_empty() {
        return Err(PreviewError::UnsupportedText);
    }
    let mut regions = Vec::new();
    // width()/height() describe the rotated display. Object matrices are in
    // unrotated PDF coordinates, including nonzero MediaBox/CropBox origins.
    let media = page
        .boundaries()
        .media()
        .map_err(|_| PreviewError::UnsupportedText)?
        .bounds;
    let crop = page.boundaries().crop().map(|b| b.bounds).unwrap_or(media);
    let left = media.left().value.max(crop.left().value);
    let right = media.right().value.min(crop.right().value);
    let bottom = media.bottom().value.max(crop.bottom().value);
    let top = media.top().value.min(crop.top().value);
    for id in &ids {
        let o = before
            .objects
            .iter()
            .find(|o| o.id == *id)
            .ok_or(PreviewError::StaleObject)?;
        if o.font_change_blocked.is_some() {
            return Err(PreviewError::UnsupportedText);
        }
        let mut old_pixels = Vec::new();
        let mut new_pixels = Vec::new();
        for [x, y] in o.bounds {
            if x + dx < left || y + dy < bottom || x + dx > right || y + dy > top {
                return Err(PreviewError::TextOverflow);
            }
            old_pixels.push(
                page.points_to_pixels(PdfPoints::new(x), PdfPoints::new(y), &config)
                    .map_err(|_| PreviewError::EditFailed)?,
            );
            new_pixels.push(
                page.points_to_pixels(PdfPoints::new(x + dx), PdfPoints::new(y + dy), &config)
                    .map_err(|_| PreviewError::EditFailed)?,
            );
        }
        for points in [old_pixels, new_pixels] {
            regions.push((
                points.iter().map(|p| p.0).min().unwrap() - 3,
                points.iter().map(|p| p.1).min().unwrap() - 3,
                points.iter().map(|p| p.0).max().unwrap() + 3,
                points.iter().map(|p| p.1).max().unwrap() + 3,
            ));
        }
    }
    drop(page);
    let bytes = crate::move_stream::translate(original, index, &before.objects, &ids, dx, dy)?;
    let reopened = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if reopened.pages().len() != baseline.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    // move_stream checks every serialized PDF object. Rasterize and inspect
    // only the modified page instead of rendering the entire document twice.
    for i in [index] {
        let old_page = baseline
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let new_page = reopened
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let old = &before;
        let new = text::extract(&reopened, &new_page, &config);
        if old.warning != new.warning || old.objects.len() != new.objects.len() {
            return Err(PreviewError::VerificationFailed);
        }
        for (a, b) in old.objects.iter().zip(&new.objects) {
            let mut a = a.clone();
            let mut b = b.clone();
            // Reading-order changes can add/remove PDFium's synthetic word space.
            a.text = a.text.trim_end_matches(' ').to_owned();
            b.text = b.text.trim_end_matches(' ').to_owned();
            let moved = i == index && ids.contains(&a.id);
            if !moved && a != b {
                return Err(PreviewError::VerificationFailed);
            }
            if moved
                && (a.id != b.id
                    || a.text != b.text
                    || a.font != b.font
                    || a.font_size != b.font_size
                    || a.color != b.color
                    || a.matrix[..4] != b.matrix[..4]
                    || (a.matrix[4] + dx - b.matrix[4]).abs() > 0.01
                    || (a.matrix[5] + dy - b.matrix[5]).abs() > 0.01
                    || a.bounds.iter().zip(b.bounds).any(|(p, q)| {
                        (p[0] + dx - q[0]).abs() > 0.02 || (p[1] + dy - q[1]).abs() > 0.02
                    }))
            {
                return Err(PreviewError::VerificationFailed);
            }
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
        for (n, (x, y)) in a
            .as_rgba_bytes()
            .chunks_exact(4)
            .zip(b.as_rgba_bytes().chunks_exact(4))
            .enumerate()
        {
            let px = n as i32 % a.width();
            let py = n as i32 / a.width();
            if x != y
                && (i != index
                    || !regions
                        .iter()
                        .any(|&(x0, y0, x1, y1)| px >= x0 && px <= x1 && py >= y0 && py <= y1))
            {
                return Err(PreviewError::VerificationFailed);
            }
        }
    }
    Ok(bytes)
}
