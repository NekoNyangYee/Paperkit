use pdf_core::{
    security::{Integrity, Mask, Trust},
    EngineError, Paperframe,
};
use std::{fs, path::PathBuf};

#[test]
#[cfg(windows)]
#[ignore = "requires the bundled Windows PDFium library"]
fn verifies_original_signatures_and_ensures_only_masked_pixels_survive_export() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let engine =
        Paperframe::start(root.join("../../apps/desktop/src-tauri/resources/pdfium/pdfium.dll"))
            .unwrap();
    let bytes = include_bytes!("fixtures/masking-signed.pdf");
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("source.pdf");
    fs::write(&original, bytes).unwrap();
    let page = engine
        .render("original".into(), original.clone(), 0, 1600)
        .unwrap();
    assert_eq!(page.signatures.len(), 1);
    let sig = &page.signatures[0];
    assert_eq!(sig.integrity, Integrity::Matches);
    assert_eq!(sig.signer.as_deref(), Some("Paperkit test signer"));
    assert_ne!(sig.trust, Trust::Trusted);
    assert_eq!(sig.later_bytes, Some(false));
    let mut modified = bytes.to_vec();
    let offset = modified.windows(4).position(|w| w == b"1234").unwrap();
    modified[offset] = b'9';
    let other = dir.path().join("other.pdf");
    fs::write(&other, modified).unwrap();
    assert_eq!(
        engine
            .render("changed".into(), other.clone(), 0, 400)
            .unwrap()
            .signatures[0]
            .integrity,
        Integrity::Mismatch
    );
    fs::write(&other, [bytes.as_slice(), b"\n% later bytes\n"].concat()).unwrap();
    let appended = engine.render("appended".into(), other, 0, 400).unwrap();
    assert_eq!(appended.signatures[0].integrity, Integrity::Matches);
    assert_eq!(appended.signatures[0].later_bytes, Some(true));

    let masks = vec![
        Mask {
            page: 0,
            x: 0.298,
            y: 0.398,
            right: 0.385,
            bottom: 0.475,
            stars: true,
            blur: false,
        },
        Mask {
            page: 1,
            x: 0.0,
            y: 0.0,
            right: 1.0,
            bottom: 1.0,
            stars: false,
            blur: true,
        },
    ];
    let target = dir.path().join("masked.pdf");
    assert_eq!(
        engine.save_masked_copy("original".into(), 2, masks.clone(), target.clone()),
        Err(EngineError::StaleObject)
    );
    assert_eq!(
        engine.save_masked_copy("original".into(), 0, masks.clone(), original.clone()),
        Err(EngineError::TargetExists)
    );
    engine
        .save_masked_copy("original".into(), 0, masks, target.clone())
        .unwrap();
    assert_eq!(fs::read(original).unwrap(), bytes);
    let doc = lopdf::Document::load(&target).unwrap();
    assert!(!doc.trailer.has(b"Info"));
    let catalog = doc.catalog().unwrap();
    for key in [b"AcroForm".as_slice(), b"Names", b"Metadata"] {
        assert!(!catalog.has(key));
    }
    assert_eq!(doc.get_pages().len(), 2);
    for page_id in doc.get_pages().values() {
        assert!(!doc.get_dictionary(*page_id).unwrap().has(b"Annots"));
        let ops = lopdf::content::Content::decode(&doc.get_page_content(*page_id)).unwrap();
        assert_eq!(
            ops.operations
                .iter()
                .map(|op| op.operator.as_str())
                .collect::<Vec<_>>(),
            ["cm", "Do"]
        );
    }
    let images: Vec<_> = doc
        .objects
        .values()
        .filter_map(|v| v.as_stream().ok())
        .filter(|s| s.dict.get(b"Subtype").and_then(|v| v.as_name()).ok() == Some(b"Image"))
        .collect();
    assert_eq!(images.len(), 2);
    let blurred = images[1].get_plain_content().unwrap();
    assert!(blurred.iter().any(|p| *p > 0));
    let masked = engine
        .render("masked".into(), target.clone(), 0, 1600)
        .unwrap();
    assert!(masked.text.objects.is_empty() && masked.signatures.is_empty());
    assert_eq!((masked.width, masked.height), (page.width, page.height));
    if let Some(dir) = std::env::var_os("PAPERKIT_SECURITY_TEST_OUTPUT") {
        let dir = PathBuf::from(dir);
        fs::write(dir.join("masked-preview.png"), masked.png).unwrap();
        fs::copy(target, dir.join("masked.pdf")).unwrap();
    }
}
