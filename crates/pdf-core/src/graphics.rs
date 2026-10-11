use crate::{render::PreviewError, text};
use pdfium_render::prelude::*;

/// Work on a private document; publish only after reopening and checking pixels.
pub(crate) fn edit(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    id: usize,
    matrix: Option<[f32; 6]>,
) -> Result<Vec<u8>, PreviewError> {
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
    let before = text::extract(&document, &page, &config);
    let graphic = before
        .graphics
        .iter()
        .find(|g| g.id == id)
        .ok_or(PreviewError::StaleObject)?;
    let mut regions = vec![graphic.screen_bounds];
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    if let Some(m) = matrix {
        if m.iter().any(|v| !v.is_finite()) || m[0] * m[3] - m[1] * m[2] <= 0.00001 {
            return Err(PreviewError::UnsupportedText);
        }
        let media = page
            .boundaries()
            .media()
            .map_err(|_| PreviewError::EditFailed)?
            .bounds;
        let crop = page.boundaries().crop().map(|b| b.bounds).unwrap_or(media);
        let mut pixels = [[0; 2]; 4];
        for (i, [x, y]) in graphic.bounds.iter().copied().enumerate() {
            let x1 = m[0] * x + m[2] * y + m[4];
            let y1 = m[1] * x + m[3] * y + m[5];
            if x1 < crop.left().value.max(media.left().value) - 0.5
                || x1 > crop.right().value.min(media.right().value) + 0.5
                || y1 < crop.bottom().value.max(media.bottom().value) - 0.5
                || y1 > crop.top().value.min(media.top().value) + 0.5
            {
                return Err(PreviewError::PageOverflow);
            }
            let (px, py) = page
                .points_to_pixels(PdfPoints::new(x1), PdfPoints::new(y1), &config)
                .map_err(|_| PreviewError::EditFailed)?;
            pixels[i] = [px, py];
        }
        regions.push(pixels);
        page.objects_mut()
            .get(id)
            .map_err(|_| PreviewError::StaleObject)?
            .transform(m[0], m[1], m[2], m[3], m[4], m[5])
            .map_err(|_| PreviewError::EditFailed)?;
    } else {
        page.objects_mut()
            .remove_object_at_index(id)
            .map_err(|_| PreviewError::StaleObject)?;
    }
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = document
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    let bytes = crate::text_spacing::preserve(
        pdfium,
        original,
        bytes,
        index,
        &before.objects,
        &Default::default(),
        0,
    )?;
    let old = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let new = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if old.pages().len() != new.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    {
        let p = new
            .pages()
            .get(index)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let after = text::extract(&new, &p, &config);
        let expected_count = before.graphics.len() - usize::from(matrix.is_none());
        if after.graphics.len() != expected_count {
            return Err(PreviewError::VerificationFailed);
        }
        if let Some(m) = matrix {
            let target = after
                .graphics
                .iter()
                .find(|g| g.id == id && g.kind == graphic.kind)
                .ok_or(PreviewError::VerificationFailed)?;
            for (a, b) in graphic.bounds.iter().zip(target.bounds) {
                if (m[0] * a[0] + m[2] * a[1] + m[4] - b[0]).abs() > 0.1
                    || (m[1] * a[0] + m[3] * a[1] + m[5] - b[1]).abs() > 0.1
                {
                    return Err(PreviewError::VerificationFailed);
                }
            }
        }
    }
    for i in 0..old.pages().len() {
        let old_page = old
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let new_page = new
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
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
                    || !regions.iter().any(|q| {
                        px >= q.iter().map(|p| p[0]).min().unwrap() - 3
                            && px <= q.iter().map(|p| p[0]).max().unwrap() + 3
                            && py >= q.iter().map(|p| p[1]).min().unwrap() - 3
                            && py <= q.iter().map(|p| p[1]).max().unwrap() + 3
                    }))
            {
                return Err(PreviewError::VerificationFailed);
            }
        }
    }
    Ok(bytes)
}
