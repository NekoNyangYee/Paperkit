use lopdf::{dictionary, Object, Stream};
use pdf_core::{edit::EditAction, EngineError, Paperframe};
use std::{fs, path::PathBuf};

fn pdf(form: bool, text: bool) -> Vec<u8> {
    let mut doc = lopdf::Document::with_version("1.7");
    let pages = doc.new_object_id();
    let font = doc.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
    );
    let resources = dictionary! { "Font" => dictionary! { "F1" => font } };
    let stream = if text {
        b"BT /F1 32 Tf 40 600 Td (PAPERKIT INVOICE 12345) Tj ET".to_vec()
    } else {
        Vec::new()
    };
    let mut page_resources = resources.clone();
    let content = if form {
        let xobject = doc.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => vec![0.into(), 0.into(), 600.into(), 800.into()], "Resources" => resources,
        }, stream));
        page_resources.set("XObject", dictionary! { "Form1" => xobject });
        b"q /Form1 Do Q".to_vec()
    } else {
        stream
    };
    let contents = doc.add_object(Stream::new(dictionary! {}, content));
    let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()], "Contents" => contents, "Resources" => page_resources });
    doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 }));
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();
    bytes
}

#[test]
#[ignore = "requires bundled Windows PDFium and qpdf"]
fn ensemble_reads_forms_routes_scans_checks_revisions_and_preserves_permissions() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    assert!(
        resources.join("qpdf/bin/qpdf.exe").is_file(),
        "Run pnpm setup:engines"
    );
    let engine =
        Paperframe::start_with_fonts(resources.join("pdfium/pdfium.dll"), resources.join("fonts"))
            .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let form = workspace.path().join("form.pdf");
    fs::write(&form, pdf(true, true)).unwrap();
    let preview = engine.render("form".into(), form, 0, 800).unwrap();
    assert!(
        preview.text.objects.is_empty(),
        "form text has no editable object IDs"
    );
    let extracted = engine.extract_text("form".into(), 0, 0, false).unwrap();
    assert!(extracted.text.contains("PAPERKIT INVOICE 12345"));
    assert!(
        extracted.png.is_none(),
        "native form text must not start OCR"
    );
    assert!(engine
        .extract_text("form".into(), 0, 0, true)
        .unwrap()
        .png
        .is_some());
    assert!(matches!(
        engine.extract_text("form".into(), 1, 0, false),
        Err(EngineError::StaleObject)
    ));

    let native = workspace.path().join("native.pdf");
    fs::write(&native, pdf(false, true)).unwrap();
    let bitmap = engine
        .render("native".into(), native.clone(), 0, 1600)
        .unwrap()
        .png;
    let scan = workspace.path().join("scan.pdf");
    let original = pdf(false, false);
    fs::write(&scan, &original).unwrap();
    engine.render("scan".into(), scan.clone(), 0, 800).unwrap();
    let state = engine
        .edit(
            "scan".into(),
            0,
            EditAction::PasteImage {
                page: 0,
                png: bitmap.clone(),
            },
        )
        .unwrap();
    let extracted = engine
        .extract_text("scan".into(), state.revision, 0, false)
        .unwrap();
    assert!(extracted.text.trim().is_empty());
    assert!(
        extracted.png.is_some(),
        "image-only page must have a bounded OCR source"
    );
    assert_eq!(
        fs::read(scan).unwrap(),
        original,
        "OCR and edits never overwrite source"
    );
    if let Some(directory) = std::env::var_os("PAPERKIT_ENSEMBLE_FIXTURES") {
        let directory = PathBuf::from(directory);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("ocr.png"), bitmap).unwrap();
        let korean_state = engine
            .edit(
                "native".into(),
                0,
                EditAction::EditWithFallback {
                    page: 0,
                    group: None,
                    object: Some(0),
                    text: "한글 문서 확인".into(),
                },
            )
            .unwrap();
        // Body-sized Korean text, representative of a scanned document rather
        // than the 32 pt display heading used by the English geometry fixture.
        engine
            .edit(
                "native".into(),
                korean_state.revision,
                EditAction::ScaleText {
                    page: 0,
                    objects: vec![0],
                    sx: 0.5,
                    sy: 0.5,
                },
            )
            .unwrap();
        let bitmap = engine.render("native".into(), native, 0, 1600).unwrap().png;
        fs::write(directory.join("ocr-kor.png"), bitmap).unwrap();
        engine
            .edit(
                "scan".into(),
                state.revision,
                EditAction::Save {
                    path: directory.join("scan.pdf"),
                },
            )
            .or_else(|error| {
                if error == EngineError::TargetExists {
                    Ok(state.clone())
                } else {
                    Err(error)
                }
            })
            .unwrap();
    }
    let restricted =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/restricted.pdf");
    engine
        .render("restricted".into(), restricted, 0, 800)
        .unwrap();
    assert!(matches!(
        engine.extract_text("restricted".into(), 0, 0, true),
        Err(EngineError::UnsupportedText)
    ));
}
