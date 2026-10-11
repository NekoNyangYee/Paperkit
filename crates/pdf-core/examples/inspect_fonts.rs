// Read-only font diagnostics for a local PDF. Usage: inspect_fonts <pdf>.
use std::{collections::BTreeMap, path::PathBuf};
fn main() {
    let path = PathBuf::from(std::env::args_os().nth(1).expect("PDF path"));
    let doc = lopdf::Document::load(&path).unwrap();
    for (id, object) in &doc.objects {
        if let Ok(dict) = object.as_dict() {
            if dict.get(b"Type").ok().and_then(|v| v.as_name().ok()) == Some(b"Font".as_slice()) {
                println!(
                    "font {id:?}: {:?} {:?}",
                    dict.get(b"BaseFont"),
                    dict.get(b"Subtype")
                );
            }
            if let Ok(reference) = dict.get(b"FontFile2") {
                let stream = doc.dereference(reference).unwrap().1.as_stream().unwrap();
                let bytes = stream.get_plain_content().unwrap();
                println!(
                    "embedded {id:?}: {} bytes {:?}",
                    bytes.len(),
                    ttf_parser::Face::parse(&bytes, 0).map(|f| (
                        f.number_of_glyphs(),
                        f.is_outline_embedding_allowed(),
                        f.tables().cmap.is_some()
                    ))
                );
                if let Ok(face) = ttf_parser::Face::parse(&bytes, 0) {
                    println!(
                        "tables: {:?}",
                        face.raw_face()
                            .table_records
                            .into_iter()
                            .map(|r| String::from_utf8_lossy(&r.tag.to_bytes()).into_owned())
                            .collect::<Vec<_>>()
                    );
                }
            }
        }
    }
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine =
        pdf_core::render::PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let page = engine.render("diagnostic".into(), path, 0, 800).unwrap();
    let mut fonts = BTreeMap::new();
    for object in page.text.objects {
        fonts.entry(object.font.clone()).or_insert(object);
    }
    for (name, object) in fonts {
        let result = engine.font("diagnostic".into(), 0, 0, object.id);
        println!(
            "{name}: blocked={:?}, font={:?}",
            object.edit_blocked,
            result.as_ref().map(|v| v.len())
        );
        if let Ok(bytes) = result {
            let face = ttf_parser::Face::parse(&bytes, 0).unwrap();
            println!(
                "glyphs={}, sample support={:?}",
                face.number_of_glyphs(),
                "가나다라마바사 ABCdd"
                    .chars()
                    .map(|c| (c, face.glyph_index(c).is_some()))
                    .collect::<Vec<_>>()
            );
        }
    }
}
