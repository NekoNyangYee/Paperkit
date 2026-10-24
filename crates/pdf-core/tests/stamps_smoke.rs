use pdf_core::{edit::EditAction, Paperframe};
use std::{fs, path::PathBuf};

fn document() -> Vec<u8> {
    use lopdf::{dictionary, Document, Object, Stream};
    let mut doc = Document::with_version("1.7");
    let pages = doc.new_object_id();
    let font = doc.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" },
    );
    let mut kids = Vec::new();
    for rotation in [0, 90, 180, 270] {
        let contents = b"0.1 0.4 0.8 rg 0 0 600 800 re f\n0 0 0 rg BT /F1 16 Tf 2 Tc 3 Tw 70 700 Td (KEEP CONTENT) Tj ET\n";
        let stream = doc.add_object(Stream::new(dictionary! {}, contents.to_vec()));
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages, "Contents" => stream,
            "MediaBox" => vec![0.into(), 0.into(), 600.into(), 800.into()],
            "Rotate" => rotation,
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } }
        };
        if rotation == 180 {
            page.set(
                "CropBox",
                vec![40.into(), 60.into(), 560.into(), 740.into()],
            );
        }
        kids.push(Object::Reference(doc.add_object(page)));
    }
    doc.objects.insert(
        pages,
        dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => 4 }.into(),
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    doc.trailer.set("Root", catalog);
    let mut output = Vec::new();
    doc.save_to(&mut output).unwrap();
    output
}

fn transparent_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 4, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[
                255, 0, 0, 128, 255, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 128, 255, 0, 0,
                128, 0, 0, 0, 0, 0, 0, 0, 0,
            ])
            .unwrap();
    }
    bytes
}

fn replacement_png() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[0, 200, 0, 255, 0, 200, 0, 255])
            .unwrap();
    }
    bytes
}

fn pixel(bytes: &[u8], x: u32, y: u32) -> Vec<u8> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut pixels).unwrap();
    let channels = info.color_type.samples();
    let offset = (y * info.width + x) as usize * channels;
    pixels[offset..offset + channels].to_vec()
}

#[test]
#[ignore = "requires bundled Windows PDFium"]
fn watermark_and_signature_preserve_transparency_rotation_history_and_saved_edits() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = Paperframe::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-stamps-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("original.pdf");
    let original = document();
    fs::write(&path, &original).unwrap();
    let id = "stamps".to_owned();
    let before: Vec<_> = (0..4)
        .map(|index| engine.render(id.clone(), path.clone(), index, 800).unwrap())
        .collect();
    let png = transparent_png();
    let state = engine
        .edit(
            id.clone(),
            0,
            serde_json::from_value(serde_json::json!({
                "kind": "addWatermark", "page": null, "png": png, "widthRatio": 0.5
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(state.revision, 1);
    let stamped: Vec<_> = (0..4)
        .map(|index| engine.render(id.clone(), path.clone(), index, 800).unwrap())
        .collect();
    for (index, page) in stamped.iter().enumerate() {
        assert_eq!(page.text.watermark_pages, vec![0, 1, 2, 3]);
        assert_eq!(page.text.watermark_objects.len(), 1);
        assert_eq!(
            page.text.graphics.len(),
            before[index].text.graphics.len() + 1
        );
        assert_eq!(
            page.text.objects[0].text,
            before[index].text.objects[0].text
        );
        let left_x = page.width * 3 / 8;
        let right_x = page.width * 5 / 8;
        let y = page.height / 2;
        let old = pixel(&before[index].png, left_x, y);
        let new = pixel(&page.png, left_x, y);
        assert!(
            new[0] > old[0] + 60,
            "red half must remain on the displayed left on page {index}: {old:?} -> {new:?}"
        );
        assert!(
            new[0] < 230,
            "semi-transparent pixels must blend with the original page"
        );
        assert_eq!(
            pixel(&page.png, right_x, y),
            pixel(&before[index].png, right_x, y),
            "transparent half must preserve the page"
        );
        let image = page
            .text
            .graphics
            .iter()
            .find(|graphic| graphic.kind == "image")
            .unwrap();
        let xs: Vec<_> = image
            .screen_bounds
            .iter()
            .map(|point| point[0] as f32)
            .collect();
        let width = xs.iter().copied().fold(f32::NEG_INFINITY, f32::max)
            - xs.iter().copied().fold(f32::INFINITY, f32::min);
        assert!((width - page.width as f32 * 0.5).abs() < 2.0);
    }
    engine.edit(id.clone(), 1, EditAction::Undo).unwrap();
    for index in 0..4 {
        assert_eq!(
            engine
                .render(id.clone(), path.clone(), index, 800)
                .unwrap()
                .png,
            before[index as usize].png
        );
    }
    engine.edit(id.clone(), 2, EditAction::Redo).unwrap();
    for index in 0..4 {
        assert_eq!(
            engine
                .render(id.clone(), path.clone(), index, 800)
                .unwrap()
                .png,
            stamped[index as usize].png
        );
    }
    engine
        .edit(
            id.clone(),
            3,
            EditAction::AddWatermark {
                page: Some(1),
                png: replacement_png(),
                width_ratio: 0.8,
            },
        )
        .unwrap();
    assert_eq!(
        engine.render(id.clone(), path.clone(), 0, 800).unwrap().png,
        stamped[0].png
    );
    assert_eq!(
        engine
            .render(id.clone(), path.clone(), 1, 800)
            .unwrap()
            .text
            .graphics
            .len(),
        stamped[1].text.graphics.len()
    );
    let replaced = engine.render(id.clone(), path.clone(), 1, 800).unwrap();
    assert_eq!(
        replaced.text.watermark_objects.len(),
        1,
        "replacement must remove the old watermark instead of stacking it"
    );
    assert_eq!(
        &pixel(&replaced.png, replaced.width / 2, replaced.height / 2)[..3],
        &[0, 200, 0]
    );
    engine
        .edit(
            id.clone(),
            4,
            serde_json::from_value(serde_json::json!({
                "kind": "addSignature", "page": 0, "png": png
            }))
            .unwrap(),
        )
        .unwrap();
    let signed = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    let signature = signed.text.graphics.last().unwrap();
    assert_eq!(signature.kind, "image");
    let bounds = |points: &[[f32; 2]]| {
        let left = points.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min);
        let right = points
            .iter()
            .map(|p| p[0])
            .fold(f32::NEG_INFINITY, f32::max);
        let bottom = points.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min);
        let top = points
            .iter()
            .map(|p| p[1])
            .fold(f32::NEG_INFINITY, f32::max);
        [left, bottom, right - left, top - bottom]
    };
    let [left, bottom, width, height] = bounds(&signature.bounds);
    assert!((width - 144.0).abs() < 1.0);
    assert!((height - 72.0).abs() < 1.0);
    engine
        .edit(
            id.clone(),
            5,
            EditAction::TransformGraphic {
                page: 0,
                object: signature.id,
                matrix: [1.2, 0.0, 0.0, 1.2, 20.0 - left * 0.2, 15.0 - bottom * 0.2],
            },
        )
        .unwrap();
    let moved = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
    assert_ne!(moved.png, signed.png);
    let moved_bounds = bounds(&moved.text.graphics.last().unwrap().bounds);
    assert!((moved_bounds[0] - left - 20.0).abs() < 1.0);
    assert!((moved_bounds[2] - width * 1.2).abs() < 1.0);
    for action in [
        EditAction::AddSignature {
            page: 0,
            png: vec![0, 1, 2],
        },
        EditAction::AddSignature {
            page: 10,
            png: png.clone(),
        },
        EditAction::AddWatermark {
            page: None,
            png: png.clone(),
            width_ratio: f32::NAN,
        },
    ] {
        assert!(engine.edit(id.clone(), 6, action).is_err());
        let unchanged = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
        assert_eq!(unchanged.state.revision, 6);
        assert_eq!(unchanged.png, moved.png);
    }
    let output = directory.join("signed-watermarked.pdf");
    engine
        .edit(
            id.clone(),
            6,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("reopened".into(), output.clone(), 0, 800)
            .unwrap()
            .png,
        moved.png
    );
    let reopened = "reopened".to_owned();
    let loaded = engine
        .render(reopened.clone(), output.clone(), 0, 800)
        .unwrap();
    assert_eq!(loaded.text.watermark_pages, vec![0, 1, 2, 3]);
    assert_eq!(
        loaded.text.watermark_objects.len(),
        1,
        "signature must not be tagged"
    );
    // An unrelated image inserted after saving must survive managed removal too.
    engine
        .edit(reopened.clone(), 0, EditAction::PasteImage { page: 0, png })
        .unwrap();
    let with_image = engine
        .render(reopened.clone(), output.clone(), 0, 800)
        .unwrap();
    engine
        .edit(
            reopened.clone(),
            1,
            EditAction::RemoveWatermark { page: Some(1) },
        )
        .unwrap();
    let removed = engine
        .render(reopened.clone(), output.clone(), 1, 800)
        .unwrap();
    assert_eq!(removed.png, before[1].png);
    assert_eq!(removed.text.watermark_pages, vec![0, 2, 3]);
    assert_eq!(
        engine
            .render(reopened.clone(), output.clone(), 0, 800)
            .unwrap()
            .png,
        with_image.png
    );
    engine.edit(reopened.clone(), 2, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render(reopened.clone(), output.clone(), 1, 800)
            .unwrap()
            .text
            .watermark_pages,
        vec![0, 1, 2, 3]
    );
    engine.edit(reopened.clone(), 3, EditAction::Redo).unwrap();
    // Moving a tagged watermark regenerates its stream; its identity must survive.
    let watermark = with_image.text.watermark_objects[0];
    engine
        .edit(
            reopened.clone(),
            4,
            EditAction::TransformGraphic {
                page: 0,
                object: watermark,
                matrix: [1.0, 0.0, 0.0, 1.0, 10.0, 10.0],
            },
        )
        .unwrap();
    let transformed = engine
        .render(reopened.clone(), output.clone(), 0, 800)
        .unwrap();
    assert_eq!(transformed.text.watermark_objects.len(), 1);
    engine
        .edit(
            reopened.clone(),
            5,
            serde_json::from_value(serde_json::json!({"kind":"removeWatermark", "page":null}))
                .unwrap(),
        )
        .unwrap();
    for index in 0..4 {
        let page = engine
            .render(reopened.clone(), output.clone(), index, 800)
            .unwrap();
        assert!(page.text.watermark_pages.is_empty());
        assert!(page.text.watermark_objects.is_empty());
        if index == 0 {
            assert_eq!(page.text.graphics.len(), with_image.text.graphics.len() - 1);
        } else {
            assert_eq!(page.png, before[index as usize].png);
        }
    }
    let cleaned = directory.join("cleaned.pdf");
    engine
        .edit(
            reopened.clone(),
            6,
            EditAction::Save {
                path: cleaned.clone(),
            },
        )
        .unwrap();
    let clean = engine
        .render("cleaned".into(), cleaned.clone(), 0, 800)
        .unwrap();
    assert!(clean.text.watermark_pages.is_empty());
    assert_eq!(
        clean.text.graphics.len(),
        with_image.text.graphics.len() - 1
    );
    let no_op = engine
        .edit(
            "cleaned".into(),
            0,
            EditAction::RemoveWatermark { page: None },
        )
        .unwrap();
    assert_eq!(no_op.revision, 0);
    assert!(!no_op.dirty);
    engine.release("cleaned".into()).unwrap();
    assert_eq!(fs::read(path).unwrap(), original);
    engine.release("reopened".into()).unwrap();
    engine.release(id).unwrap();
    fs::remove_dir_all(directory).unwrap();
}
