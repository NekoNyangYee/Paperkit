use pdf_core::{
    edit::EditAction,
    layout::GroupKind,
    render::{PreviewEngine, PreviewError},
};
use std::{fs, path::PathBuf};

fn pdf(stream: &str, rotation: i32) -> Vec<u8> {
    let objects = ["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate {rotation} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
        format!("<< /Length {} >>\nstream\n{}endstream",stream.len(),stream),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".into()];
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(b"xref\n0 6\n0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    bytes
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn page_operations_preserve_content_history_and_saved_order() {
    use lopdf::{Dictionary, Object, Stream};
    use pdf_core::pages::PageOperation;
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-pages-{}.pdf", std::process::id()));
    let saved = path.with_extension("saved.pdf");
    let mut doc =
        lopdf::Document::load_mem(&pdf("BT /F1 20 Tf 40 700 Td (PAGE A) Tj ET\n", 0)).unwrap();
    let template = doc.get_object((3, 0)).unwrap().as_dict().unwrap().clone();
    let mut kids = vec![Object::Reference((3, 0))];
    for label in ["B", "C"] {
        let stream = doc.add_object(Stream::new(
            Dictionary::new(),
            format!("BT /F1 20 Tf 40 700 Td (PAGE {label}) Tj ET\n").into_bytes(),
        ));
        let mut page = template.clone();
        page.set("Contents", stream);
        let id = doc.add_object(page);
        kids.push(id.into());
    }
    // The reorder path must retain inherited resources and page dimensions.
    for id in kids.iter().map(|o| o.as_reference().unwrap()) {
        let page = doc.get_object_mut(id).unwrap().as_dict_mut().unwrap();
        page.remove(b"Resources");
        page.remove(b"MediaBox");
    }
    let tree = doc.get_object_mut((2, 0)).unwrap().as_dict_mut().unwrap();
    tree.set("Kids", kids);
    tree.set("Count", 3);
    tree.set("Resources", template.get(b"Resources").unwrap().clone());
    tree.set("MediaBox", template.get(b"MediaBox").unwrap().clone());
    doc.save(&path).unwrap();
    let original = fs::read(&path).unwrap();
    let initial: Vec<_> = (0..3)
        .map(|i| {
            engine
                .render("pages".into(), path.clone(), i, 800)
                .unwrap()
                .png
        })
        .collect();
    let apply = |revision, page, operation, destination| {
        engine
            .edit(
                "pages".into(),
                revision,
                EditAction::Page {
                    page,
                    operation,
                    destination,
                },
            )
            .unwrap()
    };
    assert_eq!(
        apply(0, 0, PageOperation::Move, Some(2)).page_count,
        Some(3)
    );
    for (i, old) in [1, 2, 0].into_iter().enumerate() {
        assert_eq!(
            engine
                .render("pages".into(), path.clone(), i as i32, 800)
                .unwrap()
                .png,
            initial[old]
        );
    }
    assert_eq!(
        apply(1, 1, PageOperation::Duplicate, None).page_count,
        Some(4)
    );
    assert_eq!(
        engine
            .render("pages".into(), path.clone(), 2, 800)
            .unwrap()
            .png,
        initial[2]
    );
    apply(2, 2, PageOperation::Rotate, None);
    let rotated = engine.render("pages".into(), path.clone(), 2, 800).unwrap();
    assert!(rotated.width > rotated.height);
    assert_eq!(apply(3, 3, PageOperation::Delete, None).page_count, Some(3));
    let undo = engine.edit("pages".into(), 4, EditAction::Undo).unwrap();
    assert_eq!(undo.page_count, Some(4));
    assert_eq!(
        engine
            .render("pages".into(), path.clone(), 3, 800)
            .unwrap()
            .png,
        initial[0]
    );
    engine.edit("pages".into(), 5, EditAction::Redo).unwrap();
    engine
        .edit(
            "pages".into(),
            6,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("saved-pages".into(), saved.clone(), 2, 800)
            .unwrap()
            .png,
        rotated.png
    );
    for revision in 0..2 {
        engine
            .edit(
                "saved-pages".into(),
                revision,
                EditAction::Page {
                    page: 0,
                    operation: PageOperation::Delete,
                    destination: None,
                },
            )
            .unwrap();
    }
    let before_rejection = engine
        .render("saved-pages".into(), saved.clone(), 0, 800)
        .unwrap();
    assert!(matches!(
        engine.edit(
            "saved-pages".into(),
            2,
            EditAction::Page {
                page: 0,
                operation: PageOperation::Delete,
                destination: None
            }
        ),
        Err(PreviewError::LastPage)
    ));
    let after_rejection = engine
        .render("saved-pages".into(), saved.clone(), 0, 800)
        .unwrap();
    assert_eq!(after_rejection.png, before_rejection.png);
    assert_eq!(
        after_rejection.state.revision,
        before_rejection.state.revision
    );
    assert_eq!(
        after_rejection.state.can_undo,
        before_rejection.state.can_undo
    );
    assert_eq!(
        after_rejection.state.can_redo,
        before_rejection.state.can_redo
    );
    // A rejected candidate must not consume or alter the last successful undo step.
    assert_eq!(
        engine
            .edit("saved-pages".into(), 2, EditAction::Undo)
            .unwrap()
            .page_count,
        Some(2)
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    fs::remove_file(saved).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn edits_double_spaced_block_without_compressing_its_lines() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-leading-{}.pdf", std::process::id()));
    fs::write(&path, pdf("BT /F1 12 Tf 40 700 Td (First line of a long block) Tj 0 -24 Td (Second line of this block) Tj 0 -24 Td (Third line ends here.) Tj ET\n", 0)).unwrap();
    let before = engine
        .render("leading".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Paragraph)
        .unwrap();
    assert_eq!(group.bounds.len(), 3);
    engine
        .edit(
            "leading".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: group.text.replace("First", "Start"),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let after = engine
        .render("leading".into(), path.clone(), 0, 800)
        .unwrap();
    let mut baselines: Vec<_> = after.text.objects.iter().map(|o| o.matrix[5]).collect();
    baselines.sort_by(|a, b| b.total_cmp(a));
    baselines.dedup_by(|a, b| (*a - *b).abs() < 0.1);
    assert!(baselines.len() >= 3);
    for pair in baselines.windows(2) {
        assert!((pair[0] - pair[1] - 24.0).abs() < 0.01);
    }
    engine.edit("leading".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("leading".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn consecutive_spaces_survive_block_edit_save_and_reopen() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-spaces-{}.pdf", std::process::id()));
    let saved = path.with_extension("saved.pdf");
    let original = pdf(
        "BT /F1 12 Tf 40 700 Td (Original) Tj ET\nBT /F1 12 Tf 40 400 Td (KEEP) Tj ET\n",
        0,
    );
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("spaces".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.text.contains("Original"))
        .unwrap();
    engine
        .edit(
            "spaces".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: "Word  with   spaces  1".into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let edited = engine
        .render("spaces".into(), path.clone(), 0, 800)
        .unwrap();
    engine
        .edit(
            "spaces".into(),
            1,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    let document = lopdf::Document::load(&saved).unwrap();
    let extracted = document.extract_text(&[1]).unwrap();
    assert!(
        extracted.contains("Word  with   spaces  1"),
        "{extracted:?}"
    );
    assert!(extracted.contains("KEEP"));
    engine.edit("spaces".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("spaces".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    let reopened = engine
        .render("spaces-saved".into(), saved.clone(), 0, 800)
        .unwrap();
    assert_eq!(edited.png, reopened.png);
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    fs::remove_file(saved).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn deletes_whole_block_without_original_font_and_saves_blank_page() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!(
        "paperkit-delete-missing-font-{}.pdf",
        std::process::id()
    ));
    let saved = path.with_extension("saved.pdf");
    let mut document =
        lopdf::Document::load_mem(&pdf("BT /F1 12 Tf 40 700 Td (DELETE ALL) Tj ET\n", 0)).unwrap();
    document
        .get_object_mut((5, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set(
            "BaseFont",
            lopdf::Object::Name(b"PaperkitMissingFace".to_vec()),
        );
    let descriptor = document.add_object(lopdf::dictionary! {"Type"=>"FontDescriptor", "FontName"=>"PaperkitMissingFace", "Flags"=>33, "FontBBox"=>vec![0.into(), (-250).into(), 600.into(), 1000.into()], "Ascent"=>800, "Descent"=>-200, "CapHeight"=>700, "ItalicAngle"=>0, "StemV"=>80});
    let font = document
        .get_object_mut((5, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap();
    font.set("FontDescriptor", descriptor);
    font.set("FirstChar", 0);
    font.set("LastChar", 255);
    font.set("Widths", vec![lopdf::Object::Integer(600); 256]);
    let mut original = Vec::new();
    document.save_to(&mut original).unwrap();
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("delete".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before.text.groups.iter().find(|g| g.can_flow).unwrap();
    engine
        .edit(
            "delete".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: String::new(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let blank = engine
        .render("delete".into(), path.clone(), 0, 800)
        .unwrap();
    assert!(blank.text.objects.is_empty());
    engine
        .edit(
            "delete".into(),
            1,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    engine.edit("delete".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("delete".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(
        engine
            .render("saved".into(), saved.clone(), 0, 800)
            .unwrap()
            .png,
        blank.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    fs::remove_file(saved).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn font_change_and_empty_object_save_with_precise_neighbors() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let root = std::env::temp_dir().join(format!("paperkit-basic-edit-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let source = root.join("source.pdf");
    let original = pdf("BT /F1 12 Tf 40 700 Td (EDIT ME) Tj ET\nBT /F1 12 Tf 0.25 Tc 0.9999997 0 0 1.0000003 40.1234567 600.7654321 Tm (KEEP THIS) Tj ET\nBT /F1 12 Tf 0.25 Tc 0.9999997 0 0 1.0000003 40.1234567 600.7654321 Tm (KEEP THIS) Tj ET\n", 0);
    fs::write(&source, &original).unwrap();
    for (name, action) in [
        (
            "font",
            EditAction::ChangeFont {
                page: 0,
                object: 0,
                font: "pretendard-bold".into(),
            },
        ),
        (
            "delete",
            EditAction::Replace {
                page: 0,
                object: 0,
                text: String::new(),
            },
        ),
    ] {
        let before = engine.render(name.into(), source.clone(), 0, 800).unwrap();
        engine.edit(name.into(), 0, action).unwrap();
        let after = engine.render(name.into(), source.clone(), 0, 800).unwrap();
        assert!(after
            .text
            .objects
            .iter()
            .any(|o| o.text.trim() == "KEEP THIS"));
        if name == "delete" {
            assert_eq!(after.text.objects.len(), 2);
        } else {
            assert!(after.text.objects.iter().any(|o| o.font.contains("Bold")));
        }
        let saved = root.join(format!("{name}.pdf"));
        engine
            .edit(
                name.into(),
                1,
                EditAction::Save {
                    path: saved.clone(),
                },
            )
            .unwrap();
        engine.edit(name.into(), 1, EditAction::Undo).unwrap();
        assert_eq!(
            engine
                .render(name.into(), source.clone(), 0, 800)
                .unwrap()
                .png,
            before.png
        );
        assert_eq!(
            engine
                .render(format!("{name}-saved"), saved.clone(), 0, 800)
                .unwrap()
                .png,
            after.png
        );
        fs::remove_file(saved).unwrap();
    }
    assert_eq!(fs::read(&source).unwrap(), original);
    fs::remove_file(source).unwrap();
    fs::remove_dir(root).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn edits_object_without_rejecting_generated_word_spaces() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-word-space-{}.pdf", std::process::id()));
    fs::write(
        &path,
        pdf(
            "BT /F1 12 Tf 40 700 Td (HELLO) Tj ET\nBT /F1 12 Tf 100 700 Td (WORLD) Tj ET\n",
            0,
        ),
    )
    .unwrap();
    let before = engine
        .render("word-space".into(), path.clone(), 0, 800)
        .unwrap();
    let object = before
        .text
        .objects
        .iter()
        .find(|o| o.text.trim() == "HELLO")
        .unwrap();
    engine
        .edit(
            "word-space".into(),
            0,
            EditAction::Replace {
                page: 0,
                object: object.id,
                text: "HI".into(),
            },
        )
        .unwrap();
    let after = engine
        .render("word-space".into(), path.clone(), 0, 800)
        .unwrap();
    assert!(after.text.objects.iter().any(|o| o.text.trim() == "HI"));
    assert!(after.text.objects.iter().any(|o| o.text.trim() == "WORLD"));
    engine
        .edit("word-space".into(), 1, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("word-space".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    engine.release("word-space".into()).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn edits_text_preserving_fractional_unchanged_objects() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-overprint-{}.pdf", std::process::id()));
    let original = pdf("BT /F1 12 Tf 40 700 Td (Original text) Tj ET\nq .12345678 0 0 .12345678 40 300 cm BT /F1 12 Tf (KEEP) Tj ET Q\n", 0);
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("overprint".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.text.contains("Original"))
        .unwrap();
    engine
        .edit(
            "overprint".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: "Changed text".into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let after = engine
        .render("overprint".into(), path.clone(), 0, 800)
        .unwrap();
    assert_eq!(
        after
            .text
            .objects
            .iter()
            .filter(|o| o.text.trim() == "KEEP")
            .count(),
        1
    );
    assert!(after
        .text
        .objects
        .iter()
        .any(|o| o.text.trim() == "Changed text"));
    let saved = path.with_extension("saved.pdf");
    engine
        .edit(
            "overprint".into(),
            1,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("overprint-reopened".into(), saved.clone(), 0, 800)
            .unwrap()
            .png,
        after.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    engine.release("overprint-reopened".into()).unwrap();
    fs::remove_file(saved).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn edits_scaled_text_and_roundtrips_without_rejecting_float_roundoff() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path =
        std::env::temp_dir().join(format!("paperkit-scaled-edit-{}.pdf", std::process::id()));
    let original=pdf("q .75 0 0 .75 0 0 cm BT /F1 12 Tf 1 0 0 1 40 700 Tm (Original text) Tj ET Q\nBT /F1 12 Tf 40 300 Td (KEEP) Tj ET\n",0);
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("scaled".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.text.contains("Original"))
        .unwrap();
    engine
        .edit(
            "scaled".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: "Changed text 1".into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let after = engine
        .render("scaled".into(), path.clone(), 0, 800)
        .unwrap();
    assert!(after
        .text
        .objects
        .iter()
        .any(|o| o.text.contains("Changed text 1")));
    let saved = path.with_extension("saved.pdf");
    engine
        .edit(
            "scaled".into(),
            1,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    engine.edit("scaled".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("scaled".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(
        engine
            .render("saved".into(), saved.clone(), 0, 800)
            .unwrap()
            .png,
        after.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    fs::remove_file(saved).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn recognizes_graphics_without_turning_them_into_text() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-graphics-{}.pdf", std::process::id()));
    let base = pdf("q 1 0 0 rg 40 500 120 80 re f Q\nq 100 0 0 50 200 400 cm /Im1 Do Q\nBT /F1 12 Tf 40 700 Td (Text stays text) Tj ET\n", 0);
    let mut doc = lopdf::Document::load_mem(&base).unwrap();
    let mut dict = lopdf::Dictionary::new();
    dict.set("Type", "XObject");
    dict.set("Subtype", "Image");
    dict.set("Width", 1);
    dict.set("Height", 1);
    dict.set("ColorSpace", "DeviceRGB");
    dict.set("BitsPerComponent", 8);
    let image_id = doc.add_object(lopdf::Stream::new(dict, vec![255, 0, 0]));
    let mut images = lopdf::Dictionary::new();
    images.set("Im1", image_id);
    doc.get_object_mut((3, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .get_mut(b"Resources")
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set("XObject", images);
    let mut original = Vec::new();
    doc.save_to(&mut original).unwrap();
    fs::write(&path, &original).unwrap();
    let page = engine
        .render("graphics".into(), path.clone(), 0, 600)
        .unwrap();
    assert_eq!(page.text.graphics.len(), 2);
    assert!(page.text.graphics.iter().any(|o| o.kind == "image"));
    let shape = page
        .text
        .graphics
        .iter()
        .find(|o| o.kind == "path")
        .unwrap();
    assert!(shape.bounds.iter().all(|p| p[0] >= 39.9 && p[0] <= 160.1));
    assert!(shape
        .screen_bounds
        .iter()
        .all(|p| p[1] >= 219 && p[1] <= 301));
    assert_eq!(page.text.objects.len(), 1);
    let zoomed = engine
        .render("graphics".into(), path.clone(), 0, 1200)
        .unwrap();
    assert_eq!(zoomed.text.graphics[0].id, page.text.graphics[0].id);
    assert_eq!(zoomed.text.graphics[0].bounds, page.text.graphics[0].bounds);
    let foreground = engine
        .layer("graphics".into(), 0, 0, 600, vec![shape.id], true)
        .unwrap();
    assert!(!foreground.is_empty());
    let image = page
        .text
        .graphics
        .iter()
        .find(|o| o.kind == "image")
        .unwrap();
    engine
        .edit(
            "graphics".into(),
            0,
            EditAction::TransformGraphic {
                page: 0,
                object: image.id,
                matrix: [1., 0., 0., 1., 20., 10.],
            },
        )
        .unwrap();
    let moved = engine
        .render("graphics".into(), path.clone(), 0, 600)
        .unwrap();
    let moved_image = moved
        .text
        .graphics
        .iter()
        .find(|o| o.kind == "image")
        .unwrap();
    assert!((moved_image.bounds[0][0] - image.bounds[0][0] - 20.).abs() < 0.1);
    assert_eq!(moved.text.objects[0].text, page.text.objects[0].text);
    engine
        .edit(
            "graphics".into(),
            1,
            EditAction::TransformGraphic {
                page: 0,
                object: image.id,
                matrix: [1.5, 0., 0., 1.5, 0., 0.],
            },
        )
        .unwrap();
    let resized = engine
        .render("graphics".into(), path.clone(), 0, 600)
        .unwrap();
    assert_ne!(resized.png, moved.png);
    let saved = path.with_extension("saved.pdf");
    engine
        .edit(
            "graphics".into(),
            2,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    engine
        .edit(
            "graphics".into(),
            2,
            EditAction::DeleteGraphic {
                page: 0,
                object: image.id,
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("graphics".into(), path.clone(), 0, 600)
            .unwrap()
            .text
            .graphics
            .len(),
        1
    );
    engine.edit("graphics".into(), 3, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("graphics".into(), path.clone(), 0, 600)
            .unwrap()
            .png,
        resized.png
    );
    engine.edit("graphics".into(), 4, EditAction::Redo).unwrap();
    engine
        .edit(
            "graphics".into(),
            5,
            EditAction::TransformGraphic {
                page: 0,
                object: shape.id,
                matrix: [1.2, 0., 0., 1.2, 5., -20.],
            },
        )
        .unwrap();
    let shape_changed = engine
        .render("graphics".into(), path.clone(), 0, 600)
        .unwrap();
    assert!((shape_changed.text.graphics[0].bounds[0][0] - 53.).abs() < 0.1);
    engine
        .edit(
            "graphics".into(),
            6,
            EditAction::DeleteGraphic {
                page: 0,
                object: shape.id,
            },
        )
        .unwrap();
    assert!(engine
        .render("graphics".into(), path.clone(), 0, 600)
        .unwrap()
        .text
        .graphics
        .is_empty());
    engine.edit("graphics".into(), 7, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("graphics".into(), path.clone(), 0, 600)
            .unwrap()
            .text
            .graphics
            .len(),
        1
    );
    assert_eq!(
        engine
            .render("reopened".into(), saved.clone(), 0, 600)
            .unwrap()
            .png,
        resized.png
    );
    // Moving across existing text must not be treated as a collision. Both
    // objects remain independently movable and survive saving and reopening.
    fs::remove_file(saved).unwrap();
    let saved = path.with_extension("overlap.pdf");
    let overlap = engine
        .render("overlap".into(), path.clone(), 0, 600)
        .unwrap();
    engine
        .edit(
            "overlap".into(),
            0,
            EditAction::TransformGraphic {
                page: 0,
                object: image.id,
                matrix: [1., 0., 0., 1., -160., 270.],
            },
        )
        .unwrap();
    let overlapping = engine
        .render("overlap".into(), path.clone(), 0, 600)
        .unwrap();
    assert_eq!(overlapping.text.objects, overlap.text.objects);
    let graphic = overlapping
        .text
        .graphics
        .iter()
        .find(|o| o.id == image.id)
        .unwrap();
    assert!((graphic.bounds[0][0] - image.bounds[0][0] + 160.).abs() < 0.1);
    engine
        .edit(
            "overlap".into(),
            1,
            EditAction::Move {
                page: 0,
                group: None,
                object: Some(overlap.text.objects[0].id),
                dx: 20.,
                dy: -15.,
            },
        )
        .unwrap();
    let moved_text = engine
        .render("overlap".into(), path.clone(), 0, 600)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&moved_text.text.graphics).unwrap(),
        serde_json::to_value(&overlapping.text.graphics).unwrap()
    );
    assert_eq!(moved_text.text.objects[0].text.trim(), "Text stays text");
    engine
        .edit(
            "overlap".into(),
            2,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("overlap-reopened".into(), saved.clone(), 0, 600)
            .unwrap()
            .png,
        moved_text.png
    );
    engine.release("overlap".into()).unwrap();
    fs::remove_file(saved).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    engine.release("graphics".into()).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn alignment_preserves_center_and_applies_right_then_roundtrips() {
    use pdf_core::alignment::Alignment;
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-align-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let source = directory.join("original.pdf");
    let original = pdf(
        "BT /F1 20 Tf 80 700 Td (ABCDEFGHIJ) Tj ET\nBT /F1 20 Tf 110 672 Td (ABCDE) Tj ET\n",
        0,
    );
    fs::write(&source, &original).unwrap();
    let before = engine
        .render("align".into(), source.clone(), 0, 800)
        .unwrap();
    let groups = before
        .text
        .groups
        .iter()
        .filter(|g| g.can_flow)
        .map(|g| g.id)
        .collect();
    engine
        .edit(
            "align".into(),
            0,
            EditAction::FlowBlocks {
                page: 0,
                groups,
                text: "ABCDEFGHIJ\nABC".into(),
                width: Some(121.),
                height: None,
            },
        )
        .unwrap();
    let centered = engine
        .render("align".into(), source.clone(), 0, 800)
        .unwrap();
    let short = centered
        .text
        .objects
        .iter()
        .find(|o| o.text == "ABC")
        .unwrap();
    assert!(
        (short.matrix[4] - 122.5).abs() < 0.2,
        "short line must remain centered: {:?}",
        short.matrix
    );
    let groups = centered
        .text
        .groups
        .iter()
        .filter(|g| g.can_flow)
        .map(|g| g.id)
        .collect();
    engine
        .edit(
            "align".into(),
            1,
            EditAction::AlignBlock {
                page: 0,
                groups,
                text: None,
                alignment: Alignment::Right,
                width: Some(121.),
                height: None,
                font: None,
            },
        )
        .unwrap();
    let right = engine
        .render("align".into(), source.clone(), 0, 800)
        .unwrap();
    assert!(
        right
            .text
            .objects
            .iter()
            .find(|o| o.text == "ABC")
            .unwrap()
            .matrix[4]
            > 160.
    );
    let target = directory.join("saved.pdf");
    engine
        .edit(
            "align".into(),
            2,
            EditAction::Save {
                path: target.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine.render("saved".into(), target, 0, 800).unwrap().png,
        right.png
    );
    assert_eq!(fs::read(&source).unwrap(), original);
    let before = engine
        .render("justify".into(), source.clone(), 0, 800)
        .unwrap();
    let groups = before
        .text
        .groups
        .iter()
        .filter(|g| g.can_flow)
        .map(|g| g.id)
        .collect();
    engine
        .edit(
            "justify".into(),
            0,
            EditAction::AlignBlock {
                page: 0,
                groups,
                text: Some("AB CD EF GH IJ KL MN".into()),
                alignment: Alignment::Justify,
                width: Some(121.),
                height: None,
                font: None,
            },
        )
        .unwrap();
    let justified = engine
        .render("justify".into(), source.clone(), 0, 800)
        .unwrap();
    assert!(
        justified
            .text
            .objects
            .iter()
            .find(|o| o.text.trim() == "CD")
            .unwrap()
            .matrix[4]
            > 120.
    );
    assert!(
        (justified
            .text
            .objects
            .iter()
            .find(|o| o.text.trim() == "MN")
            .unwrap()
            .matrix[4]
            - 80.)
            .abs()
            < 0.2
    );
    let target = directory.join("justified.pdf");
    engine
        .edit(
            "justify".into(),
            1,
            EditAction::Save {
                path: target.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("justify-saved".into(), target, 0, 800)
            .unwrap()
            .png,
        justified.png
    );
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn drag_layers_preserve_slide_background_and_transparency() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let path =
        std::env::temp_dir().join(format!("paperkit-slide-layer-{}.pdf", std::process::id()));
    let bytes=pdf("1 1 1 rg 0 0 600 800 re f\n0.2 0.4 0.8 rg 0 760 600 40 re f\n0.8 0.8 0.8 rg 40 685 200 50 re f\nBT /F1 20 Tf 1 0 0 rg 50 700 Td (Slide text) Tj ET\nBT /F1 10 Tf 0 0 0 rg 55 695 Td (Other text) Tj ET\n",0);
    let mut doc = lopdf::Document::load_mem(&bytes).unwrap();
    let mut group = lopdf::Dictionary::new();
    group.set("S", lopdf::Object::Name(b"Transparency".to_vec()));
    group.set("CS", lopdf::Object::Name(b"DeviceRGB".to_vec()));
    group.set("I", true);
    doc.get_object_mut((3, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap()
        .set("Group", group);
    doc.save(&path).unwrap();
    let page = engine.render("slide".into(), path.clone(), 0, 800).unwrap();
    let id = page.text.objects[0].id;
    let decode = |bytes: Vec<u8>| {
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .unwrap();
        let mut data = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut data).unwrap();
        data.truncate(info.buffer_size());
        data
    };
    let foreground = decode(
        engine
            .layer("slide".into(), 0, 0, 800, vec![id], true)
            .unwrap(),
    );
    assert_eq!(
        foreground[3], 0,
        "outside text must be transparent, not opaque black"
    );
    assert!(foreground
        .chunks_exact(4)
        .any(|p| p[0] > 200 && p[1] < 50 && p[3] > 200));
    assert!(
        foreground
            .chunks_exact(4)
            .filter(|p| p[3] > 0)
            .all(|p| p[0] > 0 && p[1] == 0 && p[2] == 0),
        "drag foreground must not contain gray table cells, blue headers or other text"
    );
    let background = decode(
        engine
            .layer("slide".into(), 0, 0, 800, vec![id], false)
            .unwrap(),
    );
    assert!(background
        .chunks_exact(4)
        .any(|p| p == [255, 255, 255, 255]));
    assert!(
        background[2] > background[0],
        "blue slide header must remain"
    );
    assert_eq!(
        engine.render("slide".into(), path, 0, 800).unwrap().png,
        page.png
    );
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn moving_one_of_nine_shared_content_pages_preserves_the_others() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let mut doc = lopdf::Document::load_mem(&pdf(
        "BT /F1 12 Tf 50 700 Td 1.25 Tc (Shared text) Tj ET\n",
        0,
    ))
    .unwrap();
    let template = doc.get_object((3, 0)).unwrap().clone();
    let mut kids = vec![lopdf::Object::Reference((3, 0))];
    for _ in 1..9 {
        kids.push(doc.add_object(template.clone()).into());
    }
    let pages = doc.get_object_mut((2, 0)).unwrap().as_dict_mut().unwrap();
    pages.set("Kids", kids);
    pages.set("Count", 9);
    let mut original = Vec::new();
    doc.save_to(&mut original).unwrap();
    let path = std::env::temp_dir().join(format!(
        "paperkit-nine-page-move-{}.pdf",
        std::process::id()
    ));
    fs::write(&path, &original).unwrap();
    let first = engine.render("nine".into(), path.clone(), 0, 800).unwrap();
    let start = std::time::Instant::now();
    engine
        .edit(
            "nine".into(),
            0,
            EditAction::Move {
                page: 0,
                group: None,
                object: Some(0),
                dx: 12.0,
                dy: -20.0,
            },
        )
        .unwrap();
    eprintln!("nine-page move transaction: {:?}", start.elapsed());
    for index in 1..9 {
        assert_eq!(
            engine
                .render("nine".into(), path.clone(), index, 800)
                .unwrap()
                .png,
            first.png
        );
    }
    assert_ne!(
        engine
            .render("nine".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        first.png
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn moves_fractional_and_spaced_text_without_rebuilding_glyphs() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    for (name, stream) in [
        ("fractional", "BT /F1 10.123456 Tf 0.123456 0.234567 0.345678 rg 0.9876543 0 0 0.9998765 50.123456 700.234567 Tm (Heading) Tj 0 -16.123456 Td (Body text) Tj ET\nBT /F1 9.123456 Tf 0.9987654 0 0 0.9876543 50.123456 400.234567 Tm (KEEP) Tj ET\n"),
        ("spacing", "BT /F1 12 Tf 1 0 0 1 50 700 Tm 1.25 Tc 2.5 Tw [(Some) -350 (words) -120 ( here)] TJ 0 -18 Td (Next line) Tj ET\nBT /F1 10 Tf 50 400 Td (KEEP) Tj ET\n"),
        ("scaled-spacing", "q 0.75 0 0 0.75 15 20 cm BT /F1 16 Tf 18 TL 1 0 0 1 50 700 Tm 1.25 Tc [(Some) -350 (words)] TJ (Next line) ' 2.5 1.25 (Third line) \" ET Q\nBT /F1 10 Tf 50 400 Td (KEEP) Tj ET\n"),
    ] {
        let path = std::env::temp_dir().join(format!("paperkit-move-{name}-{}.pdf", std::process::id()));
        let original = pdf(stream, 0);
        fs::write(&path, &original).unwrap();
        let before = engine.render(name.into(), path.clone(), 0, 1600).unwrap();
        let group = before.text.groups.iter().find(|g| g.kind == GroupKind::Paragraph && !g.text.contains("KEEP")).unwrap();
        engine.edit(name.into(), 0, EditAction::Move { page: 0, group: Some(group.id), object: None, dx: 7.123456, dy: -11.234567 }).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let moved = engine.render(name.into(), path.clone(), 0, 1600).unwrap();
        assert_ne!(before.png, moved.png);
        let output = path.with_extension("moved.pdf");
        engine.edit(name.into(), 1, EditAction::Save { path: output.clone() }).unwrap();
        engine.edit(name.into(), 1, EditAction::Undo).unwrap();
        assert_eq!(engine.render(name.into(), path.clone(), 0, 1600).unwrap().png, before.png);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(engine.render(format!("{name}-saved"), output.clone(), 0, 1600).unwrap().png, moved.png);
        engine.release(name.into()).unwrap();
        fs::remove_file(path).unwrap();
        fs::remove_file(output).unwrap();
    }
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn restricted_heading_keeps_body_editable_as_a_block() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!(
        "paperkit-restricted-heading-{}.pdf",
        std::process::id()
    ));
    let original=pdf("BT /F1 10 Tf 2 Tr 1 0 0 1 50 700 Tm (Stroked heading) Tj ET\nBT /F1 10 Tf 0 Tr 1 0 0 1 50 686 Tm (Editable body first line) Tj ET\nBT /F1 10 Tf 0 Tr 1 0 0 1 50 672 Tm (Editable body second line) Tj ET\n",0);
    fs::write(&path, &original).unwrap();
    let id = "restricted-heading".to_string();
    let page = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    let blocks: Vec<_> = page
        .text
        .groups
        .iter()
        .filter(|g| g.kind == GroupKind::Paragraph)
        .collect();
    assert_eq!(blocks.len(), 2);
    assert!(!blocks[0].can_flow);
    assert!(blocks[1].can_flow);
    assert_eq!(blocks[1].runs.len(), 2);
    engine
        .edit(
            id.clone(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: blocks[1].id,
                text: "Changed body without changing heading".into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let edited = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    assert!(edited
        .text
        .objects
        .iter()
        .any(|o| o.text.contains("Changed body")));
    assert!(edited
        .text
        .objects
        .iter()
        .any(|o| o.text.contains("Stroked heading") && o.font_change_blocked.is_some()));
    engine.edit(id.clone(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine.render(id.clone(), path.clone(), 0, 800).unwrap().png,
        page.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    engine.release(id).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn temporary_merge_auto_width_delete_and_undo() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-multi-{}.pdf", std::process::id()));
    let original=pdf("BT /F1 10 Tf 1 0 0 1 50 700 Tm (First block) Tj ET\nBT /F1 10 Tf 1 0 0 1 50 600 Tm (Second block) Tj ET\n",0);
    fs::write(&path, &original).unwrap();
    let id = "multiple".to_string();
    let first = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    let groups: Vec<_> = first
        .text
        .groups
        .iter()
        .filter(|g| g.kind == GroupKind::Paragraph)
        .map(|g| g.id)
        .collect();
    assert_eq!(groups.len(), 2);
    assert!(engine
        .edit(
            id.clone(),
            0,
            EditAction::FlowBlocks {
                page: 0,
                groups: vec![groups[0], groups[0]],
                text: "invalid".into(),
                width: None,
                height: None
            }
        )
        .is_err());
    engine
        .edit(
            id.clone(),
            0,
            EditAction::FlowBlocks {
                page: 0,
                groups: groups.clone(),
                text: "First block with more words and automatic width\n\nSecond edited block"
                    .into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let edited = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    let blocks: Vec<_> = edited
        .text
        .groups
        .iter()
        .filter(|g| g.kind == GroupKind::Paragraph)
        .collect();
    assert_eq!(blocks.len(), 2);
    assert!(blocks[0].text.contains("automatic width"));
    assert_eq!(
        blocks[0].bounds.len(),
        1,
        "automatic width must not wrap at the old narrow box"
    );
    let output = path.with_extension("edited.pdf");
    engine
        .edit(
            id.clone(),
            1,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    engine.edit(id.clone(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine.render(id.clone(), path.clone(), 0, 800).unwrap().png,
        first.png
    );
    engine
        .edit(
            id.clone(),
            2,
            EditAction::FlowBlock {
                page: 0,
                group: groups[0],
                text: String::new(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render(id.clone(), path.clone(), 0, 800)
            .unwrap()
            .text
            .objects
            .len(),
        1
    );
    engine.edit(id.clone(), 3, EditAction::Undo).unwrap();
    assert_eq!(
        engine.render(id.clone(), path.clone(), 0, 800).unwrap().png,
        first.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    engine.release(id).unwrap();
    let reopened = engine
        .render("merged-saved".into(), output.clone(), 0, 800)
        .unwrap();
    assert_eq!(reopened.png, edited.png);
    assert_eq!(
        reopened
            .text
            .groups
            .iter()
            .filter(|g| g.kind == GroupKind::Paragraph)
            .count(),
        2
    );
    engine.release("merged-saved".into()).unwrap();
    fs::remove_file(output).unwrap();
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn columns_cells_paragraphs_move_edit_save_and_reopen() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-corpus-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    for (name, columns, rows, rotation, table) in [
        ("paragraph", 1, 5, 0, false),
        ("invoice-columns", 3, 4, 0, false),
        ("table-cells", 3, 3, 0, true),
        ("rotated-page", 1, 3, 90, false),
        ("mixed-styles", 1, 4, 0, false),
    ] {
        let mut stream = String::new();
        for row in 0..rows {
            for col in 0..columns {
                let size = if name == "mixed-styles" && row == 0 {
                    14
                } else {
                    10
                };
                let color = if name == "mixed-styles" && row == 0 {
                    "0.2 0.4 0.8"
                } else {
                    "0 0 0"
                };
                stream.push_str(&format!(
                    "BT /F1 {size} Tf {color} rg 1 0 0 1 {} {} Tm (Column {col} text row {row}) Tj ET\n",
                    50 + col * 170,
                    700 - row * 14
                ));
            }
        }
        if table {
            for col in 0..=columns {
                stream.push_str(&format!(
                    "0.2 w {} 650 m {} 720 l S\n",
                    40 + col * 170,
                    40 + col * 170
                ));
            }
        }
        let original = pdf(&stream, rotation);
        let source = directory.join(format!("{name}.pdf"));
        fs::write(&source, &original).unwrap();
        let initial = engine.render(name.into(), source.clone(), 0, 800).unwrap();
        let blocks: Vec<_> = initial
            .text
            .groups
            .iter()
            .filter(|g| g.kind == GroupKind::Paragraph)
            .collect();
        assert_eq!(blocks.len(), columns as usize, "{name}");
        assert!(
            blocks
                .iter()
                .all(|g| !g.uncertain && g.can_flow && g.bounds.len() == rows as usize),
            "{name}"
        );
        for (n, block) in blocks.iter().enumerate() {
            let flow_id = format!("{name}-flow-{n}");
            engine
                .render(flow_id.clone(), source.clone(), 0, 800)
                .unwrap();
            let background = engine
                .background(
                    flow_id.clone(),
                    0,
                    0,
                    800,
                    block.runs.iter().map(|r| r.object).collect(),
                )
                .unwrap();
            assert_ne!(background, initial.png);
            let layer = engine
                .layer(
                    flow_id.clone(),
                    0,
                    0,
                    800,
                    block.runs.iter().map(|r| r.object).collect(),
                    true,
                )
                .unwrap();
            let mut decoder = png::Decoder::new(std::io::Cursor::new(layer))
                .read_info()
                .unwrap();
            let mut rgba = vec![0; decoder.output_buffer_size().unwrap()];
            decoder.next_frame(&mut rgba).unwrap();
            assert!(
                rgba.chunks_exact(4).any(|p| p[3] > 0),
                "selected text must be visible"
            );
            assert!(
                rgba.chunks_exact(4).filter(|p| p[3] == 0).count() > rgba.len() / 8,
                "most of the isolated layer must be transparent"
            );
            assert_eq!(
                engine
                    .render(flow_id.clone(), source.clone(), 0, 800)
                    .unwrap()
                    .png,
                initial.png
            );
            let long = format!(
                "{} {}",
                block.text,
                "A longer edited paragraph that can wrap onto additional lines. ".repeat(5)
            );
            engine
                .edit(
                    flow_id.clone(),
                    0,
                    EditAction::FlowBlock {
                        page: 0,
                        group: block.id,
                        text: long.clone(),
                        width: Some(150.0),
                        height: Some(120.0),
                    },
                )
                .unwrap();
            let flowed = engine
                .render(flow_id.clone(), source.clone(), 0, 800)
                .unwrap();
            assert!(flowed.text.objects.len() > initial.text.objects.len());
            if name == "mixed-styles" {
                assert!(flowed
                    .text
                    .objects
                    .iter()
                    .any(|o| o.font_size == 14.0 && o.color == [51, 102, 204, 255]));
                assert!(flowed
                    .text
                    .objects
                    .iter()
                    .any(|o| o.font_size == 10.0 && o.color == [0, 0, 0, 255]));
            }
            let out = directory.join(format!("{flow_id}.pdf"));
            engine
                .edit(flow_id.clone(), 1, EditAction::Save { path: out.clone() })
                .unwrap();
            engine.edit(flow_id.clone(), 1, EditAction::Undo).unwrap();
            assert_eq!(
                engine
                    .render(flow_id.clone(), source.clone(), 0, 800)
                    .unwrap()
                    .png,
                initial.png
            );
            assert_eq!(
                engine
                    .render(format!("{flow_id}-reopen"), out, 0, 800)
                    .unwrap()
                    .png,
                flowed.png
            );
            let id = format!("{name}-{n}");
            engine.render(id.clone(), source.clone(), 0, 800).unwrap();
            assert!(matches!(
                engine.edit(
                    id.clone(),
                    0,
                    EditAction::Move {
                        page: 0,
                        group: Some(block.id),
                        object: None,
                        dx: -1000.0,
                        dy: 0.0
                    }
                ),
                Err(PreviewError::TextOverflow)
            ));
            engine
                .edit(
                    id.clone(),
                    0,
                    EditAction::Move {
                        page: 0,
                        group: Some(block.id),
                        object: None,
                        dx: 12.0,
                        dy: -6.0,
                    },
                )
                .unwrap();
            let moved = engine.render(id.clone(), source.clone(), 0, 800).unwrap();
            assert_ne!(moved.png, initial.png);
            let moved_path = directory.join(format!("{id}-moved.pdf"));
            engine
                .edit(
                    id.clone(),
                    1,
                    EditAction::Save {
                        path: moved_path.clone(),
                    },
                )
                .unwrap();
            engine.edit(id.clone(), 1, EditAction::Undo).unwrap();
            assert_eq!(
                engine
                    .render(id.clone(), source.clone(), 0, 800)
                    .unwrap()
                    .png,
                initial.png
            );
            engine
                .edit(
                    id.clone(),
                    2,
                    EditAction::FlowBlock {
                        page: 0,
                        group: block.id,
                        text: "Updated text".into(),
                        width: None,
                        height: None,
                    },
                )
                .unwrap();
            let changed = engine.render(id.clone(), source.clone(), 0, 800).unwrap();
            let output = directory.join(format!("{id}-edited.pdf"));
            engine
                .edit(
                    id.clone(),
                    3,
                    EditAction::Save {
                        path: output.clone(),
                    },
                )
                .unwrap();
            assert_eq!(
                engine
                    .render(format!("{id}-saved"), output, 0, 800)
                    .unwrap()
                    .png,
                changed.png
            );
            assert_eq!(
                engine
                    .render(format!("{id}-moved-saved"), moved_path, 0, 800)
                    .unwrap()
                    .png,
                moved.png
            );
        }
        assert_eq!(fs::read(source).unwrap(), original);
        eprintln!(
            "{name}: {} blocks; edit/move/bounds/undo/save/reopen/source preservation passed",
            blocks.len()
        );
    }
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn reflow_does_not_overwrite_a_neighbouring_paragraph() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-collision-{}.pdf", std::process::id()));
    let original = pdf("BT /F1 12 Tf 40 700 Td (Original) Tj ET\nBT /F1 12 Tf 40 650 Td (KEEP THIS PARAGRAPH) Tj ET\n",0);
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("collision".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Paragraph && g.text == "Original")
        .unwrap();
    assert_eq!(
        engine
            .edit(
                "collision".into(),
                0,
                EditAction::FlowBlock {
                    page: 0,
                    group: group.id,
                    text: "First\nSecond\nThird\nFourth".into(),
                    width: None,
                    height: None,
                }
            )
            .unwrap_err(),
        PreviewError::TextOverflow
    );
    assert_eq!(
        engine
            .render("collision".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn short_edit_preserves_tj_spacing_fonts_and_shared_content() {
    use lopdf::{content::Content, Document, Object};
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let stream = "BT /F1 12 Tf 0.3 Tc 1.5 Tw 40 700 Td [(2026-) -12 (10-17)] TJ ET\nBT /F1 12 Tf 40 600 Td (KEEP) Tj ET\n";
    let mut source = Document::load_mem(&pdf(stream, 0)).unwrap();
    let page = source.get_object((3, 0)).unwrap().clone();
    let second = source.add_object(page);
    let root = source
        .get_object_mut((2, 0))
        .unwrap()
        .as_dict_mut()
        .unwrap();
    root.set(
        "Kids",
        vec![Object::Reference((3, 0)), Object::Reference(second)],
    );
    root.set("Count", 2);
    let mut original = Vec::new();
    source.save_to(&mut original).unwrap();
    let path = std::env::temp_dir().join(format!("paperkit-patch-{}.pdf", std::process::id()));
    let saved = path.with_extension("saved.pdf");
    fs::write(&path, &original).unwrap();
    let before = engine.render("patch".into(), path.clone(), 0, 800).unwrap();
    let other = engine.render("patch".into(), path.clone(), 1, 800).unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Paragraph && g.text.contains("2026"))
        .unwrap();
    let state = engine
        .edit(
            "patch".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: group.text.replace("17", "18"),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let edited = engine.render("patch".into(), path.clone(), 0, 800).unwrap();
    assert_eq!(
        engine
            .render("patch".into(), path.clone(), 1, 800)
            .unwrap()
            .png,
        other.png
    );
    engine
        .edit(
            "patch".into(),
            state.revision,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    let output = Document::load(&saved).unwrap();
    // This asserts the direct path was used, not a visually similar rebuild.
    assert_eq!(
        output
            .get_object((4, 0))
            .unwrap()
            .as_stream()
            .unwrap()
            .get_plain_content()
            .unwrap(),
        source
            .get_object((4, 0))
            .unwrap()
            .as_stream()
            .unwrap()
            .get_plain_content()
            .unwrap()
    );
    assert_eq!(
        output.get_object((5, 0)).unwrap(),
        source.get_object((5, 0)).unwrap()
    );
    assert_eq!(
        output.get_object(second).unwrap(),
        source.get_object(second).unwrap()
    );
    let commands = Content::decode(&output.get_page_content((3, 0))).unwrap();
    let expected = Content::decode(stream.replace("10-17", "10-18").as_bytes()).unwrap();
    assert_eq!(commands.encode().unwrap(), expected.encode().unwrap());
    engine
        .edit("patch".into(), state.revision, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("patch".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(
        engine
            .render("patch-reopen".into(), saved.clone(), 0, 800)
            .unwrap()
            .png,
        edited.png
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::remove_file(path).unwrap();
    fs::remove_file(saved).unwrap();
}
