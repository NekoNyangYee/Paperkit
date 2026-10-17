use crate::error::EngineError as PreviewError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::OnceLock};

#[derive(Deserialize, Serialize, Clone)]
pub struct FontInfo {
    pub id: String,
    pub name: String,
    pub file: String,
    pub sha256: String,
    #[serde(default, rename = "postscriptNames")]
    pub postscript_names: Vec<String>,
    #[serde(default = "bundled_source")]
    pub source: String,
}

fn bundled_source() -> String {
    "bundled".into()
}

pub fn available() -> Vec<FontInfo> {
    let mut result = catalog().to_vec();
    for (name, label) in [
        ("MalgunGothic", "맑은 고딕"),
        ("MalgunGothicBold", "맑은 고딕 · Bold"),
        ("Batang", "바탕"),
        ("BatangChe", "바탕체"),
        ("Dotum", "돋움"),
        ("DotumChe", "돋움체"),
        ("Gulim", "굴림"),
        ("GulimChe", "굴림체"),
        ("Gungsuh", "궁서"),
        ("GungsuhChe", "궁서체"),
        ("Haansoft Batang", "한컴바탕"),
        ("HCRBatang", "함초롬바탕"),
        ("HCRBatang-Bold", "함초롬바탕 · Bold"),
        ("HCRDotum", "함초롬돋움"),
        ("HCRDotum-Bold", "함초롬돋움 · Bold"),
        ("ArialMT", "Arial"),
        ("Arial-BoldMT", "Arial · Bold"),
        ("TimesNewRomanPSMT", "Times New Roman"),
        ("TimesNewRomanPS-BoldMT", "Times New Roman · Bold"),
        ("Calibri", "Calibri"),
        ("Calibri-Bold", "Calibri · Bold"),
        ("Cambria", "Cambria"),
        ("Cambria-Bold", "Cambria · Bold"),
        ("Aptos", "Aptos"),
        ("Aptos-Bold", "Aptos · Bold"),
    ] {
        if crate::system_fonts::available(name) {
            result.push(FontInfo {
                id: format!("installed:{name}"),
                name: label.into(),
                file: String::new(),
                sha256: String::new(),
                postscript_names: vec![name.into()],
                source: "installed".into(),
            });
        }
    }
    result
}

pub fn catalog() -> &'static [FontInfo] {
    static FONTS: OnceLock<Vec<FontInfo>> = OnceLock::new();
    FONTS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../scripts/fonts-manifest.json"))
            .expect("checked-in font manifest")
    })
}

pub fn known_name(name: &str) -> bool {
    catalog()
        .iter()
        .any(|font| font.postscript_names.iter().any(|n| n == name))
        || matches!(
            name,
            "Pretendard-Regular"
                | "Pretendard"
                | "NotoSansKR-Thin"
                | "NotoSansKR-Regular"
                | "NotoSerifKR-ExtraLight"
                | "NotoSerifKR-Regular"
                | "NanumGothic"
                | "NanumMyeongjo"
        )
}

pub fn load(directory: &Path, id: &str, text: &str) -> Result<Vec<u8>, PreviewError> {
    if let Some(name) = id.strip_prefix("installed:") {
        return crate::system_fonts::load(name, text);
    }
    let info = catalog()
        .iter()
        .find(|font| font.id == id)
        .ok_or(PreviewError::FontUnavailable)?;
    let bytes =
        std::fs::read(directory.join(&info.file)).map_err(|_| PreviewError::FontUnavailable)?;
    if format!("{:x}", Sha256::digest(&bytes)) != info.sha256 {
        return Err(PreviewError::FontUnavailable);
    }
    validate(&bytes, text)?;
    Ok(bytes)
}

pub(crate) fn validate(bytes: &[u8], text: &str) -> Result<(), PreviewError> {
    let hash = format!("{:x}", Sha256::digest(bytes));
    if !catalog().iter().any(|font| font.sha256 == hash) {
        return validate_original(bytes, text);
    }
    validate_original(bytes, text)
}

// A usable Unicode cmap and embedding permission are required. Merely having
// the same font name or being able to render old PDF glyphs is not sufficient.
pub(crate) fn validate_original(bytes: &[u8], text: &str) -> Result<(), PreviewError> {
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(PreviewError::FontUnavailable);
    }
    let face = ttf_parser::Face::parse(bytes, 0).map_err(|_| PreviewError::FontUnavailable)?;
    if !face.is_outline_embedding_allowed() {
        return Err(PreviewError::FontUnavailable);
    }
    if text
        .chars()
        .any(|c| c.is_control() || face.glyph_index(c).is_none_or(|glyph| glyph.0 == 0))
    {
        return Err(PreviewError::MissingGlyph);
    }
    Ok(())
}

/// Preserve the embedded face where usable, otherwise require an exact installed face.
pub(crate) fn preserved_bytes(
    document: &pdfium_render::prelude::PdfDocument<'_>,
    font: &pdfium_render::prelude::PdfFont<'_>,
    text: &str,
) -> Result<Vec<u8>, PreviewError> {
    let data = if font.is_embedded().unwrap_or(false) {
        font.data().ok()
    } else {
        None
    };
    same_face_in_document(document, &font.name(), data.as_deref(), text)
}

pub(crate) fn same_face_in_document(
    document: &pdfium_render::prelude::PdfDocument<'_>,
    name: &str,
    embedded: Option<&[u8]>,
    text: &str,
) -> Result<Vec<u8>, PreviewError> {
    if let Some(bytes) = embedded {
        if validate_original(bytes, text).is_ok() {
            return Ok(bytes.to_vec());
        }
    }
    // Serialize once for both recovery and other subsets of the exact face.
    if let Ok(pdf) = document.save_to_bytes() {
        if let Some(bytes) = embedded {
            if let Some(recovered) = crate::font_recovery::recover(&pdf, bytes) {
                if validate_original(&recovered, text).is_ok() {
                    return Ok(recovered);
                }
            }
        }
        if let Some(bytes) = crate::font_recovery::matching_embedded(&pdf, name, text) {
            return Ok(bytes);
        }
    }
    same_face(name, embedded, text)
}

/// Load an exact original face for this app session without installing it in the OS.
pub fn import_original(path: &std::path::Path, expected: &[String]) -> Result<Vec<String>, String> {
    crate::system_fonts::import_exact(path, expected)
}

pub(crate) fn same_face(
    name: &str,
    embedded: Option<&[u8]>,
    text: &str,
) -> Result<Vec<u8>, PreviewError> {
    let validation = embedded.map(|bytes| validate_original(bytes, text));
    if matches!(validation, Some(Ok(()))) {
        return Ok(embedded.unwrap().to_vec());
    }
    crate::system_fonts::load(name, text).map_err(|error| {
        if error == PreviewError::FontUnavailable
            && matches!(validation, Some(Err(PreviewError::MissingGlyph)))
        {
            PreviewError::MissingGlyph
        } else {
            error
        }
    })
}
