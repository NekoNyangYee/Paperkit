use crate::{engine::error::EngineError as PreviewError, text};
use pdfium_render::prelude::*;

/// A single-page, tightly cropped PDF is the clipboard format. It keeps paths,
/// alpha masks, shading and nested forms instead of flattening them to pixels.
pub(crate) fn copy(
    pdfium: &Pdfium,
    source: &PdfDocument<'_>,
    index: i32,
    id: usize,
) -> Result<Vec<u8>, PreviewError> {
    if !source
        .permissions()
        .can_extract_text_and_graphics()
        .unwrap_or(false)
    {
        return Err(PreviewError::UnsupportedText);
    }
    let mut document = pdfium
        .create_new_pdf()
        .map_err(|_| PreviewError::EditFailed)?;
    document
        .pages_mut()
        .copy_page_from_document(source, index, 0)
        .map_err(|_| PreviewError::InvalidPage)?;
    let mut page = document
        .pages()
        .get(0)
        .map_err(|_| PreviewError::InvalidPage)?;
    let object = page
        .objects()
        .get(id)
        .map_err(|_| PreviewError::StaleObject)?;
    if object.as_text_object().is_some() {
        return Err(PreviewError::UnsupportedText);
    }
    let bounds = object.bounds().map_err(|_| PreviewError::EditFailed)?;
    let width = bounds.width().value;
    let height = bounds.height().value;
    if width <= 0.0 || height <= 0.0 {
        return Err(PreviewError::UnsupportedText);
    }
    drop(object);
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    for other in (0..page.objects().len()).rev().filter(|i| *i != id) {
        page.objects_mut()
            .remove_object_at_index(other)
            .map_err(|_| PreviewError::EditFailed)?;
    }
    page.objects_mut()
        .get(0)
        .map_err(|_| PreviewError::EditFailed)?
        .translate(-bounds.left(), -bounds.bottom())
        .map_err(|_| PreviewError::EditFailed)?;
    let rect = PdfRect::new(
        PdfPoints::ZERO,
        PdfPoints::ZERO,
        PdfPoints::new(height),
        PdfPoints::new(width),
    );
    page.boundaries_mut()
        .set_media(rect)
        .map_err(|_| PreviewError::EditFailed)?;
    page.boundaries_mut()
        .set_crop(rect)
        .map_err(|_| PreviewError::EditFailed)?;
    page.set_rotation(PdfPageRenderRotation::None);
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = document
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(PreviewError::TooLarge);
    }
    Ok(bytes)
}

pub(crate) fn paste(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    source: &[u8],
) -> Result<Vec<u8>, PreviewError> {
    if source.len() > 32 * 1024 * 1024 {
        return Err(PreviewError::TooLarge);
    }
    let source = pdfium
        .load_pdf_from_byte_vec(source.to_vec(), None)
        .map_err(|_| PreviewError::InvalidDocument)?;
    if source.pages().len() != 1 {
        return Err(PreviewError::UnsupportedText);
    }
    let page = source
        .pages()
        .get(0)
        .map_err(|_| PreviewError::InvalidPage)?;
    let mut document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let object = page
        .objects()
        .copy_into_x_object_form_object(&mut document)
        .map_err(|_| PreviewError::EditFailed)?;
    insert(pdfium, original, &document, index, object)
}

pub(crate) fn paste_image(
    pdfium: &Pdfium,
    original: &[u8],
    index: i32,
    png: &[u8],
) -> Result<Vec<u8>, PreviewError> {
    let document = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::EditFailed)?;
    let object = image_from_png(&document, png)?;
    insert(pdfium, original, &document, index, object)
}

pub(super) fn image_from_png<'a>(
    document: &PdfDocument<'a>,
    png: &[u8],
) -> Result<PdfPageObject<'a>, PreviewError> {
    let (width, height, mut bgra) = png_pixels(png)?;
    let bitmap = PdfBitmap::from_bytes(
        width as i32,
        height as i32,
        PdfBitmapFormat::BGRA,
        &mut bgra,
    )
    .map_err(|_| PreviewError::EditFailed)?;
    let mut object = PdfPageImageObject::new(document).map_err(|_| PreviewError::EditFailed)?;
    object
        .set_bitmap(&bitmap)
        .map_err(|_| PreviewError::EditFailed)?;
    // Image objects use a unit square, independent of their pixel dimensions.
    object
        .reset_matrix(PdfMatrix::new(
            width as f32,
            0.0,
            0.0,
            height as f32,
            0.0,
            0.0,
        ))
        .map_err(|_| PreviewError::EditFailed)?;
    Ok(object.into())
}

pub(super) fn png_pixels(png: &[u8]) -> Result<(u32, u32, Vec<u8>), PreviewError> {
    if png.len() > 32 * 1024 * 1024 {
        return Err(PreviewError::TooLarge);
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|_| PreviewError::UnsupportedText)?;
    let size = reader
        .output_buffer_size()
        .filter(|s| *s <= 64 * 1024 * 1024)
        .ok_or(PreviewError::TooLarge)?;
    let mut pixels = vec![0; size];
    let info = reader
        .next_frame(&mut pixels)
        .map_err(|_| PreviewError::UnsupportedText)?;
    if info.width == 0
        || info.height == 0
        || u64::from(info.width) * u64::from(info.height) > 16 * 1024 * 1024
    {
        return Err(PreviewError::TooLarge);
    }
    let channels = info.color_type.samples();
    let mut bgra = Vec::with_capacity(info.width as usize * info.height as usize * 4);
    for p in pixels[..info.buffer_size()].chunks_exact(channels) {
        let (r, g, b, a) = match info.color_type {
            png::ColorType::Rgb => (p[0], p[1], p[2], 255),
            png::ColorType::Rgba => (p[0], p[1], p[2], p[3]),
            png::ColorType::Grayscale => (p[0], p[0], p[0], 255),
            png::ColorType::GrayscaleAlpha => (p[0], p[0], p[0], p[1]),
            _ => return Err(PreviewError::UnsupportedText),
        };
        bgra.extend_from_slice(&[b, g, r, a]);
    }
    Ok((info.width, info.height, bgra))
}

fn insert<'a>(
    pdfium: &Pdfium,
    original: &[u8],
    document: &PdfDocument<'a>,
    index: i32,
    mut object: PdfPageObject<'a>,
) -> Result<Vec<u8>, PreviewError> {
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
    let before = text::extract_for_verification(document, &page, &config);
    let media = page
        .boundaries()
        .media()
        .map_err(|_| PreviewError::EditFailed)?
        .bounds;
    let crop = page.boundaries().crop().map(|b| b.bounds).unwrap_or(media);
    let left = media.left().value.max(crop.left().value);
    let top = media.top().value.min(crop.top().value);
    let width = media.right().value.min(crop.right().value) - left;
    let height = top - media.bottom().value.max(crop.bottom().value);
    let bounds = object.bounds().map_err(|_| PreviewError::EditFailed)?;
    let scale = (width * 0.8 / bounds.width().value)
        .min(height * 0.8 / bounds.height().value)
        .min(1.0);
    if !scale.is_finite() || scale <= 0.0 {
        return Err(PreviewError::PageOverflow);
    }
    object
        .transform(
            scale,
            0.0,
            0.0,
            scale,
            left + width * 0.05 - bounds.left().value * scale,
            top - height * 0.05 - bounds.top().value * scale,
        )
        .map_err(|_| PreviewError::EditFailed)?;
    let bounds = object.bounds().map_err(|_| PreviewError::EditFailed)?;
    let mut region = [[0; 2]; 4];
    for (i, (x, y)) in [
        (bounds.left(), bounds.bottom()),
        (bounds.right(), bounds.bottom()),
        (bounds.right(), bounds.top()),
        (bounds.left(), bounds.top()),
    ]
    .into_iter()
    .enumerate()
    {
        let (x, y) = page
            .points_to_pixels(x, y, &config)
            .map_err(|_| PreviewError::EditFailed)?;
        region[i] = [x, y];
    }
    page.set_content_regeneration_strategy(PdfPageContentRegenerationStrategy::Manual);
    let count = page.objects().len();
    page.objects_mut()
        .add_object(object)
        .map_err(|_| PreviewError::EditFailed)?;
    page.regenerate_content()
        .map_err(|_| PreviewError::EditFailed)?;
    drop(page);
    let bytes = document
        .save_to_bytes()
        .map_err(|_| PreviewError::EditFailed)?;
    let bytes = crate::content_stream::text_spacing::preserve(
        pdfium,
        original,
        bytes,
        index,
        &before.objects,
        &Default::default(),
        0,
    )?;
    let baseline = pdfium
        .load_pdf_from_byte_vec(original.to_vec(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    let reopened = pdfium
        .load_pdf_from_byte_vec(bytes.clone(), None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if baseline.pages().len() != reopened.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    for i in 0..baseline.pages().len() {
        let old = baseline
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let new = reopened
            .pages()
            .get(i)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if i == index && new.objects().len() != count + 1 {
            return Err(PreviewError::VerificationFailed);
        }
        let a = old
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let b = new
            .render_with_config(&config)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if a.width() != b.width()
            || a.height() != b.height()
            || !crate::editing::verification::unchanged_outside(
                &a.as_rgba_bytes(),
                &b.as_rgba_bytes(),
                a.width() as usize,
                if i == index {
                    std::slice::from_ref(&region)
                } else {
                    &[]
                },
            )
        {
            return Err(PreviewError::OutsideEditModified);
        }
    }
    Ok(bytes)
}

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
    let bytes = crate::content_stream::text_spacing::preserve(
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
        let allowed = if i == index { regions.as_slice() } else { &[] };
        if !crate::editing::verification::unchanged_outside(
            &a.as_rgba_bytes(),
            &b.as_rgba_bytes(),
            a.width() as usize,
            allowed,
        ) {
            return Err(PreviewError::OutsideEditModified);
        }
    }
    Ok(bytes)
}
