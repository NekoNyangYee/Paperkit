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
            .filter(|g| {
                std::env::var("PAPERKIT_PROBE_GROUP")
                    .ok()
                    .is_none_or(|id| id.parse::<usize>().ok() == Some(g.id))
            })
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
                    text: format!(
                        "{}{}",
                        g.text,
                        std::env::var("PAPERKIT_PROBE_SUFFIX").unwrap_or_else(|_| " 1".into())
                    ),
                    width: None,
                    height: None,
                },
            );
            if let Ok(state) = &result {
                let edited = engine.render("probe".into(), path.clone(), 0, 800).unwrap();
                let output = std::env::temp_dir().join(format!(
                    "paperkit-probe-{}-{}.pdf",
                    std::process::id(),
                    g.id
                ));
                engine
                    .edit(
                        "probe".into(),
                        state.revision,
                        EditAction::Save {
                            path: output.clone(),
                        },
                    )
                    .unwrap();
                let reopened = engine
                    .render("saved-probe".into(), output.clone(), 0, 800)
                    .unwrap();
                assert_eq!(edited.png, reopened.png);
                engine.release("saved-probe".into()).unwrap();
                std::fs::remove_file(output).unwrap();
            }
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
