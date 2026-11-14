//! Opt-in regression runner: reads a local sample, never overwrites or embeds it.
use pdf_core::{edit::EditAction, EngineError, Paperframe};
use std::{collections::BTreeSet, path::PathBuf};

#[test]
#[ignore = "set PAPERKIT_EDIT_REGRESSION_PDF; measures local edit preparation"]
fn measure_local_edit_preparation() {
    let path = PathBuf::from(std::env::var_os("PAPERKIT_EDIT_REGRESSION_PDF").unwrap());
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine =
        Paperframe::start_with_fonts(resources.join("pdfium/pdfium.dll"), resources.join("fonts"))
            .unwrap();
    let before = engine
        .render("prepare".into(), path.clone(), 0, 1600)
        .unwrap();
    let group = before
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.text.chars().count() > 100)
        .unwrap();
    let ids: Vec<_> = group.runs.iter().map(|r| r.object).collect();
    let mut expected = None;
    for attempt in 0..2 {
        let start = std::time::Instant::now();
        let background = engine
            .layer("prepare".into(), 0, 0, 1600, ids.clone(), false)
            .unwrap();
        println!("background attempt={attempt}: {:?}", start.elapsed());
        let start = std::time::Instant::now();
        let foreground = engine
            .layer("prepare".into(), 0, 0, 1600, ids.clone(), true)
            .unwrap();
        println!("foreground attempt={attempt}: {:?}", start.elapsed());
        let start = std::time::Instant::now();
        let font = engine.font("prepare".into(), 0, 0, ids[0]).unwrap();
        println!("font attempt={attempt}: {:?}", start.elapsed());
        if let Some(previous) = &expected {
            assert_eq!(previous, &(background, foreground, font));
        } else {
            expected = Some((background, foreground, font));
        }
    }
    assert_eq!(
        engine.layer("prepare".into(), 1, 0, 1600, ids, false),
        Err(EngineError::StaleObject)
    );
}

#[test]
#[ignore = "set PAPERKIT_EDIT_REGRESSION_PDF; exercises the actual font-resolution action"]
fn replacement_font_dialog_on_local_sample() {
    let path = PathBuf::from(std::env::var_os("PAPERKIT_EDIT_REGRESSION_PDF").unwrap());
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine =
        Paperframe::start_with_fonts(resources.join("pdfium/pdfium.dll"), resources.join("fonts"))
            .unwrap();
    let initial = engine
        .render("probe-font".into(), path.clone(), 0, 800)
        .unwrap();
    let group = initial
        .text
        .groups
        .iter()
        .find(|g| g.can_flow && g.text.chars().count() > 100)
        .unwrap();
    for font in ["pretendard", "nanum-myeongjo", "noto-sans-kr"] {
        for changed in [false, true] {
            let id = format!("resolution-{font}-{changed}");
            engine.render(id.clone(), path.clone(), 0, 800).unwrap();
            let text = if changed {
                format!("수정한 문구입니다. {}", group.text)
            } else {
                group.text.clone()
            };
            let fonts = group
                .runs
                .iter()
                .map(|r| (r.object, font.to_owned()))
                .collect();
            let result = engine.edit(
                id,
                0,
                EditAction::FlexibleEdit {
                    page: 0,
                    groups: vec![group.id],
                    object: None,
                    text,
                    fonts,
                    width: None,
                    height: None,
                },
            );
            println!("font={font} changed={changed}: {result:?}");
            assert!(result.is_ok(), "{font} changed={changed}: {result:?}");
        }
    }
}

fn image() -> Vec<u8> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, 80, 40);
        encoder.set_color(png::ColorType::Rgba);
        let mut writer = encoder.write_header().unwrap();
        let pixels: Vec<_> = (0..3200)
            .flat_map(|i| [30, 80, 160, if i % 5 == 0 { 0 } else { 220 }])
            .collect();
        writer.write_image_data(&pixels).unwrap();
    }
    bytes
}

#[test]
#[ignore = "set PAPERKIT_EDIT_REGRESSION_PDF to a local sample; requires bundled PDFium/qpdf/fonts"]
fn edits_on_local_sample() {
    let path = PathBuf::from(
        std::env::var_os("PAPERKIT_EDIT_REGRESSION_PDF").expect("Specify a local PDF sample"),
    );
    let source = std::fs::read(&path).unwrap();
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine =
        Paperframe::start_with_fonts(resources.join("pdfium/pdfium.dll"), resources.join("fonts"))
            .unwrap();
    let probe = engine.render("probe".into(), path.clone(), 0, 800).unwrap();
    let mut failures = Vec::new();
    for page in 0..probe.page_count.min(3) {
        for signature in [false, true] {
            let id = format!("image-{page}-{signature}");
            let before = engine.render(id.clone(), path.clone(), page, 800).unwrap();
            let previous: BTreeSet<_> = before.text.graphics.iter().map(|g| g.id).collect();
            let action = if signature {
                EditAction::AddSignature { page, png: image() }
            } else {
                EditAction::PasteImage { page, png: image() }
            };
            match engine.edit(id.clone(), 0, action) {
                Ok(state) => {
                    println!("page {page} signature={signature}: insert OK");
                    let after = engine.render(id.clone(), path.clone(), page, 800).unwrap();
                    let target = after
                        .text
                        .graphics
                        .iter()
                        .find(|g| !previous.contains(&g.id))
                        .expect("inserted graphic");
                    let moved = engine.edit(
                        id,
                        state.revision,
                        EditAction::TransformGraphic {
                            page,
                            object: target.id,
                            matrix: [1., 0., 0., 1., 8., -8.],
                        },
                    );
                    println!("page {page} signature={signature}: move {moved:?}");
                    if moved.is_err() {
                        failures.push(format!(
                            "move graphic page={page} signature={signature}: {moved:?}"
                        ));
                    }
                }
                Err(error) => {
                    println!("page {page} signature={signature}: insert {error:?}");
                    failures.push(format!(
                        "insert page={page} signature={signature}: {error:?}"
                    ));
                }
            }
        }
        let id = format!("text-{page}");
        let before = engine.render(id.clone(), path.clone(), page, 800).unwrap();
        println!(
            "page {page}: text objects={}, graphics={}",
            before.text.objects.len(),
            before.text.graphics.len()
        );
        for (ordinal, group) in before
            .text
            .groups
            .iter()
            .filter(|g| g.can_flow && g.text.chars().count() > 5)
            .take(5)
            .enumerate()
        {
            let group_id = format!("flow-{page}-{ordinal}");
            engine
                .render(group_id.clone(), path.clone(), page, 800)
                .unwrap();
            let mut value = group.text.clone();
            value.push(group.text.chars().find(|c| !c.is_whitespace()).unwrap());
            let result = engine.edit(
                group_id.clone(),
                0,
                EditAction::FlowBlock {
                    page,
                    group: group.id,
                    text: value.clone(),
                    width: None,
                    height: None,
                },
            );
            println!("page {page}: flow group {}: {result:?}", group.id);
            let result = if matches!(result, Err(EngineError::FontUnavailable)) || ordinal < 2 {
                let font_id = format!("font-{page}-{ordinal}");
                engine
                    .render(font_id.clone(), path.clone(), page, 800)
                    .unwrap();
                let fallback = engine.edit(
                    font_id,
                    0,
                    EditAction::ChangeBlockFont {
                        page,
                        group: group.id,
                        font: "pretendard".into(),
                        text: Some(value),
                        width: None,
                        height: None,
                    },
                );
                println!(
                    "page {page}: explicit font group {}: {fallback:?}",
                    group.id
                );
                if fallback.is_err() {
                    failures.push(format!(
                        "explicit font page={page} group={}: {fallback:?}",
                        group.id
                    ));
                }
                if result.is_ok() {
                    result
                } else {
                    fallback
                }
            } else {
                result
            };
            if result.is_err() {
                failures.push(format!("flow page={page} group={}: {result:?}", group.id));
            }
        }
        if let Some(object) = before
            .text
            .objects
            .iter()
            .find(|o| o.font_change_blocked.is_none() && o.text.trim().chars().count() > 3)
        {
            let moved = engine.edit(
                id.clone(),
                0,
                EditAction::Move {
                    page,
                    group: None,
                    object: Some(object.id),
                    dx: 4.,
                    dy: -4.,
                },
            );
            println!("page {page}: text move {moved:?}");
            if moved.is_err() {
                failures.push(format!("text move page={page}: {moved:?}"));
            }
        }
        if let Some(object) = before
            .text
            .objects
            .iter()
            .find(|o| o.edit_blocked.is_none() && o.text.trim().chars().count() > 3)
        {
            let id = format!("replace-{page}");
            engine.render(id.clone(), path.clone(), page, 800).unwrap();
            let mut chars: Vec<_> = object.text.trim_end().chars().collect();
            if let Some(other) =
                (1..chars.len()).find(|&i| !chars[i].is_whitespace() && chars[i] != chars[0])
            {
                chars.swap(0, other);
            }
            let replaced = engine.edit(
                id,
                0,
                EditAction::Replace {
                    page,
                    object: object.id,
                    text: chars.into_iter().collect(),
                },
            );
            println!("page {page}: replace {replaced:?}");
            if replaced.is_err() {
                failures.push(format!("replace page={page}: {replaced:?}"));
            }
        }
        for object in before
            .text
            .objects
            .iter()
            .filter(|o| o.font_change_blocked.is_none() && o.text.trim().chars().count() > 3)
            .step_by(15)
            .take(6)
        {
            let font_id = format!("object-font-{page}-{}", object.id);
            engine
                .render(font_id.clone(), path.clone(), page, 800)
                .unwrap();
            let result = engine.edit(
                font_id,
                0,
                EditAction::ChangeFont {
                    page,
                    object: object.id,
                    font: "pretendard".into(),
                },
            );
            println!("page {page}: object font {}: {result:?}", object.id);
            if result.is_err() {
                failures.push(format!(
                    "object font page={page} id={}: {result:?}",
                    object.id
                ));
            }
        }
    }
    assert_eq!(
        std::fs::read(path).unwrap(),
        source,
        "sample must remain unchanged"
    );
    assert!(failures.is_empty(), "{failures:#?}");
}
