//! Local-only corpus runner. Never includes document text or paths in its report.
use pdf_core::{edit::EditAction, layout::GroupKind, render::PreviewEngine};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    path: PathBuf,
    page: i32,
    before: String,
    after: String,
}
#[derive(Serialize)]
struct Outcome {
    id: String,
    success: bool,
    stage: String,
    elapsed_ms: u128,
}
fn face(name: &str) -> &str {
    let bytes = name.as_bytes();
    if bytes.len() > 7 && bytes[6] == b'+' && bytes[..6].iter().all(u8::is_ascii_uppercase) {
        &name[7..]
    } else {
        name
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    if args.len() != 3 {
        eprintln!("Usage: original_font_benchmark <pdfium.dll> <private-manifest.json>");
        std::process::exit(2);
    }
    let manifest = PathBuf::from(&args[2]);
    let manifest_bytes = std::fs::read(&manifest)?;
    let cases: Vec<Case> = serde_json::from_slice(
        manifest_bytes
            .strip_prefix(b"\xef\xbb\xbf")
            .unwrap_or(&manifest_bytes),
    )?;
    if cases.is_empty() {
        return Err("Manifest must contain at least one case".into());
    }
    let mut ids = BTreeSet::new();
    if cases
        .iter()
        .any(|c| c.id.is_empty() || !ids.insert(&c.id) || c.before == c.after || c.page < 0)
    {
        return Err("Cases require unique nonempty IDs, a zero-based page and changed text".into());
    }
    let engine =
        PreviewEngine::start(PathBuf::from(&args[1])).map_err(|e| format!("Engine: {e:?}"))?;
    let mut outcomes = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let start = std::time::Instant::now();
        let path = if case.path.is_absolute() {
            case.path.clone()
        } else {
            manifest.parent().unwrap().join(&case.path)
        };
        let session = format!("benchmark-{i}");
        let output = std::env::temp_dir().join(format!(
            "paperkit-benchmark-{}-{i}-{}.pdf",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        let result = (|| -> Result<(), String> {
            let original = std::fs::read(&path).map_err(|_| "read".to_owned())?;
            let before = engine
                .render(session.clone(), path.clone(), case.page, 800)
                .map_err(|e| format!("open:{e:?}"))?;
            let matches: Vec<_> = before
                .text
                .groups
                .iter()
                .filter(|g| {
                    g.kind == GroupKind::Paragraph && g.text.trim_end() == case.before.trim_end()
                })
                .collect();
            if matches.len() != 1 {
                return Err("selection:not_unique".into());
            }
            if !matches[0].can_flow {
                return Err("selection:unsupported".into());
            }
            let families: BTreeSet<_> = before
                .text
                .objects
                .iter()
                .map(|o| face(&o.font).to_owned())
                .collect();
            engine
                .edit(
                    session.clone(),
                    0,
                    EditAction::FlowBlock {
                        page: case.page,
                        group: matches[0].id,
                        text: case.after.clone(),
                        width: None,
                        height: None,
                    },
                )
                .map_err(|e| format!("edit:{e:?}"))?;
            let edited = engine
                .render(session.clone(), path.clone(), case.page, 800)
                .map_err(|e| format!("render:{e:?}"))?;
            if edited
                .text
                .objects
                .iter()
                .any(|o| !families.contains(face(&o.font)))
            {
                return Err("font:identity_changed".into());
            }
            engine
                .edit(
                    session.clone(),
                    1,
                    EditAction::Save {
                        path: output.clone(),
                    },
                )
                .map_err(|e| format!("save:{e:?}"))?;
            let reopened = engine
                .render(
                    format!("{session}-reopened"),
                    output.clone(),
                    case.page,
                    800,
                )
                .map_err(|e| format!("reopen:{e:?}"))?;
            if edited.png != reopened.png {
                return Err("reopen:appearance_changed".into());
            }
            if std::fs::read(&path).map_err(|_| "source:read".to_owned())? != original {
                return Err("source:changed".into());
            }
            Ok(())
        })();
        let _ = engine.release(session);
        let _ = engine.release(format!("benchmark-{i}-reopened"));
        if output.exists() {
            std::fs::remove_file(&output)?;
        }
        outcomes.push(Outcome {
            id: case.id.clone(),
            success: result.is_ok(),
            stage: result.err().unwrap_or_else(|| "passed".into()),
            elapsed_ms: start.elapsed().as_millis(),
        });
    }
    let passed = outcomes.iter().filter(|c| c.success).count();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "metric": "original-font-edit-save-reopen", "target_percent": 60,
            "total": cases.len(), "passed": passed, "success_percent": passed as f64 * 100.0 / cases.len() as f64,
            "cases": outcomes
        }))?
    );
    if passed * 100 < cases.len() * 60 {
        std::process::exit(1);
    }
    Ok(())
}
