use pdfium_render::prelude::*;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextObject {
    pub id: usize,
    pub text: String,
    pub font: String,
    /// Page-local representative object for the same reusable font; never a native handle.
    pub font_object_id: usize,
    pub font_size: f32,
    pub color: [u8; 4],
    pub matrix: [f32; 6],
    pub bounds: [[f32; 2]; 4],
    pub screen_bounds: [[i32; 2]; 4],
    pub edit_blocked: Option<String>,
    pub font_change_blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageText {
    pub objects: Vec<TextObject>,
    pub groups: Vec<crate::layout::TextGroup>,
    pub warning: Option<String>,
}

pub(crate) fn extract(
    document: &PdfDocument<'_>,
    page: &PdfPage<'_>,
    config: &PdfRenderConfig,
) -> PageText {
    extract_impl(document, page, config, true)
}

/// Content verification does not need to prepare fonts for a future editing session.
/// Keep object geometry, text, colors and hard restrictions; skip font recovery only.
pub(crate) fn extract_for_verification(
    document: &PdfDocument<'_>,
    page: &PdfPage<'_>,
    config: &PdfRenderConfig,
) -> PageText {
    extract_impl(document, page, config, false)
}

fn extract_impl(
    document: &PdfDocument<'_>,
    page: &PdfPage<'_>,
    config: &PdfRenderConfig,
    prepare_fonts: bool,
) -> PageText {
    if !document
        .permissions()
        .can_extract_text_and_graphics()
        .unwrap_or(false)
    {
        return PageText {
            warning: Some("문서 권한이 텍스트 추출을 허용하지 않습니다.".into()),
            ..Default::default()
        };
    }
    let Ok(text_page) = page.text() else {
        return PageText {
            warning: Some("텍스트 정보를 읽지 못했습니다.".into()),
            ..Default::default()
        };
    };
    let can_modify = document
        .permissions()
        .can_modify_document_content()
        .unwrap_or(false)
        && document.signatures().is_empty();
    let mut result = PageText::default();
    let mut font_bytes = std::collections::HashMap::new();
    let mut font_objects = std::collections::HashMap::new();
    for (id, object) in page.objects().iter().enumerate() {
        if object.as_x_object_form_object().is_some() {
            result.warning = Some("폼 내부의 텍스트는 아직 선택할 수 없습니다.".into());
        }
        let Some(text) = object.as_text_object() else {
            continue;
        };
        let extracted = (|| -> Result<TextObject, PdfiumError> {
            let q = text.bounds()?;
            let points = [
                (q.x1(), q.y1()),
                (q.x2(), q.y2()),
                (q.x3(), q.y3()),
                (q.x4(), q.y4()),
            ];
            let mut bounds = [[0.0; 2]; 4];
            let mut screen_bounds = [[0; 2]; 4];
            for (i, (x, y)) in points.into_iter().enumerate() {
                bounds[i] = [x.value, y.value];
                let (x, y) = page.points_to_pixels(x, y, config)?;
                screen_bounds[i] = [x, y];
            }
            let m = text.matrix()?;
            let matrix = [m.a(), m.b(), m.c(), m.d(), m.e(), m.f()];
            let c = text.fill_color()?;
            let font = text.font();
            let name = font.name();
            let value = text_page.for_object(text);
            let reusable_font = if prepare_fonts {
                let cached_font = font_bytes.entry(font.token()).or_insert_with(|| {
                    crate::fonts::preserved_bytes(document, &font, value.trim_end()).ok()
                });
                if cached_font.as_ref().is_some_and(|bytes| {
                    crate::fonts::validate_original(bytes, value.trim_end()).is_err()
                }) {
                    *cached_font =
                        crate::fonts::preserved_bytes(document, &font, value.trim_end()).ok();
                }
                let reusable = cached_font.as_ref().is_some_and(|bytes| {
                    crate::fonts::validate_original(bytes, value.trim_end()).is_ok()
                });
                reusable
            } else {
                true
            };
            let edit_blocked = if !can_modify {
                Some("권한 제한 또는 전자 서명이 있는 문서는 수정할 수 없습니다.")
            } else if !reusable_font
                && !crate::fonts::known_name(&name)
                && (font.is_embedded().unwrap_or(true) || !standard_font(&name))
            {
                Some("PDF 내장 글꼴의 문자 매핑을 복원하지 못했고, 동일한 전체 글꼴도 찾지 못했습니다. 원본 글꼴 데이터가 필요합니다.")
            } else if (!reusable_font && !crate::fonts::known_name(&name) && !value.is_ascii())
                || value.is_empty()
            {
                Some("현재 편집은 기본 폰트의 영문·숫자·기호만 지원합니다.")
            } else if m.b().abs() > 0.001
                || m.c().abs() > 0.001
                || m.a() <= 0.0
                || m.d() <= 0.0
                || text.render_mode() != PdfPageTextRenderMode::FilledUnstroked
            {
                Some("회전·기울기·특수 렌더링 텍스트는 읽기만 가능합니다.")
            } else {
                None
            };
            Ok(TextObject {
                id,
                text: value,
                font: name,
                font_object_id: if reusable_font {
                    *font_objects.entry(font.token()).or_insert(id)
                } else {
                    id
                },
                font_size: text.unscaled_font_size().value,
                color: [c.red(), c.green(), c.blue(), c.alpha()],
                matrix,
                bounds,
                screen_bounds,
                edit_blocked: edit_blocked.map(str::to_owned),
                font_change_blocked: if !can_modify
                    || text.render_mode() != PdfPageTextRenderMode::FilledUnstroked
                    || object.has_transparency()
                    || object.get_clip_path().is_some_and(|clip| !clip.is_empty())
                    || m.b().abs() > 0.001
                    || m.c().abs() > 0.001
                    || m.a() <= 0.0
                    || m.d() <= 0.0
                {
                    Some(
                        "권한 제한·회전·투명도·클리핑이 있는 객체는 글꼴을 변경할 수 없습니다."
                            .into(),
                    )
                } else {
                    None
                },
            })
        })();
        match extracted {
            Ok(value)
                if value
                    .bounds
                    .iter()
                    .flatten()
                    .chain(value.matrix.iter())
                    .all(|v| v.is_finite())
                    && value.font_size.is_finite() =>
            {
                result.objects.push(value)
            }
            _ => result.warning = Some("일부 텍스트 객체의 속성을 읽지 못했습니다.".into()),
        }
    }
    result
}

pub(crate) fn standard_font(name: &str) -> bool {
    matches!(
        name,
        "Helvetica"
            | "Helvetica-Bold"
            | "Helvetica-Oblique"
            | "Helvetica-BoldOblique"
            | "Courier"
            | "Courier-Bold"
            | "Courier-Oblique"
            | "Courier-BoldOblique"
            | "Times-Roman"
            | "Times-Bold"
            | "Times-Italic"
            | "Times-BoldItalic"
    )
}
