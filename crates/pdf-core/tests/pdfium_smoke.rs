use pdf_core::edit::EditAction;
use pdf_core::render::{PreviewEngine, PreviewError};
use pdfium_render::prelude::*;
use std::{fs, io::Cursor, path::PathBuf};

fn two_page_pdf() -> Vec<u8> {
    let streams = ["1 0 0 rg 0 0 200 300 re f\n", "0 0 1 rg 0 0 200 300 re f\n"];
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".into(),
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 5 0 R >>"
            .into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 6 0 R >>"
            .into(),
        format!(
            "<< /Length {} >>\nstream\n{}endstream",
            streams[0].len(),
            streams[0]
        ),
        format!(
            "<< /Length {} >>\nstream\n{}endstream",
            streams[1].len(),
            streams[1]
        ),
    ];
    let mut pdf = b"%PDF-1.7\n".to_vec();
    let mut offsets = vec![0];
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(b"xref\n0 7\n0000000000 65535 f \n");
    for offset in offsets.into_iter().skip(1) {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!("trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    pdf
}

fn text_pdf() -> Vec<u8> {
    let stream =
        "BT /F1 16 Tf 0.2 0.3 0.4 rg 20 220 Td (Hello World) Tj 0 -40 Td (Second Line) Tj ET\n";
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>".into(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /CropBox [10 20 190 280] /Rotate 90 /Resources << /Font << /F1 6 0 R >> >> /Contents 5 0 R >>".into(),
        format!("<< /Length {} >>\nstream\n{}endstream", stream.len(), stream),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".into(),
    ];
    let mut bytes = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = bytes.len();
    bytes.extend_from_slice(b"xref\n0 7\n0000000000 65535 f \n");
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!("trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
    );
    bytes
}

fn korean_pdf(library: &std::path::Path) -> Vec<u8> {
    let pdfium = Pdfium::new(Pdfium::bind_to_library(library).unwrap());
    let mut doc = pdfium.create_new_pdf().unwrap();
    let font_path = PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("Fonts/malgun.ttf");
    let font = doc
        .fonts_mut()
        .load_true_type_from_file(&font_path, true)
        .unwrap();
    let mut page = doc
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::a4())
        .unwrap();
    let mut text =
        PdfPageTextObject::new(&doc, "한글 문서 확인", font, PdfPoints::new(18.0)).unwrap();
    text.translate(PdfPoints::new(50.0), PdfPoints::new(700.0))
        .unwrap();
    page.objects_mut().add_text_object(text).unwrap();
    page.regenerate_content().unwrap();
    drop(page);
    doc.save_to_bytes().unwrap()
}

#[test]
#[ignore = "requires pnpm setup:pdfium (Windows x64 native library)"]
fn native_load_render_navigate_cache_release_and_errors() {
    let library = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src-tauri/resources/pdfium/pdfium.dll");
    assert!(library.is_file(), "Run pnpm setup:pdfium first");
    // pdfium-render binds once per process. Generate the temporary font fixture in a child.
    if let Some(output) = std::env::var_os("PAPERKIT_KOREAN_FIXTURE") {
        fs::write(output, korean_pdf(&library)).unwrap();
        return;
    }
    let directory =
        std::env::temp_dir().join(format!("paperkit-pdfium-smoke-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let path = directory.join("한글 두 페이지.pdf");
    let original = two_page_pdf();
    fs::write(&path, &original).unwrap();
    let korean_path = directory.join("korean.pdf");
    let generator = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "native_load_render_navigate_cache_release_and_errors",
        ])
        .env("PAPERKIT_KOREAN_FIXTURE", &korean_path)
        .output()
        .unwrap();
    assert!(
        generator.status.success(),
        "{}",
        String::from_utf8_lossy(&generator.stdout)
    );
    let engine = PreviewEngine::start(library).unwrap();
    let prefixed_path = directory.join("prefixed.pdf");
    let prefixed = [b"\xef\xbb\xbf".as_slice(), original.as_slice()].concat();
    fs::write(&prefixed_path, &prefixed).unwrap();
    pdf_core::document::inspect_pdf_file(&prefixed_path).unwrap();
    let (progress_send, progress_receive) = std::sync::mpsc::channel();
    let prefixed_page = engine
        .render_with_progress(
            "prefixed".into(),
            prefixed_path.clone(),
            0,
            600,
            Some(Box::new(move |percent| {
                progress_send.send(percent).unwrap();
            })),
        )
        .unwrap();
    assert_eq!(
        progress_receive.iter().collect::<Vec<_>>(),
        vec![15, 40, 85]
    );
    assert_eq!(fs::read(prefixed_path).unwrap(), prefixed);
    let first = engine.render("one".into(), path.clone(), 0, 600).unwrap();
    assert_eq!(prefixed_page.png, first.png);
    assert_eq!(
        (
            first.page_count,
            first.page_index,
            first.width,
            first.height
        ),
        (2, 0, 600, 900)
    );
    let mut decoder = png::Decoder::new(Cursor::new(first.png))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    decoder.next_frame(&mut pixels).unwrap();
    assert_eq!(&pixels[..4], &[255, 0, 0, 255]);
    let second = engine.render("one".into(), path.clone(), 1, 800).unwrap();
    assert_eq!(
        (second.page_index, second.width, second.height),
        (1, 800, 1200)
    );
    let mut decoder = png::Decoder::new(Cursor::new(second.png))
        .read_info()
        .unwrap();
    let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
    decoder.next_frame(&mut pixels).unwrap();
    assert_eq!(&pixels[..4], &[0, 0, 255, 255]);
    assert!(matches!(
        engine.render("one".into(), path.clone(), 2, 600),
        Err(PreviewError::InvalidPage)
    ));
    assert!(matches!(
        engine.render("one".into(), path.clone(), 0, 5000),
        Err(PreviewError::RenderFailed)
    ));
    assert_eq!(fs::read(&path).unwrap(), original);
    assert!(first.text.objects.is_empty());
    let minimum_graphic = engine.render("one".into(), path.clone(), 0, 300).unwrap();
    assert!(minimum_graphic
        .text
        .graphics
        .iter()
        .any(|object| object.kind == "path"));
    fs::write(&path, b"%PDF-1.7\nnot a document").unwrap();
    assert!(engine.render("one".into(), path.clone(), 0, 600).is_ok()); // owned byte snapshot
    engine.release("one".into()).unwrap();
    assert!(matches!(
        engine.render("one".into(), path.clone(), 0, 600),
        Err(PreviewError::InvalidDocument)
    ));
    assert!(matches!(
        engine.render("missing".into(), directory.join("missing.pdf"), 0, 600),
        Err(PreviewError::ReadFailed)
    ));
    let unavailable = PreviewEngine::start(directory.join("missing.dll")).unwrap();
    assert!(matches!(
        unavailable.render("one".into(), path, 0, 600),
        Err(PreviewError::LibraryUnavailable)
    ));

    let source = directory.join("text.pdf");
    let original = text_pdf();
    fs::write(&source, &original).unwrap();
    let first = engine
        .render("edit".into(), source.clone(), 0, 800)
        .unwrap();
    assert_eq!(first.text.objects.len(), 2);
    // A 300px editor page must retain tools even after a same-size thumbnail request.
    let thumbnail = engine
        .render_thumbnail("edit".into(), source.clone(), 0, 300)
        .unwrap();
    assert!(thumbnail.text.objects.is_empty());
    assert!(thumbnail.text.groups.is_empty());
    let minimum = engine
        .render("edit".into(), source.clone(), 0, 300)
        .unwrap();
    assert_eq!(minimum.png, thumbnail.png);
    assert_eq!(minimum.text.objects.len(), first.text.objects.len());
    assert_eq!(minimum.text.groups.len(), first.text.groups.len());
    assert_eq!(minimum.text.warning, first.text.warning);
    for (small, full) in minimum.text.objects.iter().zip(&first.text.objects) {
        assert_eq!(small.id, full.id);
        assert_eq!(small.text, full.text);
        assert_eq!(small.bounds, full.bounds);
        assert_eq!(small.edit_blocked, full.edit_blocked);
    }
    let large_thumbnail = engine
        .render_thumbnail("edit".into(), source.clone(), 0, 800)
        .unwrap();
    assert!(large_thumbnail.text.objects.is_empty());
    assert_eq!(large_thumbnail.png, first.png);
    let text = &first.text.objects[0];
    assert_eq!(text.text, "Hello World");
    assert_eq!(text.font_size, 16.0);
    assert_eq!(text.color, [51, 77, 102, 255]);
    assert_eq!(text.edit_blocked, None, "font {}", text.font);
    // CropBox and Rotate are mapped using the exact same PDFium render configuration.
    for width in [300, 400, 800, 1600] {
        let rotated = engine
            .render("edit".into(), source.clone(), 1, width)
            .unwrap();
        let mut decoder = png::Decoder::new(Cursor::new(rotated.png))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; decoder.output_buffer_size().unwrap()];
        decoder.next_frame(&mut pixels).unwrap();
        let quads = &rotated.text.objects;
        let mut ink = 0;
        for y in 0..rotated.height {
            for x in 0..rotated.width {
                let offset = ((y * rotated.width + x) * 4) as usize;
                if pixels[offset] < 180 {
                    ink += 1;
                    assert!(
                        quads.iter().any(|q| {
                            let min_x = q.screen_bounds.iter().map(|p| p[0]).min().unwrap() - 2;
                            let max_x = q.screen_bounds.iter().map(|p| p[0]).max().unwrap() + 2;
                            let min_y = q.screen_bounds.iter().map(|p| p[1]).min().unwrap() - 2;
                            let max_y = q.screen_bounds.iter().map(|p| p[1]).max().unwrap() + 2;
                            (min_x..=max_x).contains(&(x as i32))
                                && (min_y..=max_y).contains(&(y as i32))
                        }),
                        "ink outside text bounds at {x},{y} width {width}"
                    );
                }
            }
        }
        assert!(ink > 100);
    }
    let replace = |value: &str| EditAction::Replace {
        page: 0,
        object: text.id,
        text: value.into(),
    };
    assert!(matches!(
        engine.edit("edit".into(), 0, replace("한글")),
        Err(PreviewError::FontUnavailable)
    ));
    assert!(matches!(
        engine.edit(
            "edit".into(),
            0,
            replace("Very long text that must overflow the old object")
        ),
        Err(PreviewError::TextOverflow)
    ));
    let state = engine.edit("edit".into(), 0, replace("Hello PDF")).unwrap();
    assert!(state.dirty && state.can_undo && !state.can_redo);
    assert_eq!(state.revision, 1);
    assert!(matches!(
        engine.edit("edit".into(), 0, replace("Old")),
        Err(PreviewError::StaleObject)
    ));
    let edited = engine
        .render("edit".into(), source.clone(), 0, 800)
        .unwrap();
    assert_eq!(edited.text.objects[0].text, "Hello PDF");
    assert_eq!(edited.text.objects[1].text, "Second Line");
    assert_eq!(fs::read(&source).unwrap(), original);
    // Loading, editing and releasing a second tab must preserve the first tab's
    // in-memory PDF, revision, dirty flag and undo history.
    let other = engine
        .render("other-tab".into(), source.clone(), 0, 800)
        .unwrap();
    assert_eq!(other.text.objects[0].text, "Hello World");
    assert!(!other.state.dirty);
    engine
        .edit("other-tab".into(), 0, replace("Other PDF"))
        .unwrap();
    let first_tab = engine
        .render("edit".into(), source.clone(), 0, 800)
        .unwrap();
    assert_eq!(first_tab.text.objects[0].text, "Hello PDF");
    assert_eq!(first_tab.state.revision, 1);
    assert!(first_tab.state.dirty && first_tab.state.can_undo);
    let second_tab = engine
        .render("other-tab".into(), source.clone(), 0, 800)
        .unwrap();
    assert_eq!(second_tab.text.objects[0].text, "Other PDF");
    engine.release("other-tab".into()).unwrap();
    let undo = engine.edit("edit".into(), 1, EditAction::Undo).unwrap();
    assert!(!undo.dirty && undo.can_redo);
    assert_eq!(
        engine
            .render("edit".into(), source.clone(), 0, 800)
            .unwrap()
            .text
            .objects[0]
            .text,
        "Hello World"
    );
    let redo = engine.edit("edit".into(), 2, EditAction::Redo).unwrap();
    assert!(redo.dirty);
    assert!(matches!(
        engine.edit(
            "edit".into(),
            3,
            EditAction::Save {
                path: source.clone()
            }
        ),
        Err(PreviewError::TargetExists)
    ));
    let linked = directory.join("source-link.pdf");
    fs::hard_link(&source, &linked).unwrap();
    assert!(matches!(
        engine.edit("edit".into(), 3, EditAction::Save { path: linked }),
        Err(PreviewError::TargetExists)
    ));
    let output = directory.join("edited.pdf");
    let saved = engine
        .edit(
            "edit".into(),
            3,
            EditAction::Save {
                path: output.clone(),
            },
        )
        .unwrap();
    assert!(!saved.dirty);
    assert_eq!(fs::read(&source).unwrap(), original);
    let reopened = engine.render("saved".into(), output, 0, 800).unwrap();
    assert_eq!(reopened.text.objects[0].text, "Hello PDF");
    assert_eq!(reopened.png, edited.png);
    assert!(!fs::read_dir(&directory).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    let rendered = engine.render("korean".into(), korean_path, 0, 800).unwrap();
    assert_eq!(rendered.text.objects[0].text, "한글 문서 확인");
    assert!(rendered.text.objects[0].edit_blocked.is_none());
    assert!(engine
        .edit(
            "korean".into(),
            0,
            EditAction::Replace {
                page: 0,
                object: 0,
                text: "Hello".into()
            }
        )
        .is_ok());
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let restricted = engine
        .render("restricted".into(), fixtures.join("restricted.pdf"), 0, 800)
        .unwrap();
    assert!(restricted.text.objects.is_empty());
    assert!(restricted.text.warning.unwrap().contains("권한"));
    assert!(matches!(
        engine.edit(
            "restricted".into(),
            0,
            EditAction::Replace {
                page: 0,
                object: 0,
                text: "Test".into()
            }
        ),
        Err(PreviewError::StaleObject)
    ));
    assert!(matches!(
        engine.render("password".into(), fixtures.join("password.pdf"), 0, 800),
        Err(PreviewError::PasswordRequired)
    ));
}
