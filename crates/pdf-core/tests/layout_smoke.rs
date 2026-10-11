use pdf_core::{
    edit::EditAction,
    layout::GroupKind,
    render::{PreviewEngine, PreviewError},
};
use std::{fs, path::PathBuf};

fn sample() -> Vec<u8> {
    let mut stream = String::new();
    // A sentence made of separately positioned characters with a true word gap.
    for (i, c) in "Hello world.".chars().enumerate() {
        if c == ' ' {
            continue;
        }
        stream.push_str(&format!(
            "BT /F1 16 Tf 1 0 0 1 {} 220 Tm ({c}) Tj ET\n",
            20.0 + i as f32 * 9.6
        ));
    }
    stream.push_str("BT /F1 16 Tf 20 170 Td (First. Second.) Tj ET\nBT /F1 16 Tf 20 120 Td (KEEP) Tj ET\nBT /F1 16 Tf 0 1 -1 0 280 30 Tm (Rotated) Tj ET\n");
    let objects=["<< /Type /Catalog /Pages 2 0 R >>".to_string(),"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".into(),
        format!("<< /Length {} >>\nstream\n{stream}endstream",stream.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".into()];
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{object}\nendobj\n", i + 1).as_bytes());
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
#[ignore = "requires pnpm setup:pdfium"]
fn reconstruct_atomic_edit_undo_save_and_stale_ids() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-layout-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let source = directory.join("source.pdf");
    let original = sample();
    fs::write(&source, &original).unwrap();
    let render = |width| {
        engine
            .render("layout".into(), source.clone(), 0, width)
            .unwrap()
    };
    let before = render(800);
    let sentences: Vec<_> = before
        .text
        .groups
        .iter()
        .filter(|g| g.kind == GroupKind::Sentence)
        .collect();
    assert_eq!(
        sentences
            .iter()
            .map(|g| g.text.as_str())
            .collect::<Vec<_>>(),
        ["Hello world.", "First.", "Second.", "KEEP"]
    );
    let group = sentences[0].id;
    assert_eq!(sentences[0].runs.len(), 11);
    let rotated = before
        .text
        .objects
        .iter()
        .find(|o| o.text == "Rotated")
        .unwrap();
    assert!(!before
        .text
        .groups
        .iter()
        .any(|g| g.runs.iter().any(|r| r.object == rotated.id)));
    let enlarged = render(1600);
    assert_eq!(
        before
            .text
            .groups
            .iter()
            .map(|g| (&g.text, &g.runs, &g.bounds))
            .collect::<Vec<_>>(),
        enlarged
            .text
            .groups
            .iter()
            .map(|g| (&g.text, &g.runs, &g.bounds))
            .collect::<Vec<_>>()
    );
    // The first glyph could succeed, but the unsupported final glyph must roll all of it back.
    assert_eq!(
        engine
            .edit(
                "layout".into(),
                0,
                EditAction::ReplaceGroup {
                    page: 0,
                    group,
                    text: "Heilo worl한.".into()
                }
            )
            .unwrap_err(),
        PreviewError::FontUnavailable
    );
    let rejected = render(800);
    assert_eq!(rejected.state.revision, 0);
    assert_eq!(rejected.png, before.png);
    assert_eq!(
        engine
            .edit(
                "layout".into(),
                0,
                EditAction::ReplaceGroup {
                    page: 0,
                    group,
                    text: "Hello.".into()
                }
            )
            .unwrap_err(),
        PreviewError::LayoutReflowRequired
    );
    let state = engine
        .edit(
            "layout".into(),
            0,
            EditAction::ReplaceGroup {
                page: 0,
                group,
                text: "Heilo worid.".into(),
            },
        )
        .unwrap();
    assert_eq!(state.revision, 1);
    let changed = render(800);
    assert!(changed.text.groups.iter().any(|g| g.text == "Heilo worid."));
    assert_eq!(
        engine
            .edit(
                "layout".into(),
                0,
                EditAction::ReplaceGroup {
                    page: 0,
                    group,
                    text: "Hello world.".into()
                }
            )
            .unwrap_err(),
        PreviewError::StaleObject
    );
    let undo = engine.edit("layout".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(render(800).png, before.png);
    assert!(!undo.can_undo);
    engine.edit("layout".into(), 2, EditAction::Redo).unwrap();
    assert_eq!(render(800).png, changed.png);
    // Edit only the second sentence inside a shared PDF object, retaining its prefix.
    let partial = changed
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Sentence && g.text == "Second.")
        .unwrap()
        .id;
    engine
        .edit(
            "layout".into(),
            3,
            EditAction::ReplaceGroup {
                page: 0,
                group: partial,
                text: "Fourth.".into(),
            },
        )
        .unwrap();
    let final_page = render(800);
    assert!(final_page
        .text
        .objects
        .iter()
        .any(|o| o.text == "First. Fourth."));
    let output = directory.join("saved.pdf");
    engine
        .edit(
            "layout".into(),
            4,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    let reopened = engine.render("saved".into(), output, 0, 800).unwrap();
    assert_eq!(reopened.png, final_page.png);
    let block_page = engine
        .render("block".into(), source.clone(), 0, 800)
        .unwrap();
    let block = block_page
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Paragraph && g.text == "Hello world.")
        .unwrap();
    assert!(block.can_reflow);
    assert_eq!(
        engine
            .edit(
                "block".into(),
                0,
                EditAction::ReflowBlock {
                    page: 0,
                    group: block.id,
                    text: "This block is far too long to fit inside its original line.".into()
                }
            )
            .unwrap_err(),
        PreviewError::TextOverflow
    );
    assert_eq!(
        engine
            .render("block".into(), source.clone(), 0, 800)
            .unwrap()
            .png,
        block_page.png
    );
    engine
        .edit(
            "block".into(),
            0,
            EditAction::ReflowBlock {
                page: 0,
                group: block.id,
                text: "Hi.".into(),
            },
        )
        .unwrap();
    let reflowed = engine
        .render("block".into(), source.clone(), 0, 800)
        .unwrap();
    assert!(reflowed.text.objects.iter().any(|o| o.text == "Hi."));
    assert!(!reflowed.text.objects.iter().any(|o| o.text == "H"));
    engine.edit("block".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("block".into(), source.clone(), 0, 800)
            .unwrap()
            .png,
        block_page.png
    );
    engine.edit("block".into(), 2, EditAction::Redo).unwrap();
    let block_id = reflowed
        .text
        .groups
        .iter()
        .find(|g| g.kind == GroupKind::Paragraph && g.text == "Hi.")
        .unwrap()
        .id;
    engine
        .edit(
            "block".into(),
            3,
            EditAction::ReflowBlock {
                page: 0,
                group: block_id,
                text: String::new(),
            },
        )
        .unwrap();
    assert!(!engine
        .render("block".into(), source.clone(), 0, 800)
        .unwrap()
        .text
        .objects
        .iter()
        .any(|o| o.text == "Hi."));
    engine.edit("block".into(), 4, EditAction::Undo).unwrap();
    let output = directory.join("block.pdf");
    engine
        .edit(
            "block".into(),
            5,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("block-saved".into(), output, 0, 800)
            .unwrap()
            .png,
        reflowed.png
    );
    assert_eq!(fs::read(source).unwrap(), original);
}
