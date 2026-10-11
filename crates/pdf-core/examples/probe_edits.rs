//! Exercise local documents without saving or changing their source files.
use pdf_core::{edit::EditAction, render::PreviewEngine};
use std::path::PathBuf;
fn main() {
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
    for arg in std::env::args_os().skip(1) {
        let path = PathBuf::from(arg);
        let initial = engine.render("probe".into(), path.clone(), 0, 800).unwrap();
        let groups: Vec<_> = initial
            .text
            .groups
            .iter()
            .filter(|g| g.can_flow)
            .take(8)
            .cloned()
            .collect();
        for g in groups {
            engine.release("probe".into()).unwrap();
            engine.render("probe".into(), path.clone(), 0, 800).unwrap();
            let result = engine.edit(
                "probe".into(),
                0,
                EditAction::FlowBlock {
                    page: 0,
                    group: g.id,
                    text: format!("{} 1", g.text),
                    width: None,
                    height: None,
                },
            );
            println!(
                "{} group {}: {:?}",
                path.file_name().unwrap().to_string_lossy(),
                g.id,
                result
            );
        }
        engine.release("probe".into()).unwrap();
    }
}
