//! Local document regression runner; the caller supplies a private output directory.
use pdf_core::{edit::EditAction, layout::GroupKind, render::PreviewEngine, text::TextObject};
use serde_json::json;
use std::{fs, path::PathBuf, time::Instant};

fn overlaps(objects: &[TextObject]) -> usize {
    let rects: Vec<_> = objects
        .iter()
        .filter(|o| !o.text.trim().is_empty())
        .map(|o| {
            let xs: Vec<_> = o.bounds.iter().map(|p| p[0]).collect();
            let ys: Vec<_> = o.bounds.iter().map(|p| p[1]).collect();
            [
                xs.iter().copied().fold(f32::INFINITY, f32::min),
                ys.iter().copied().fold(f32::INFINITY, f32::min),
                xs.iter().copied().fold(f32::NEG_INFINITY, f32::max),
                ys.iter().copied().fold(f32::NEG_INFINITY, f32::max),
            ]
        })
        .take(2048)
        .collect();
    let mut count = 0;
    for (i, a) in rects.iter().enumerate() {
        for b in &rects[..i] {
            let w = a[2].min(b[2]) - a[0].max(b[0]);
            let h = a[3].min(b[3]) - a[1].max(b[1]);
            if w > 0.5 * (a[2] - a[0]).min(b[2] - b[0]) && h > 0.5 * (a[3] - a[1]).min(b[3] - b[1])
            {
                count += 1;
            }
        }
    }
    count
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().collect();
    let path = PathBuf::from(args.get(1).ok_or("PDF path required")?);
    let output = PathBuf::from(args.get(2).ok_or("Private output directory required")?);
    fs::create_dir_all(&output)?;
    let start = Instant::now();
    let resources =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri/resources");
    let engine = PreviewEngine::start_with_fonts(
        resources.join("pdfium/pdfium.dll"),
        resources.join("fonts"),
    )
    .unwrap();
    let original = fs::read(&path)?;
    let mut report = json!({"status":"unverified", "cases":[]});
    let result = (|| -> Result<(), String> {
        let first = engine
            .render("audit".into(), path.clone(), 0, 800)
            .map_err(|e| format!("open:{e:?}"))?;
        report["pages"] = json!(first.page_count);
        let mut selected = None;
        for page_index in 0..first.page_count.min(3) {
            let page = if page_index == 0 {
                first.text.clone()
            } else {
                engine
                    .render("audit".into(), path.clone(), page_index, 800)
                    .map_err(|e| format!("render:{e:?}"))?
                    .text
            };
            let best = page
                .groups
                .iter()
                .filter(|g| {
                    g.kind == GroupKind::Paragraph
                        && g.can_flow
                        && (8..=1500).contains(&g.text.chars().count())
                })
                .max_by_key(|g| (g.bounds.len().min(10), g.text.chars().count()))
                .cloned();
            if let Some(group) = best {
                selected = Some((page_index, group));
                break;
            }
        }
        let (page_index, group) =
            selected.ok_or("selection:no_editable_block_in_first_three_pages")?;
        report["page"] = json!(page_index);
        report["lines"] = json!(group.bounds.len());
        report["characters"] = json!(group.text.chars().count());
        let mut shortened: Vec<_> = group.text.chars().collect();
        if let Some(index) = shortened.iter().rposition(|c| !c.is_whitespace()) {
            shortened.remove(index);
        }
        let repeat = group
            .text
            .chars()
            .rev()
            .find(|c| !c.is_whitespace())
            .unwrap();
        let mut cases = vec![
            ("append", format!("{}{}", group.text, repeat)),
            ("delete", shortened.into_iter().collect()),
        ];
        let mut replacement: Vec<_> = group.text.chars().collect();
        if let Some(at) = replacement.iter().position(char::is_ascii_digit) {
            if let Some(digit) = replacement
                .iter()
                .copied()
                .find(|c| c.is_ascii_digit() && *c != replacement[at])
            {
                replacement[at] = digit;
                cases.push(("replace-digit", replacement.into_iter().collect()));
            }
        }
        for (name, value) in cases {
            let case_start = Instant::now();
            engine
                .release("audit".into())
                .map_err(|e| format!("release:{e:?}"))?;
            let before = engine
                .render("audit".into(), path.clone(), page_index, 800)
                .map_err(|e| format!("reload:{e:?}"))?;
            fs::write(output.join("before.png"), &before.png).map_err(|_| "write")?;
            let edited = engine.edit(
                "audit".into(),
                0,
                EditAction::FlowBlock {
                    page: page_index,
                    group: group.id,
                    text: value,
                    width: None,
                    height: None,
                },
            );
            let outcome = (|| -> Result<(), String> {
                let state = edited.map_err(|e| format!("edit:{e:?}"))?;
                let after = engine
                    .render("audit".into(), path.clone(), page_index, 800)
                    .map_err(|e| format!("render:{e:?}"))?;
                fs::write(output.join(format!("{name}.png")), &after.png).map_err(|_| "write")?;
                let saved = output.join(format!("{name}.pdf"));
                engine
                    .edit(
                        "audit".into(),
                        state.revision,
                        EditAction::Save {
                            path: saved.clone(),
                        },
                    )
                    .map_err(|e| format!("save:{e:?}"))?;
                let reopened = engine
                    .render("reopened".into(), saved, page_index, 800)
                    .map_err(|e| format!("reopen:{e:?}"))?;
                if after.png != reopened.png {
                    return Err("reopen:appearance_changed".into());
                }
                if overlaps(&after.text.objects) > overlaps(&before.text.objects) {
                    return Err("visual:overlap_increased_review_required".into());
                }
                Ok(())
            })();
            report["cases"].as_array_mut().unwrap().push(json!({"operation":name,"status":outcome.err().unwrap_or("passed".into()),"elapsed_ms":case_start.elapsed().as_millis()}));
            engine.release("reopened".into()).ok();
        }
        Ok(())
    })();
    report["status"] = json!(result.err().unwrap_or("tested".into()));
    report["source_unchanged"] = json!(fs::read(&path)? == original);
    report["elapsed_ms"] = json!(start.elapsed().as_millis());
    fs::write(
        output.join("result.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
