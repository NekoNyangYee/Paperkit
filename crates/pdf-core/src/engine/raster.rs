//! Bitmap, PNG and text geometry production; no history or queue ownership.
use super::RenderedPage;
use crate::{editing::EditState, error::EngineError as PreviewError, text};
use pdfium_render::prelude::*;
pub(super) fn render_page(
    document: &PdfDocument<'_>,
    index: i32,
    width: i32,
) -> Result<RenderedPage, PreviewError> {
    render_page_layer(document, index, width, false)
}

fn render_page_layer(
    document: &PdfDocument<'_>,
    index: i32,
    width: i32,
    transparent: bool,
) -> Result<RenderedPage, PreviewError> {
    let page_count = document.pages().len();
    if index < 0 || index >= page_count {
        return Err(PreviewError::InvalidPage);
    }
    let page = document
        .pages()
        .get(index)
        .map_err(|_| PreviewError::InvalidPage)?;
    render_loaded_page(document, &page, index, width, transparent)
}

pub(super) fn render_loaded_page(
    document: &PdfDocument<'_>,
    page: &pdfium_render::prelude::PdfPage<'_>,
    index: i32,
    width: i32,
    transparent: bool,
) -> Result<RenderedPage, PreviewError> {
    let page_count = document.pages().len();
    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_maximum_height(2200)
        .render_annotations(!transparent)
        .render_form_data(!transparent)
        .set_clear_color(if transparent {
            PdfColor::new(0, 0, 0, 0)
        } else {
            PdfColor::WHITE
        });
    let bitmap = page
        .render_with_config(&config)
        .map_err(|_| PreviewError::RenderFailed)?;
    let reconstruct_layout = width > 300;
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    let rgba = bitmap.as_rgba_bytes();
    if transparent {
        // Reject an opaque backdrop from a problematic PDF transparency group.
        // Never replace the visible page with such a drag layer.
        let mut area = [i32::MAX, i32::MAX, i32::MIN, i32::MIN];
        for object in page.objects().iter() {
            if !object.is_active().map_err(|_| PreviewError::RenderFailed)? {
                continue;
            }
            let q = object.bounds().map_err(|_| PreviewError::RenderFailed)?;
            for (x, y) in [
                (q.x1(), q.y1()),
                (q.x2(), q.y2()),
                (q.x3(), q.y3()),
                (q.x4(), q.y4()),
            ] {
                let (x, y) = page
                    .points_to_pixels(x, y, &config)
                    .map_err(|_| PreviewError::RenderFailed)?;
                area[0] = area[0].min(x.saturating_sub(4));
                area[1] = area[1].min(y.saturating_sub(4));
                area[2] = area[2].max(x.saturating_add(4));
                area[3] = area[3].max(y.saturating_add(4));
            }
        }
        for (i, pixel) in rgba.chunks_exact(4).enumerate() {
            let x = (i % width as usize) as i32;
            let y = (i / width as usize) as i32;
            if pixel[3] > 0 && (x < area[0] || y < area[1] || x > area[2] || y > area[3]) {
                return Err(PreviewError::RenderFailed);
            }
        }
    }
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|_| PreviewError::RenderFailed)?;
        writer
            .write_image_data(&rgba)
            .map_err(|_| PreviewError::RenderFailed)?;
    }
    Ok(RenderedPage {
        page_count,
        page_index: index,
        width,
        height,
        png,
        text: if !reconstruct_layout || transparent {
            // Thumbnails and transparent drag layers never expose text tools.
            text::PageText::default()
        } else {
            let mut text = text::extract(document, &page, &config);
            if reconstruct_layout {
                crate::layout::reconstruct(&page, &config, &mut text);
            }
            text
        },
        state: EditState::default(),
    })
}
