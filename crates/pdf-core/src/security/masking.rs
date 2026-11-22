use crate::EngineError;
use lopdf::{dictionary, Document, Object, Stream};
use pdfium_render::prelude::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub page: i32,
    pub x: f64,
    pub y: f64,
    pub right: f64,
    pub bottom: f64,
    pub stars: bool,
    #[serde(default)]
    pub blur: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct TextMask {
    pub page: i32,
    pub object: usize,
    // Offsets count Unicode scalar values in the original text object.
    pub start: usize,
    pub end: usize,
}

pub(crate) fn with_text_masks<T>(
    pdfium: &Pdfium,
    source: &PdfDocument,
    masks: &[TextMask],
    font_directory: &Path,
    render: impl FnOnce(&PdfDocument) -> Result<T, EngineError>,
) -> Result<T, EngineError> {
    if masks.is_empty() {
        return render(source);
    }
    if masks.len() > 2048 {
        return Err(EngineError::TooLarge);
    }
    if !source
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        || !source
            .permissions()
            .can_extract_text_and_graphics()
            .unwrap_or(false)
    {
        return Err(EngineError::UnsupportedText);
    }
    let mut groups = std::collections::BTreeMap::new();
    for m in masks {
        groups
            .entry((m.page, m.object))
            .or_insert_with(Vec::new)
            .push((m.start, m.end));
    }
    let mut bytes = source
        .save_to_bytes()
        .map_err(|_| EngineError::SaveFailed)?;
    for ((index, id), mut ranges) in groups {
        let page = source
            .pages()
            .get(index)
            .map_err(|_| EngineError::InvalidPage)?;
        let object = page
            .objects()
            .get(id.try_into().map_err(|_| EngineError::StaleObject)?)
            .map_err(|_| EngineError::StaleObject)?;
        let text = page
            .text()
            .map_err(|_| EngineError::UnsupportedText)?
            .for_object(
                object
                    .as_text_object()
                    .ok_or(EngineError::UnsupportedText)?,
            );
        let chars: Vec<_> = text.chars().collect();
        ranges.sort_unstable();
        let mut from = 0;
        let mut replacement = String::new();
        for (start, end) in ranges {
            if start < from || start >= end || end > chars.len() {
                return Err(EngineError::StaleObject);
            }
            replacement.extend(&chars[from..start]);
            replacement.push_str("**");
            from = end;
        }
        replacement.extend(&chars[from..]);
        let replace = crate::editing::replace_text_object;
        bytes = match replace(pdfium, &bytes, index, id, Some(&replacement), None) {
            Err(
                EngineError::MissingGlyph
                | EngineError::FontUnavailable
                | EngineError::UnsupportedText,
            ) => replace(
                pdfium,
                &bytes,
                index,
                id,
                Some(&replacement),
                Some((font_directory, "pretendard")),
            )?,
            result => result?,
        };
    }
    let candidate = pdfium
        .load_pdf_from_byte_vec(bytes, None)
        .map_err(|_| EngineError::VerificationFailed)?;
    render(&candidate)
}

impl Mask {
    fn valid(&self, count: i32) -> bool {
        (0..count).contains(&self.page)
            && self.x >= 0.0
            && self.x < self.right
            && self.right <= 1.0
            && self.y >= 0.0
            && self.y < self.bottom
            && self.bottom <= 1.0
    }

    fn paint(&self, rgb: &mut [u8], source_rgba: &[u8], width: usize, height: usize) {
        // Round outwards so a partially covered source pixel is also erased.
        let left = (self.x * width as f64).floor() as usize;
        let right = (self.right * width as f64).ceil() as usize;
        let top = (self.y * height as f64).floor() as usize;
        let bottom = (self.bottom * height as f64).ceil() as usize;
        if self.blur && !self.stars {
            blur_region(rgb, source_rgba, width, left..right, top..bottom);
            return;
        }
        let cell = ((right - left) as f64 / 4.0).min((bottom - top) as f64);
        let mid = (left + right) as f64 / 2.0;
        for y in top..bottom {
            let row = &mut rgb[(y * width + left) * 3..(y * width + right) * 3];
            row.fill(if self.stars { 255 } else { 0 });
            if self.stars {
                let dy = (y as f64 + 0.5 - (top + bottom) as f64 / 2.0) / cell;
                for (i, pixel) in row.chunks_exact_mut(3).enumerate() {
                    let x = (left + i) as f64 + 0.5;
                    let col = ((x - mid) / cell + 2.0).floor();
                    if !(0.0..4.0).contains(&col) {
                        continue;
                    }
                    let dx = (x - mid) / cell - (col - 1.5);
                    if dx * dx + dy * dy <= 0.105
                        && (dx.abs() < 0.055
                            || (dx * 0.5 + dy * 0.866).abs() < 0.055
                            || (dx * 0.5 - dy * 0.866).abs() < 0.055)
                    {
                        pixel.fill(0);
                    }
                }
            }
        }
    }
}

// Area-average the crop at a coarse resolution, then bilinearly reconstruct it.
// Reading the original raster makes consecutive overlapping blurs agree with the preview.
fn blur_region(
    rgb: &mut [u8],
    source: &[u8],
    stride: usize,
    xs: std::ops::Range<usize>,
    ys: std::ops::Range<usize>,
) {
    let cell = stride.div_ceil(20).max(12);
    let cols = xs.len().div_ceil(cell);
    let rows = ys.len().div_ceil(cell);
    let mut colors = vec![[0.0; 3]; cols * rows];
    for (i, color) in colors.iter_mut().enumerate() {
        let x0 = xs.start + (i % cols) * xs.len() / cols;
        let x1 = xs.start + (i % cols + 1) * xs.len() / cols;
        let y0 = ys.start + (i / cols) * ys.len() / rows;
        let y1 = ys.start + (i / cols + 1) * ys.len() / rows;
        let mut sum = [0u64; 3];
        for y in y0..y1 {
            for pixel in source[(y * stride + x0) * 4..(y * stride + x1) * 4].chunks_exact(4) {
                for c in 0..3 {
                    sum[c] += u64::from(pixel[c]);
                }
            }
        }
        for c in 0..3 {
            color[c] = sum[c] as f64 / ((x1 - x0) * (y1 - y0)) as f64;
        }
    }
    fn sample_axis(pixel: usize, length: usize, samples: usize) -> (usize, usize, f64) {
        let pos = ((pixel as f64 + 0.5) * samples as f64 / length as f64 - 0.5)
            .clamp(0.0, (samples - 1) as f64);
        (
            pos as usize,
            (pos as usize + 1).min(samples - 1),
            pos.fract(),
        )
    }
    let horizontal: Vec<_> = (0..xs.len())
        .map(|x| sample_axis(x, xs.len(), cols))
        .collect();
    for y in ys.clone() {
        let (top, bottom, v) = sample_axis(y - ys.start, ys.len(), rows);
        let row = &mut rgb[(y * stride + xs.start) * 3..(y * stride + xs.end) * 3];
        for (pixel, &(left, right, u)) in row.chunks_exact_mut(3).zip(&horizontal) {
            for (c, channel) in pixel.iter_mut().enumerate() {
                let mix = |row: usize| {
                    colors[row * cols + left][c] * (1.0 - u) + colors[row * cols + right][c] * u
                };
                *channel = (mix(top) * (1.0 - v) + mix(bottom) * v).round() as u8;
            }
        }
    }
}

pub(crate) fn export(
    pdfium: &Pdfium,
    source: &PdfDocument,
    masks: &[Mask],
    path: &Path,
) -> Result<(), EngineError> {
    use EngineError::*;
    if masks.len() > 2048 || !masks.iter().all(|m| m.valid(source.pages().len())) {
        return Err(EditFailed);
    }
    if !source
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        || !source
            .permissions()
            .can_extract_text_and_graphics()
            .unwrap_or(false)
    {
        return Err(UnsupportedText);
    }
    if path.exists() {
        return Err(TargetExists);
    }
    let mut output = Document::with_version("1.5");
    let pages_id = output.new_object_id();
    let mut pages = Vec::new();
    let mut digests = Vec::new();
    let mut compressed_size = 0usize;
    let config = PdfRenderConfig::new()
        .set_target_width(1600)
        .set_maximum_height(2200)
        .render_annotations(true)
        .render_form_data(true)
        .set_clear_color(PdfColor::WHITE);
    for index in 0..source.pages().len() {
        let page = source.pages().get(index).map_err(|_| InvalidPage)?;
        let bitmap = page.render_with_config(&config).map_err(|_| RenderFailed)?;
        let (w, h) = (bitmap.width() as usize, bitmap.height() as usize);
        let rgba = bitmap.as_rgba_bytes();
        if w == 0 || h == 0 || rgba.len() != w * h * 4 {
            return Err(RenderFailed);
        }
        let mut rgb = Vec::with_capacity(w * h * 3);
        for pixel in rgba.chunks_exact(4) {
            rgb.extend_from_slice(&pixel[..3]);
        }
        let page_masks = masks.iter().filter(|mask| mask.page == index);
        // Opaque replacements always cover blurs, including on intersections.
        for mask in page_masks
            .clone()
            .filter(|m| m.blur && !m.stars)
            .chain(page_masks.filter(|m| !m.blur || m.stars))
        {
            mask.paint(&mut rgb, &rgba, w, h);
        }
        // The new object graph contains only opaque, already-redacted RGB images.
        let digest = Sha256::digest(&rgb);
        let mut image = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => w as i64, "Height" => h as i64,
                "ColorSpace" => "DeviceRGB", "BitsPerComponent" => 8,
            },
            rgb,
        );
        image.compress().map_err(|_| SaveFailed)?;
        compressed_size += image.content.len();
        if compressed_size > 128 * 1024 * 1024 {
            return Err(TooLarge);
        }
        let image_id = output.add_object(image);
        digests.push((image_id, digest));
        let (pw, ph) = (page.width().value, page.height().value);
        let content = lopdf::content::Content {
            operations: vec![
                lopdf::content::Operation::new(
                    "cm",
                    vec![pw.into(), 0.into(), 0.into(), ph.into(), 0.into(), 0.into()],
                ),
                lopdf::content::Operation::new("Do", vec!["PageImage".into()]),
            ],
        }
        .encode()
        .map_err(|_| SaveFailed)?;
        let contents = output.add_object(Stream::new(dictionary! {}, content));
        pages.push(Object::Reference(output.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(),0.into(),pw.into(),ph.into()],
            "Contents" => contents, "Resources" => dictionary! { "XObject" => dictionary! { "PageImage" => image_id } },
        })));
    }
    output.objects.insert(
        pages_id,
        dictionary! {"Type" => "Pages", "Count" => pages.len() as i64,"Kids" => pages}.into(),
    );
    let catalog = output.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
    output.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    output.save_to(&mut bytes).map_err(|_| SaveFailed)?;
    drop(output);
    let checked = Document::load_mem(&bytes).map_err(|_| VerificationFailed)?;
    for (id, expected) in digests {
        let pixels = checked
            .get_object(id)
            .and_then(Object::as_stream)
            .and_then(Stream::get_plain_content)
            .map_err(|_| VerificationFailed)?;
        if Sha256::digest(pixels) != expected {
            return Err(VerificationFailed);
        }
    }
    drop(checked);
    let reopened = pdfium
        .load_pdf_from_byte_slice(&bytes, None)
        .map_err(|_| VerificationFailed)?;
    if reopened.pages().len() != source.pages().len() || !reopened.signatures().is_empty() {
        return Err(VerificationFailed);
    }
    crate::document::save::save_new(pdfium, &reopened, &bytes, path)
}

#[cfg(test)]
mod tests {
    use super::Mask;

    #[test]
    fn replacement_erases_every_touched_source_pixel_for_both_styles() {
        for stars in [false, true] {
            let mask = Mask {
                page: 0,
                x: 0.205,
                y: 0.301,
                right: 0.798,
                bottom: 0.699,
                stars,
                blur: false,
            };
            let mut dark = vec![17; 100 * 100 * 3];
            let mut light = vec![221; dark.len()];
            mask.paint(&mut dark, &[], 100, 100);
            mask.paint(&mut light, &[], 100, 100);
            for (i, (a, b)) in dark.chunks_exact(3).zip(light.chunks_exact(3)).enumerate() {
                if (20..80).contains(&(i % 100)) && (30..70).contains(&(i / 100)) {
                    assert_eq!(a, b);
                    assert!(a == [0; 3] || (stars && a == [255; 3]));
                } else {
                    assert_eq!(a, [17; 3]);
                    assert_eq!(b, [221; 3]);
                }
            }
        }
    }

    #[test]
    fn blur_averages_source_detail_and_preserves_surroundings() {
        let mask = Mask {
            page: 0,
            x: 0.25,
            y: 0.0,
            right: 0.75,
            bottom: 1.0,
            stars: false,
            blur: true,
        };
        let source: Vec<u8> = (0..32)
            .flat_map(|i| [if i % 2 == 0 { 0 } else { 200 }, 20, 60, 255])
            .collect();
        let mut out = vec![7; 8 * 4 * 3];
        mask.paint(&mut out, &source, 8, 4);
        for (i, pixel) in out.chunks_exact(3).enumerate() {
            assert_eq!(
                pixel,
                if (2..6).contains(&(i % 8)) {
                    [100, 20, 60]
                } else {
                    [7; 3]
                }
            );
        }
    }
}
