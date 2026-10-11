use pdf_core::{
    edit::EditAction,
    fonts,
    render::{PreviewEngine, PreviewError},
};
use pdfium_render::prelude::*;
use std::{fs, path::PathBuf};

fn sample() -> Vec<u8> {
    sample_font("Courier")
}

#[test]
#[ignore = "requires bundled PDFium and fonts"]
fn imported_original_face_edits_and_saves_without_os_installation() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let font_path = resources.join("fonts/Pretendard-Bold.ttf");
    assert!(fonts::import_original(&font_path, &["Pretendard-Regular".into()]).is_err());
    let name = "Pretendard-Bold";
    assert_eq!(
        fonts::import_original(&font_path, &[format!("ABCDEF+{name}")]).unwrap(),
        vec![format!("ABCDEF+{name}")]
    );
    // No bundled font directory is registered with this engine. The face comes
    // from the session registry; the test never installs fonts into Windows.
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-imported-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("source.pdf");
    let original = sample_font_stream(name, "BT /F1 16 Tf 20 220 Td (iiiiiiii) Tj ET\n");
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("imported".into(), path.clone(), 0, 800)
        .unwrap();
    let object = &before.text.objects[0];
    assert_eq!(
        engine.font("imported".into(), 0, 0, object.id).unwrap(),
        fs::read(&font_path).unwrap()
    );
    let state = engine
        .edit(
            "imported".into(),
            0,
            EditAction::Replace {
                page: 0,
                object: object.id,
                text: "가나".into(),
            },
        )
        .unwrap();
    let edited = engine
        .render("imported".into(), path.clone(), 0, 800)
        .unwrap();
    assert!(edited
        .text
        .objects
        .iter()
        .any(|o| o.text.contains("가나") && o.font.contains(name)));
    let output = directory.join("saved.pdf");
    engine
        .edit(
            "imported".into(),
            state.revision,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    let reopened = engine.render("reopened".into(), output, 0, 800).unwrap();
    assert_eq!(reopened.png, edited.png);
    assert_eq!(fs::read(path).unwrap(), original);
}

fn sample_font(name: &str) -> Vec<u8> {
    let stream = "BT /F1 16 Tf 0.2 0.3 0.4 rg 20 220 Td (iiiiiiii) Tj 0 -40 Td (KEEP) Tj ET\n";
    sample_font_stream(name, stream)
}

fn sample_font_stream(name: &str, stream: &str) -> Vec<u8> {
    let objects = ["<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>".into(),
        format!("<< /Length {} >>\nstream\n{}endstream",stream.len(),stream),
        format!("<< /Type /Font /Subtype /Type1 /BaseFont /{name} /Encoding /WinAnsiEncoding >>")];
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
#[ignore = "requires bundled PDFium"]
fn flexible_edit_changes_only_requested_font_runs_and_roundtrips() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-flexible-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("original.pdf");
    let original = sample_font_stream("Courier", "BT /F1 12 Tf 20 250 Td (First) Tj ET\nBT /F1 12 Tf 58 250 Td (keep) Tj ET\nBT /F1 12 Tf 20 80 Td (UNTOUCHED) Tj ET\n");
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("flexible".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.runs.len() == 2)
        .expect("two source runs in one paragraph");
    let first = group.runs[0].object;
    let value = group.text.replace("First", "Edited");
    let state = engine
        .edit(
            "flexible".into(),
            0,
            serde_json::from_value(serde_json::json!({
                "kind": "flexibleEdit",
                "page": 0,
                "groups": [group.id],
                "text": value,
                "fonts": {first.to_string(): "pretendard-bold"}
            }))
            .unwrap(),
        )
        .unwrap();
    assert_eq!(state.revision, 1);
    let after = engine
        .render("flexible".into(), path.clone(), 0, 800)
        .unwrap();
    let edited_object = after
        .text
        .objects
        .iter()
        .find(|o| o.text.contains("Edited"))
        .unwrap();
    assert!(engine
        .font_for_text(
            "flexible".into(),
            1,
            0,
            edited_object.id,
            Some("한글".into())
        )
        .is_ok());
    assert!(engine
        .font_for_text(
            "flexible".into(),
            1,
            0,
            edited_object.id,
            Some("\u{10ffff}".into())
        )
        .is_err());
    assert!(after.text.objects.iter().any(|o| o.text.contains("Edited")
        && o.font.contains("Pretendard")
        && o.font.contains("Bold")));
    assert!(after
        .text
        .objects
        .iter()
        .any(|o| o.text.contains("keep") && o.font == "Courier"));
    let untouched = before
        .text
        .objects
        .iter()
        .find(|o| o.text.contains("UNTOUCHED"))
        .unwrap();
    assert!(after.text.objects.iter().any(|o| o.text == untouched.text
        && o.matrix == untouched.matrix
        && o.font == untouched.font));
    let saved = directory.join("edited.pdf");
    engine
        .edit(
            "flexible".into(),
            1,
            EditAction::Save {
                path: saved.clone(),
            },
        )
        .unwrap();
    engine.edit("flexible".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("flexible".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(
        engine.render("reopened".into(), saved, 0, 800).unwrap().png,
        after.png
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
#[ignore = "requires bundled PDFium"]
fn editing_preserves_spacing_in_other_text() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let path =
        std::env::temp_dir().join(format!("paperkit-edit-spacing-{}.pdf", std::process::id()));
    let original = sample_font_stream("Courier", "BT /F1 12 Tf 20 260 Td (Edit me) Tj ET\nBT /F1 12 Tf 20 100 Td 1.25 Tc 2.5 Tw [(Keep) -250 ( these words)] TJ ET\n");
    fs::write(&path, &original).unwrap();
    let before = engine
        .render("spacing-edit".into(), path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.text.contains("Edit me"))
        .unwrap();
    engine
        .edit(
            "spacing-edit".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: "Edited now".into(),
                width: None,
                height: None,
            },
        )
        .unwrap();
    let after = engine
        .render("spacing-edit".into(), path.clone(), 0, 800)
        .unwrap();
    assert!(after.text.objects.iter().any(|o| o.text == "Edited now"));
    let keep = before
        .text
        .objects
        .iter()
        .find(|o| o.text.starts_with("Keep"))
        .unwrap();
    assert!(after
        .text
        .objects
        .iter()
        .any(|o| o.text == keep.text && o.bounds == keep.bounds));
    engine
        .edit("spacing-edit".into(), 1, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("spacing-edit".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    engine
        .edit(
            "spacing-edit".into(),
            2,
            EditAction::Replace {
                page: 0,
                object: 0,
                text: "New me".into(),
            },
        )
        .unwrap();
    let edited = engine
        .render("spacing-edit".into(), path.clone(), 0, 800)
        .unwrap();
    let output = path.with_extension("saved.pdf");
    engine
        .edit(
            "spacing-edit".into(),
            3,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("spacing-saved".into(), output, 0, 800)
            .unwrap()
            .png,
        edited.png
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
#[ignore = "requires bundled PDFium and fonts"]
fn block_font_change_reflows_beyond_original_height_and_saves() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-flex-font-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("original.pdf");
    let original = sample_font_stream("Courier", "BT /F1 16 Tf 20 260 Td (iiiiiiii) Tj 0 -20 Td (iiiiiiii) Tj ET\nBT /F1 10 Tf 200 30 Td (KEEP) Tj ET\n");
    fs::write(&path, &original).unwrap();
    let before = engine.render("flex".into(), path.clone(), 0, 800).unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_change_font && g.text.contains("iiiiiiii"))
        .unwrap();
    let state = engine
        .edit(
            "flex".into(),
            0,
            EditAction::ChangeBlockFont {
                page: 0,
                group: group.id,
                font: "pretendard".into(),
                text: Some("Wider letters wrap into more lines than the original block.".into()),
                width: Some(100.0),
                height: Some(20.0),
            },
        )
        .unwrap();
    let changed = engine.render("flex".into(), path.clone(), 0, 800).unwrap();
    let edited: Vec<_> = changed
        .text
        .objects
        .iter()
        .filter(|o| o.text != "KEEP")
        .collect();
    assert!(edited.len() > 2);
    assert!(edited.iter().all(|o| o.font.starts_with("Pretendard")));
    assert!(changed
        .text
        .objects
        .iter()
        .any(|o| o.text == "KEEP" && o.matrix[4] == 200.0));
    let output = directory.join("saved.pdf");
    engine
        .edit(
            "flex".into(),
            state.revision,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    engine
        .edit("flex".into(), state.revision, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("flex".into(), path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    assert_eq!(
        engine
            .render("reopened".into(), output, 0, 800)
            .unwrap()
            .png,
        changed.png
    );
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
#[ignore = "requires Windows installed Korean fonts and bundled PDFium"]
fn installed_exact_face_is_used_and_missing_face_never_auto_replaced() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let directory =
        std::env::temp_dir().join(format!("paperkit-preserve-font-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    for name in [
        "MalgunGothicBold",
        "Gulim",
        "Pretendard-Bold",
        "PaperkitMissingFont-Bold",
    ] {
        // A non-embedded custom face exercises lookup in the shipped font pack.
        // Keep this case separate from PDFium's ambiguous same-name mixture of
        // embedded and substituted faces, which the save verifier rejects.
        let original = if name == "Pretendard-Bold" {
            sample_font_stream(
                name,
                "BT /F1 16 Tf 0.2 0.3 0.4 rg 20 220 Td (iiiiiiii) Tj ET\n",
            )
        } else {
            sample_font(name)
        };
        let path = directory.join(format!("{name}.pdf"));
        fs::write(&path, &original).unwrap();
        let id = name.to_owned();
        let before = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
        let object = &before.text.objects[0];
        eprintln!("requested {name}; extracted {}", object.font);
        if name != "PaperkitMissingFont-Bold" {
            assert!(object.edit_blocked.is_none(), "{:?}", object.edit_blocked);
            assert!(
                before
                    .text
                    .objects
                    .iter()
                    .all(|item| item.font_object_id == object.id),
                "objects sharing one reusable font must share its page-local representative"
            );
            let bytes = engine.font(id.clone(), 0, 0, object.id).unwrap();
            assert_eq!(
                ttf_parser::Face::parse(&bytes, 0).unwrap().is_bold(),
                name.contains("Bold")
            );
            engine
                .edit(
                    id.clone(),
                    0,
                    EditAction::Replace {
                        page: 0,
                        object: object.id,
                        text: "iiii".into(),
                    },
                )
                .unwrap();
            let changed = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
            assert!(changed
                .text
                .objects
                .iter()
                .all(|o| !o.font.contains("Pretendard") || name == "Pretendard-Bold"));
            assert!(changed
                .text
                .objects
                .iter()
                .any(|o| o.text == "iiii" && o.font == name));
            let output = directory.join("saved.pdf");
            if output.exists() {
                fs::remove_file(&output).unwrap();
            }
            engine
                .edit(
                    id.clone(),
                    1,
                    EditAction::Save {
                        path: output.clone(),
                    },
                )
                .unwrap();
            assert_eq!(
                engine
                    .render("reopened".into(), output, 0, 800)
                    .unwrap()
                    .png,
                changed.png
            );
        } else {
            assert!(object.edit_blocked.is_some());
            let group = before.text.groups.iter().find(|g| g.can_flow).unwrap();
            assert_eq!(
                engine
                    .edit(
                        id.clone(),
                        0,
                        EditAction::FlowBlock {
                            page: 0,
                            group: group.id,
                            text: "New text".into(),
                            width: None,
                            height: None
                        }
                    )
                    .unwrap_err(),
                PreviewError::FontUnavailable
            );
            let unchanged = engine.render(id.clone(), path.clone(), 0, 800).unwrap();
            assert_eq!(unchanged.state.revision, 0);
            assert_eq!(unchanged.png, before.png);
        }
        assert_eq!(fs::read(&path).unwrap(), original);
    }
}

#[test]
#[ignore = "requires PDFium and pnpm setup:fonts"]
fn bundled_fonts_change_undo_save_reopen() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    if let Some(directory) = std::env::var_os("PAPERKIT_FONT_FIXTURES") {
        let directory = PathBuf::from(directory);
        let pdfium =
            Pdfium::new(Pdfium::bind_to_library(resources.join("pdfium/pdfium.dll")).unwrap());
        for font in fonts::catalog() {
            if fonts::load(&resources.join("fonts"), &font.id, "한글").is_err() {
                continue;
            }
            let mut doc = pdfium.create_new_pdf().unwrap();
            let token = doc
                .fonts_mut()
                .load_true_type_from_file(&resources.join("fonts").join(&font.file), true)
                .unwrap();
            let mut page = doc
                .pages_mut()
                .create_page_at_end(PdfPagePaperSize::a4())
                .unwrap();
            page.objects_mut()
                .create_text_object(
                    PdfPoints::new(50.0),
                    PdfPoints::new(700.0),
                    "한글 문서 확인 English 123",
                    token,
                    PdfPoints::new(18.0),
                )
                .unwrap();
            drop(page);
            fs::write(
                directory.join(format!("{}-korean.pdf", font.id)),
                doc.save_to_bytes().unwrap(),
            )
            .unwrap();
            if font.id == "pretendard" {
                let mut page = doc
                    .pages_mut()
                    .create_page_at_end(PdfPagePaperSize::a4())
                    .unwrap();
                for (i, word) in ["한글", "문서", "확인."].iter().enumerate() {
                    page.objects_mut()
                        .create_text_object(
                            PdfPoints::new(50.0 + i as f32 * 42.0),
                            PdfPoints::new(700.0),
                            *word,
                            token,
                            PdfPoints::new(18.0),
                        )
                        .unwrap();
                }
                drop(page);
                fs::write(
                    directory.join("korean-words.pdf"),
                    doc.save_to_bytes().unwrap(),
                )
                .unwrap();
                let mut page = doc
                    .pages_mut()
                    .create_page_at_end(PdfPagePaperSize::a4())
                    .unwrap();
                for (i, line) in ["한글 문서 내용을 확인합니다.", "둘째 줄입니다."]
                    .iter()
                    .enumerate()
                {
                    page.objects_mut()
                        .create_text_object(
                            PdfPoints::new(50.0),
                            PdfPoints::new(700.0 - i as f32 * 24.0),
                            *line,
                            token,
                            PdfPoints::new(18.0),
                        )
                        .unwrap();
                }
                drop(page);
                fs::write(
                    directory.join("korean-block.pdf"),
                    doc.save_to_bytes().unwrap(),
                )
                .unwrap();
            }
        }
        let mut doc = pdfium.create_new_pdf().unwrap();
        let token = doc
            .fonts_mut()
            .load_true_type_from_file(&PathBuf::from("C:/Windows/Fonts/malgun.ttf"), true)
            .unwrap();
        let mut page = doc
            .pages_mut()
            .create_page_at_end(PdfPagePaperSize::a4())
            .unwrap();
        for (i, line) in ["한글 문서 내용을 확인합니다.", "둘째 줄입니다."]
            .iter()
            .enumerate()
        {
            page.objects_mut()
                .create_text_object(
                    PdfPoints::new(50.0),
                    PdfPoints::new(700.0 - i as f32 * 24.0),
                    *line,
                    token,
                    PdfPoints::new(18.0),
                )
                .unwrap();
        }
        drop(page);
        fs::write(
            directory.join("unsupported-font.pdf"),
            doc.save_to_bytes().unwrap(),
        )
        .unwrap();
        return;
    }
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let directory = std::env::temp_dir().join(format!("paperkit-font-test-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let generator = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "bundled_fonts_change_undo_save_reopen",
        ])
        .env("PAPERKIT_FONT_FIXTURES", &directory)
        .output()
        .unwrap();
    assert!(
        generator.status.success(),
        "{}",
        String::from_utf8_lossy(&generator.stdout)
    );
    let original = sample();
    let source = directory.join("original.pdf");
    fs::write(&source, &original).unwrap();
    for font in fonts::catalog() {
        let id = font.id.clone();
        let before = engine.render(id.clone(), source.clone(), 0, 800).unwrap();
        assert_eq!(before.text.objects[0].font_change_blocked, None);
        let state = engine
            .edit(
                id.clone(),
                0,
                EditAction::ChangeFont {
                    page: 0,
                    object: 0,
                    font: font.id.clone(),
                },
            )
            .unwrap_or_else(|e| panic!("{}: {e:?}", font.name));
        assert!(state.dirty);
        let after = engine.render(id.clone(), source.clone(), 0, 800).unwrap();
        let changed = after
            .text
            .objects
            .iter()
            .find(|o| o.text == "iiiiiiii")
            .unwrap();
        eprintln!("{} -> {}", font.name, changed.font);
        let mut remaining = after
            .text
            .objects
            .iter()
            .find(|o| o.text == "KEEP")
            .unwrap()
            .clone();
        remaining.id = 1;
        // Replacing an earlier object may change the representative object for
        // an unchanged font. Compare document properties, not this cache key.
        let mut expected_remaining = before.text.objects[1].clone();
        remaining.font_object_id = 0;
        expected_remaining.font_object_id = 0;
        assert_eq!(remaining, expected_remaining);
        assert!(fonts::known_name(&changed.font));
        assert_eq!(changed.edit_blocked, None);
        assert!(matches!(
            engine.edit(
                id.clone(),
                1,
                EditAction::Replace {
                    page: 0,
                    object: changed.id,
                    text: "\u{10ffff}".into()
                }
            ),
            Err(PreviewError::MissingGlyph)
        ));
        engine.edit(id.clone(), 1, EditAction::Undo).unwrap();
        assert_eq!(
            engine
                .render(id.clone(), source.clone(), 0, 800)
                .unwrap()
                .text
                .objects[0]
                .font,
            "Courier"
        );
        engine.edit(id.clone(), 2, EditAction::Redo).unwrap();
        let output = directory.join(format!("{}.pdf", font.id));
        engine
            .edit(
                id.clone(),
                3,
                EditAction::Save {
                    path: output.clone(),
                },
            )
            .unwrap();
        let reopened = engine
            .render(format!("saved-{id}"), output, 0, 800)
            .unwrap();
        assert_eq!(after.text.objects, reopened.text.objects);
        assert_eq!(after.png, reopened.png);
        if fonts::load(&resources.join("fonts"), &font.id, "한글").is_err() {
            continue;
        }
        let korean_id = format!("korean-{id}");
        let korean_path = directory.join(format!("{}-korean.pdf", font.id));
        let korean = engine
            .render(korean_id.clone(), korean_path.clone(), 0, 800)
            .unwrap();
        assert_eq!(korean.text.objects[0].text, "한글 문서 확인 English 123");
        engine
            .edit(
                korean_id.clone(),
                0,
                EditAction::ChangeFont {
                    page: 0,
                    object: 0,
                    font: font.id.clone(),
                },
            )
            .unwrap();
        engine
            .edit(
                korean_id.clone(),
                1,
                EditAction::Replace {
                    page: 0,
                    object: 0,
                    text: "한글 문서".into(),
                },
            )
            .unwrap();
        let korean_edited = engine
            .render(korean_id.clone(), korean_path, 0, 800)
            .unwrap();
        assert_eq!(korean_edited.text.objects[0].text, "한글 문서");
        let output = directory.join(format!("{}-korean-edited.pdf", font.id));
        engine
            .edit(
                korean_id,
                2,
                EditAction::Save {
                    path: output.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            engine
                .render(format!("korean-saved-{id}"), output, 0, 800)
                .unwrap()
                .png,
            korean_edited.png
        );
    }
    let words_path = directory.join("korean-words.pdf");
    let words = engine
        .render("words".into(), words_path.clone(), 1, 800)
        .unwrap();
    let group = words
        .text
        .groups
        .iter()
        .find(|g| g.kind == pdf_core::layout::GroupKind::Sentence && g.text == "한글 문서 확인.")
        .expect("Korean word objects form one sentence");
    assert_eq!(group.runs.len(), 3);
    engine
        .edit(
            "words".into(),
            0,
            EditAction::ReplaceGroup {
                page: 1,
                group: group.id,
                text: "한글 문장 확인.".into(),
            },
        )
        .unwrap();
    let changed = engine
        .render("words".into(), words_path.clone(), 1, 800)
        .unwrap();
    assert!(changed
        .text
        .groups
        .iter()
        .any(|g| g.text == "한글 문장 확인."));
    engine.edit("words".into(), 1, EditAction::Undo).unwrap();
    assert_eq!(
        engine
            .render("words".into(), words_path, 1, 800)
            .unwrap()
            .png,
        words.png
    );
    let block_path = directory.join("korean-block.pdf");
    let block_page = engine
        .render("korean-block".into(), block_path.clone(), 2, 800)
        .unwrap();
    let group = block_page
        .text
        .groups
        .iter()
        .find(|g| g.kind == pdf_core::layout::GroupKind::Paragraph && g.bounds.len() == 2)
        .unwrap();
    assert!(group.can_reflow);
    engine
        .edit(
            "korean-block".into(),
            0,
            EditAction::ReflowBlock {
                page: 2,
                group: group.id,
                text: "한글 내용을\n새로 씁니다.".into(),
            },
        )
        .unwrap();
    let changed = engine
        .render("korean-block".into(), block_path.clone(), 2, 800)
        .unwrap();
    assert_eq!(
        changed
            .text
            .objects
            .iter()
            .map(|o| o.text.trim())
            .collect::<Vec<_>>(),
        ["한글 내용을", "새로 씁니다."]
    );
    let output = directory.join("korean-block-saved.pdf");
    engine
        .edit(
            "korean-block".into(),
            1,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("block-reopened".into(), output, 2, 800)
            .unwrap()
            .png,
        changed.png
    );
    let automatic = engine
        .render("automatic".into(), block_path.clone(), 2, 800)
        .unwrap();
    let group = automatic
        .text
        .groups
        .iter()
        .find(|g| g.kind == pdf_core::layout::GroupKind::Paragraph && g.bounds.len() == 2)
        .unwrap();
    let value = "한글 문서 내용을 새롭게 바꾸고 저장합니다.";
    engine
        .edit(
            "automatic".into(),
            0,
            EditAction::ReflowBlock {
                page: 2,
                group: group.id,
                text: value.into(),
            },
        )
        .unwrap();
    let wrapped = engine
        .render("automatic".into(), block_path, 2, 800)
        .unwrap();
    assert_eq!(wrapped.text.objects.len(), 2);
    assert_eq!(
        wrapped
            .text
            .objects
            .iter()
            .flat_map(|o| o.text.chars())
            .filter(|c| !c.is_whitespace())
            .collect::<String>(),
        value
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    );
    let unsupported_path = directory.join("unsupported-font.pdf");
    let unsupported_bytes = fs::read(&unsupported_path).unwrap();
    let before = engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.kind == pdf_core::layout::GroupKind::Paragraph)
        .unwrap();
    assert!(group.edit_blocked.is_none());
    assert!(group.can_reflow);
    assert!(group.can_flow);
    let font_bytes = engine
        .font("unsupported".into(), 0, 0, before.text.objects[0].id)
        .unwrap();
    assert!(font_bytes.len() > 1000);
    assert!(group.can_change_font);
    engine
        .edit(
            "unsupported".into(),
            0,
            EditAction::Move {
                page: 0,
                group: Some(group.id),
                object: None,
                dx: 20.0,
                dy: -10.0,
            },
        )
        .unwrap();
    let moved = engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    assert_eq!(moved.text.objects[0].font, before.text.objects[0].font);
    assert!(
        (moved.text.objects[0].matrix[4] - before.text.objects[0].matrix[4] - 20.0).abs() < 0.01
    );
    engine
        .edit("unsupported".into(), 1, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("unsupported".into(), unsupported_path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    engine
        .edit(
            "unsupported".into(),
            2,
            EditAction::EditWithFallback {
                page: 0,
                group: Some(group.id),
                object: None,
                text: "바로 수정합니다.".into(),
            },
        )
        .unwrap();
    let direct = engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    assert!(direct
        .text
        .objects
        .iter()
        .any(|o| o.text == "바로 수정합니다." && o.font.starts_with("Pretendard")));
    engine
        .edit("unsupported".into(), 3, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("unsupported".into(), unsupported_path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    // Start a fresh document session for the explicit font-change regression.
    engine
        .render(
            "unsupported-explicit".into(),
            unsupported_path.clone(),
            0,
            800,
        )
        .unwrap();
    engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    engine
        .edit(
            "unsupported".into(),
            0,
            EditAction::ChangeBlockFont {
                text: None,
                width: None,
                height: None,
                page: 0,
                group: group.id,
                font: "pretendard".into(),
            },
        )
        .unwrap();
    let converted = engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    assert!(converted
        .text
        .objects
        .iter()
        .all(|o| fonts::known_name(&o.font) && o.edit_blocked.is_none()));
    engine
        .edit("unsupported".into(), 1, EditAction::Undo)
        .unwrap();
    assert_eq!(
        engine
            .render("unsupported".into(), unsupported_path.clone(), 0, 800)
            .unwrap()
            .png,
        before.png
    );
    engine
        .edit("unsupported".into(), 2, EditAction::Redo)
        .unwrap();
    let group = converted
        .text
        .groups
        .iter()
        .find(|g| g.kind == pdf_core::layout::GroupKind::Paragraph && g.can_reflow)
        .unwrap();
    engine
        .edit(
            "unsupported".into(),
            3,
            EditAction::ReflowBlock {
                page: 0,
                group: group.id,
                text: "내용을 수정합니다.".into(),
            },
        )
        .unwrap();
    let edited = engine
        .render("unsupported".into(), unsupported_path.clone(), 0, 800)
        .unwrap();
    let output = directory.join("converted-edited.pdf");
    engine
        .edit(
            "unsupported".into(),
            4,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("converted-reopened".into(), output, 0, 800)
            .unwrap()
            .png,
        edited.png
    );
    let original_font_page = engine
        .render(
            "original-font-flow".into(),
            unsupported_path.clone(),
            0,
            800,
        )
        .unwrap();
    let group = original_font_page
        .text
        .groups
        .iter()
        .find(|g| g.can_flow)
        .unwrap();
    let value =
        "원본 글꼴을 유지하면서 기존보다 훨씬 긴 내용을 입력하고 여러 줄로 자유롭게 편집합니다. "
            .repeat(3);
    engine
        .edit(
            "original-font-flow".into(),
            0,
            EditAction::FlowBlock {
                page: 0,
                group: group.id,
                text: value,
                width: Some(300.0),
                height: Some(200.0),
            },
        )
        .unwrap();
    let flowed = engine
        .render(
            "original-font-flow".into(),
            unsupported_path.clone(),
            0,
            800,
        )
        .unwrap();
    assert!(flowed.text.objects.len() > original_font_page.text.objects.len());
    assert!(flowed
        .text
        .objects
        .iter()
        .all(|o| o.font == original_font_page.text.objects[0].font));
    let output = directory.join("original-font-flow.pdf");
    engine
        .edit(
            "original-font-flow".into(),
            1,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert_eq!(
        engine
            .render("original-font-flow-reopen".into(), output, 0, 800)
            .unwrap()
            .png,
        flowed.png
    );
    assert_eq!(fs::read(unsupported_path).unwrap(), unsupported_bytes);
    assert_eq!(fs::read(source).unwrap(), original);
}
