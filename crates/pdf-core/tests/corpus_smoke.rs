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
