use std::path::PathBuf;
fn main() {
    let path = PathBuf::from(std::env::args_os().nth(1).expect("PDF path"));
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine =
        pdf_core::render::PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    let page = engine
        .render("graphics".into(), path.clone(), 0, 800)
        .unwrap();
    for object in &page.text.graphics {
        if object.kind != "image" {
            continue;
        }
        engine
            .layer("graphics".into(), 0, 0, 800, vec![object.id], false)
            .unwrap();
        engine
            .layer("graphics".into(), 0, 0, 800, vec![object.id], true)
            .unwrap();
        engine
            .edit(
                "graphics".into(),
                0,
                pdf_core::edit::EditAction::TransformGraphic {
                    page: 0,
                    object: object.id,
                    matrix: [1., 0., 0., 1., 5., 5.],
                },
            )
            .unwrap();
        let moved = engine
            .render("graphics".into(), path.clone(), 0, 800)
            .unwrap();
        assert_ne!(page.png, moved.png);
        engine
            .edit("graphics".into(), 1, pdf_core::edit::EditAction::Undo)
            .unwrap();
        assert_eq!(
            page.png,
            engine
                .render("graphics".into(), path.clone(), 0, 800)
                .unwrap()
                .png
        );
        println!(
            "image {}: foreground/background, move, undo passed",
            object.id
        );
        break;
    }
}
