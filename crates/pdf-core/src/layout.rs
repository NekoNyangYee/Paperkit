//! Conservative horizontal text reconstruction. All offsets count Unicode scalar values,
//! never UTF-8 bytes or JavaScript UTF-16 units. Group IDs are page/revision scoped.
use crate::text::{PageText, TextObject};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GroupKind {
    Sentence,
    Paragraph,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRun {
    pub object: usize,
    pub start: usize,
    pub end: usize,
    pub object_start: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGroup {
    pub can_flow: bool,
    pub can_reflow: bool,
    pub can_change_font: bool,
    pub id: usize,
    pub kind: GroupKind,
    pub text: String,
    pub runs: Vec<SourceRun>,
    pub bounds: Vec<[[f32; 2]; 4]>,
    pub screen_bounds: Vec<[[i32; 2]; 4]>,
    pub uncertain: bool,
    pub edit_blocked: Option<String>,
}

#[derive(Clone)]
struct Glyph {
    ch: char,
    source: Option<(usize, usize)>,
    rect: [f32; 4],
    line: usize,
}
struct Fragment {
    object: usize,
    glyphs: Vec<Glyph>,
    rect: [f32; 4],
    baseline: f32,
    em: f32,
}
struct Line {
    glyphs: Vec<Glyph>,
    rect: [f32; 4],
    baseline: f32,
    em: f32,
    uncertain: bool,
}

fn union(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}
fn quad(r: [f32; 4]) -> [[f32; 2]; 4] {
    [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]
}
fn rect(q: [[f32; 2]; 4]) -> [f32; 4] {
    [
        q.iter().map(|p| p[0]).fold(f32::INFINITY, f32::min),
        q.iter().map(|p| p[1]).fold(f32::INFINITY, f32::min),
        q.iter().map(|p| p[0]).fold(f32::NEG_INFINITY, f32::max),
        q.iter().map(|p| p[1]).fold(f32::NEG_INFINITY, f32::max),
    ]
}
fn barrier(a: [f32; 4], b: [f32; 4], rules: &[[f32; 4]]) -> bool {
    let area = union(a, b);
    rules.iter().any(|r| {
        if !(r[0] < area[2] && r[2] > area[0] && r[1] < area[3] && r[3] > area[1]) {
            return false;
        }
        if r[2] - r[0] > 1.0 && r[3] - r[1] > 1.0 {
            return true;
        }
        let same_row = a[1] < b[3] && a[3] > b[1];
        if same_row {
            // An underline inside a row is formatting, not a cell boundary.
            r[3] - r[1] > (a[3] - a[1]).min(b[3] - b[1]) * 0.5
                && r[0] >= a[2].min(b[2]) - 0.5
                && r[2] <= a[0].max(b[0]) + 0.5
        } else {
            // Only a line in the inter-row gap separates paragraphs.
            r[1] >= a[3].min(b[3]) - 0.5 && r[3] <= a[1].max(b[1]) + 0.5
        }
    })
}

pub(crate) fn reconstruct(page: &PdfPage<'_>, config: &PdfRenderConfig, result: &mut PageText) {
    if result.objects.is_empty() {
        return;
    }
    // chars_for_object scans the page in pdfium-render 0.9.4. Bound this work,
    // especially for adversarial PDFs and thumbnail requests.
    if result.objects.len() > 2048
        || result
            .objects
            .iter()
            .map(|o| o.text.chars().count())
            .sum::<usize>()
            > 12000
    {
        result.warning = Some("텍스트가 많은 페이지는 객체 단위로 선택합니다.".into());
        return;
    }
    let Ok(text_page) = page.text() else {
        return;
    };
    let mut fragments = Vec::new();
    let mut rules = Vec::new();
    for object in page.objects().iter() {
        if object.as_path_object().is_some() {
            if let Ok(q) = object.bounds() {
                let r = rect([
                    [q.x1().value, q.y1().value],
                    [q.x2().value, q.y2().value],
                    [q.x3().value, q.y3().value],
                    [q.x4().value, q.y4().value],
                ]);
                // Thin rules and rectangular cell borders are conservative barriers.
                rules.push([r[0] - 0.25, r[1] - 0.25, r[0] + 0.25, r[3] + 0.25]);
                rules.push([r[2] - 0.25, r[1] - 0.25, r[2] + 0.25, r[3] + 0.25]);
                rules.push([r[0] - 0.25, r[1] - 0.25, r[2] + 0.25, r[1] + 0.25]);
                rules.push([r[0] - 0.25, r[3] - 0.25, r[2] + 0.25, r[3] + 0.25]);
            }
        }
    }
    for o in &result.objects {
        if o.matrix[1].abs() > 0.001
            || o.matrix[2].abs() > 0.001
            || o.matrix[0] <= 0.0
            || o.matrix[3] <= 0.0
            || o.text.is_empty()
        {
            continue;
        }
        let Ok(object) = page.objects().get(o.id) else {
            continue;
        };
        let Some(text) = object.as_text_object() else {
            continue;
        };
        let Ok(chars) = text_page.chars_for_object(text) else {
            continue;
        };
        let glyphs: Option<Vec<_>> = chars
            .iter()
            .enumerate()
            .map(|(offset, c)| {
                let ch = c.unicode_char()?;
                let b = c.loose_bounds().ok()?;
                let r = [
                    b.left().value,
                    b.bottom().value,
                    b.right().value,
                    b.top().value,
                ];
                r.iter().all(|v| v.is_finite()).then_some(Glyph {
                    ch,
                    source: Some((o.id, offset)),
                    rect: r,
                    line: 0,
                })
            })
            .collect();
        let Some(glyphs) = glyphs else {
            continue;
        };
        // Ligatures/generated characters with an ambiguous source mapping stay in object mode.
        let mapped: String = glyphs.iter().map(|g| g.ch).collect();
        // FPDFTextObj_GetText can append a generated word space belonging to no
        // glyph. Keep it inferred from geometry, not as a source character.
        if (mapped != o.text && mapped != o.text.trim_end_matches(char::is_whitespace))
            || glyphs.is_empty()
            || o.text.chars().any(char::is_control)
        {
            continue;
        }
        let advance_bounds = glyphs.iter().map(|g| g.rect).reduce(union).unwrap();
        fragments.push(Fragment {
            object: o.id,
            glyphs,
            rect: advance_bounds,
            baseline: o.matrix[5],
            em: o.font_size * o.matrix[3],
        });
    }
    let mapped: std::collections::HashSet<_> = fragments.iter().map(|f| f.object).collect();
    rules.extend(
        result
            .objects
            .iter()
            .filter(|o| !mapped.contains(&o.id))
            .map(|o| rect(o.bounds)),
    );
    result.groups = build(fragments, &result.objects, &rules);
    for group in &mut result.groups {
        group.can_flow = crate::flow::eligible(group, &result.objects);
        group.can_reflow = crate::block::eligible(group, &result.objects);
        group.can_change_font = crate::flow::eligible(group, &result.objects);
        for bounds in &group.bounds {
            let mut screen = [[0; 2]; 4];
            for (i, p) in bounds.iter().enumerate() {
                match page.points_to_pixels(PdfPoints::new(p[0]), PdfPoints::new(p[1]), config) {
                    Ok((x, y)) => screen[i] = [x, y],
                    Err(_) => {
                        group.edit_blocked = Some("선택 좌표를 확인할 수 없습니다.".into());
                    }
                }
            }
            group.screen_bounds.push(screen);
        }
    }
}

fn build(
    mut fragments: Vec<Fragment>,
    objects: &[TextObject],
    rules: &[[f32; 4]],
) -> Vec<TextGroup> {
    // A font-replaceable body must not inherit the restrictions of a nearby
    // stroked/clipped heading simply because their paragraph geometry matches.
    let restricted: std::collections::HashSet<_> = objects
        .iter()
        .filter(|o| o.font_change_blocked.is_some())
        .map(|o| o.id)
        .collect();
    let restricted_run = |glyphs: &[Glyph]| {
        glyphs
            .iter()
            .any(|g| g.source.is_some_and(|(id, _)| restricted.contains(&id)))
    };
    fragments.sort_by(|a, b| {
        b.baseline
            .total_cmp(&a.baseline)
            .then(a.rect[0].total_cmp(&b.rect[0]))
            .then(a.object.cmp(&b.object))
    });
    let mut rows: Vec<Vec<Fragment>> = Vec::new();
    for f in fragments {
        if let Some(row) = rows
            .last_mut()
            .filter(|r| (r[0].baseline - f.baseline).abs() <= r[0].em.min(f.em) * 0.2)
        {
            row.push(f);
        } else {
            rows.push(vec![f]);
        }
    }
    let mut lines: Vec<Line> = Vec::new();
    for mut row in rows {
        row.sort_by(|a, b| a.rect[0].total_cmp(&b.rect[0]));
        let first_line = lines.len();
        for mut f in row {
            let join = lines.len() > first_line
                && lines.last().is_some_and(|l| {
                    let gap = f.rect[0] - l.rect[2];
                    // Loose glyph boxes can overlap for bold/CJK bearings even
                    // when the character origins advance normally.
                    gap >= -0.3 * l.em
                        && restricted_run(&l.glyphs) == restricted_run(&f.glyphs)
                        && f.rect[0] > l.glyphs.last().unwrap().rect[0] + 0.05 * l.em
                        && gap <= 1.2 * l.em
                        && (l.em - f.em).abs() < 0.65 * l.em.max(f.em)
                        && !barrier(l.rect, f.rect, rules)
                });
            if join {
                let line = lines.last_mut().unwrap();
                if f.rect[0] - line.rect[2] > 0.18 * line.em
                    && !line.glyphs.last().unwrap().ch.is_whitespace()
                    && !f.glyphs[0].ch.is_whitespace()
                {
                    line.glyphs.push(Glyph {
                        ch: ' ',
                        source: None,
                        rect: f.rect,
                        line: 0,
                    });
                }
                line.rect = union(line.rect, f.rect);
                line.em = line.em.max(f.em);
                line.glyphs.append(&mut f.glyphs);
            } else {
                lines.push(Line {
                    glyphs: f.glyphs,
                    rect: f.rect,
                    baseline: f.baseline,
                    em: f.em,
                    uncertain: false,
                });
            }
        }
        // Separate columns/cells are valid independent edit targets. Only
        // overlapping fragments are ambiguous; sharing a baseline is normal.
        for i in first_line..lines.len() {
            for j in first_line..i {
                if lines[i].rect[0] < lines[j].rect[2] && lines[i].rect[2] > lines[j].rect[0] {
                    lines[i].uncertain = true;
                    lines[j].uncertain = true;
                }
            }
        }
    }
    let mut spacing: Vec<f32> = lines
        .windows(2)
        .filter_map(|pair| {
            let (a, b) = (&pair[0], &pair[1]);
            let ratio = (a.baseline - b.baseline) / b.em;
            (!a.uncertain
                && !b.uncertain
                && (a.rect[0] - b.rect[0]).abs() < 0.6 * b.em
                && (0.8..=2.2).contains(&ratio)
                && !barrier(a.rect, b.rect, rules))
            .then_some(ratio)
        })
        .collect();
    spacing.sort_by(f32::total_cmp);
    let normal_spacing = spacing.get(spacing.len() / 2).copied().unwrap_or(1.4);
    let gap_limit = (normal_spacing * 1.35).clamp(1.65, 2.2);
    let mut paragraphs: Vec<(Vec<Glyph>, bool)> = Vec::new();
    let mut last_lines: Vec<usize> = Vec::new();
    for i in 0..lines.len() {
        let l = &lines[i];
        let parent = (0..paragraphs.len()).rev().find(|&paragraph| {
            let previous = last_lines[paragraph];
            let p = &lines[previous];
            let dy = p.baseline - l.baseline;
            let first_line_indent = paragraphs[paragraph]
                .0
                .first()
                .is_some_and(|g| g.line == previous)
                && p.rect[0] > l.rect[0]
                && p.rect[0] - l.rect[0] <= 1.5 * l.em;
            // Paragraph geometry has priority over sentence punctuation or a
            // short line: reconstruct rows first, then combine aligned rows.
            !p.uncertain
                && !l.uncertain
                && restricted_run(&p.glyphs) == restricted_run(&l.glyphs)
                && dy > 0.7 * l.em
                && dy <= gap_limit * l.em.max(p.em)
                && p.rect[1] - l.rect[3] < 0.8 * l.em
                && ((p.rect[0] - l.rect[0]).abs() < 1.5 * l.em || first_line_indent)
                && (p.em - l.em).abs() < 0.5 * l.em.max(p.em)
                && !barrier(p.rect, l.rect, rules)
                && {
                    let area = union(
                        paragraphs[paragraph]
                            .0
                            .iter()
                            .map(|g| g.rect)
                            .reduce(union)
                            .unwrap(),
                        l.rect,
                    );
                    !lines.iter().enumerate().any(|(j, other)| {
                        j != i
                            && !paragraphs[paragraph].0.iter().any(|g| g.line == j)
                            && other.rect[0] < area[2]
                            && other.rect[2] > area[0]
                            && other.rect[1] < area[3]
                            && other.rect[3] > area[1]
                    })
                }
        });
        let join = parent.is_some();
        let paragraph = parent.unwrap_or_else(|| {
            paragraphs.push((Vec::new(), l.uncertain));
            last_lines.push(i);
            paragraphs.len() - 1
        });
        last_lines[paragraph] = i;
        let (glyphs, _) = &mut paragraphs[paragraph];
        let hard_break = join
            && ((l.em - lines[glyphs.last().unwrap().line].em).abs() > 0.1 * l.em
                || matches!(l.glyphs[0].ch, '■' | '▶' | '•' | '▪' | '※' | '*'));
        if join
            && !glyphs.last().unwrap().ch.is_whitespace()
            && glyphs.last().unwrap().ch != '-'
            && !l.glyphs[0].ch.is_whitespace()
        {
            glyphs.push(Glyph {
                ch: if hard_break { '\n' } else { ' ' },
                source: None,
                rect: l.rect,
                line: i,
            });
        }
        glyphs.extend(l.glyphs.iter().cloned().map(|mut g| {
            g.line = i;
            g
        }));
    }
    let mut groups = Vec::new();
    for (glyphs, uncertain) in paragraphs {
        push_group(
            &mut groups,
            GroupKind::Paragraph,
            &glyphs,
            uncertain,
            objects,
        );
        let chars: Vec<_> = glyphs.iter().map(|g| g.ch).collect();
        let mut start = 0;
        for end in sentence_ends(&chars) {
            let mut a = start;
            let mut b = end;
            while a < b && chars[a].is_whitespace() {
                a += 1;
            }
            while b > a && chars[b - 1].is_whitespace() {
                b -= 1;
            }
            if a < b {
                push_group(
                    &mut groups,
                    GroupKind::Sentence,
                    &glyphs[a..b],
                    uncertain,
                    objects,
                );
            }
            start = end;
        }
    }
    groups
}

fn sentence_ends(chars: &[char]) -> Vec<usize> {
    let mut ends = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '.' | '!' | '?' | '。' | '！' | '？') {
            let token: String = chars[..i]
                .iter()
                .rev()
                .take_while(|c| c.is_alphabetic() || **c == '.')
                .copied()
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let abbreviation = c == '.'
                && (matches!(
                    token.to_lowercase().as_str(),
                    "dr" | "mr"
                        | "mrs"
                        | "ms"
                        | "prof"
                        | "sr"
                        | "jr"
                        | "vs"
                        | "etc"
                        | "e.g"
                        | "i.e"
                ) || token.len() == 1 && token.chars().all(|c| c.is_ascii_uppercase())
                    || token.contains('.'));
            let internal = c == '.'
                && chars
                    .get(i + 1)
                    .is_some_and(|c| !c.is_whitespace() && c.is_ascii_alphanumeric());
            if !abbreviation && !internal {
                let mut end = i + 1;
                while end < chars.len()
                    && matches!(
                        chars[end],
                        '.' | '!' | '?' | '"' | '\'' | '”' | '’' | ')' | ']'
                    )
                {
                    end += 1;
                }
                ends.push(end);
                i = end;
                continue;
            }
        }
        i += 1;
    }
    if ends.last().copied() != Some(chars.len()) {
        ends.push(chars.len());
    }
    ends
}

fn push_group(
    groups: &mut Vec<TextGroup>,
    kind: GroupKind,
    glyphs: &[Glyph],
    uncertain: bool,
    objects: &[TextObject],
) {
    if glyphs.is_empty() {
        return;
    }
    let mut runs: Vec<SourceRun> = Vec::new();
    let mut boxes: Vec<(usize, [f32; 4])> = Vec::new();
    for (i, g) in glyphs.iter().enumerate() {
        if let Some((object, offset)) = g.source {
            if let Some(r) = runs.last_mut().filter(|r| {
                r.object == object && r.end == i && r.object_start + r.end - r.start == offset
            }) {
                r.end += 1;
            } else {
                runs.push(SourceRun {
                    object,
                    start: i,
                    end: i + 1,
                    object_start: offset,
                });
            }
            if let Some((_, b)) = boxes.last_mut().filter(|(line, _)| *line == g.line) {
                *b = union(*b, g.rect);
            } else {
                boxes.push((g.line, g.rect));
            }
        }
    }
    let blocked = if uncertain {
        Some("열 또는 셀 경계가 불확실합니다. 객체 단위로 편집해 주세요.".into())
    } else if runs.len() > 128 {
        Some("한 번에 편집할 객체가 너무 많습니다. 객체 단위로 편집해 주세요.".into())
    } else {
        runs.iter()
            .find_map(|r| {
                objects
                    .iter()
                    .find(|o| o.id == r.object)
                    .and_then(|o| o.font_change_blocked.clone())
            })
            .or_else(|| {
                runs.iter().find_map(|r| {
                    objects
                        .iter()
                        .find(|o| o.id == r.object)
                        .and_then(|o| o.edit_blocked.clone())
                })
            })
    };
    groups.push(TextGroup {
        can_flow: false,
        can_reflow: false,
        can_change_font: false,
        id: groups.len(),
        kind,
        text: glyphs.iter().map(|g| g.ch).collect(),
        runs,
        bounds: boxes.into_iter().map(|(_, r)| quad(r)).collect(),
        screen_bounds: Vec::new(),
        uncertain,
        edit_blocked: blocked,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fragment(id: usize, value: &str, x: f32, y: f32) -> (Fragment, TextObject) {
        let mut glyphs = Vec::new();
        for (offset, ch) in value.chars().enumerate() {
            glyphs.push(Glyph {
                ch,
                source: Some((id, offset)),
                rect: [
                    x + offset as f32 * 6.0,
                    y,
                    x + (offset + 1) as f32 * 6.0,
                    y + 10.0,
                ],
                line: 0,
            });
        }
        let r = [x, y, x + value.chars().count() as f32 * 6.0, y + 10.0];
        (
            Fragment {
                object: id,
                glyphs,
                rect: r,
                baseline: y,
                em: 10.0,
            },
            TextObject {
                id,
                text: value.into(),
                font: "Courier".into(),
                font_object_id: id,
                font_size: 10.0,
                color: [0, 0, 0, 255],
                matrix: [1.0, 0.0, 0.0, 1.0, x, y],
                bounds: quad(r),
                screen_bounds: [[0; 2]; 4],
                edit_blocked: None,
                font_change_blocked: None,
            },
        )
    }
    fn groups(parts: Vec<(Fragment, TextObject)>, rules: &[[f32; 4]]) -> Vec<TextGroup> {
        let (f, o) = parts.into_iter().unzip::<_, _, Vec<_>, Vec<_>>();
        build(f, &o, rules)
    }
    fn sentences(groups: &[TextGroup]) -> Vec<&str> {
        groups
            .iter()
            .filter(|g| g.kind == GroupKind::Sentence)
            .map(|g| g.text.as_str())
            .collect()
    }
    #[test]
    fn joins_bearing_overlap_without_merging_duplicate_paint() {
        let g = groups(
            vec![
                fragment(0, "가", 0.0, 100.0),
                fragment(1, "나", 4.0, 100.0),
                fragment(2, "다", 8.0, 100.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["가나다"]);
        assert!(!g[0].uncertain);
        let duplicates = groups(
            vec![
                fragment(0, "제목", 0.0, 100.0),
                fragment(1, "제목", 0.2, 100.0),
            ],
            &[],
        );
        assert!(duplicates.iter().all(|g| g.uncertain));
    }
    #[test]
    fn restricted_heading_does_not_disable_font_replaceable_body() {
        let mut heading = fragment(0, "Bold heading", 0.0, 100.0);
        heading.1.edit_blocked = Some("font unavailable".into());
        heading.1.font_change_blocked = Some("stroked text".into());
        let mut body = fragment(1, "Body first line", 0.0, 86.0);
        body.1.edit_blocked = Some("font unavailable".into());
        let mut next = fragment(2, "Body second line", 0.0, 72.0);
        next.1.edit_blocked = Some("font unavailable".into());
        let objects = vec![heading.1.clone(), body.1.clone(), next.1.clone()];
        let g = groups(vec![heading, body, next], &[]);
        let paragraphs: Vec<_> = g
            .iter()
            .filter(|g| g.kind == GroupKind::Paragraph)
            .collect();
        assert_eq!(paragraphs.len(), 2);
        assert_eq!(paragraphs[0].edit_blocked.as_deref(), Some("stroked text"));
        assert!(!crate::flow::eligible(paragraphs[0], &objects));
        assert!(crate::flow::eligible(paragraphs[1], &objects));
        assert_eq!(paragraphs[1].text, "Body first line Body second line");
    }
    #[test]
    fn joins_letters_in_geometric_order_without_spaces() {
        let g = groups(
            vec![
                fragment(9, "!", 30.0, 100.0),
                fragment(2, "H", 0.0, 100.0),
                fragment(1, "ello", 6.0, 100.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["Hello!"]);
        assert_eq!(
            g[1].runs.iter().map(|r| r.object).collect::<Vec<_>>(),
            [2, 1, 9]
        );
    }
    #[test]
    fn korean_words_keep_inferred_spaces_and_unicode_offsets() {
        let g = groups(
            vec![
                fragment(0, "한글", 0.0, 100.0),
                fragment(1, "문장입니다.", 18.0, 100.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["한글 문장입니다."]);
        assert_eq!(g[1].runs[1].start, 3);
        assert_eq!(g[1].runs[1].object_start, 0);
    }
    #[test]
    fn distinguishes_abbreviations_decimals_urls_and_sentences() {
        let g = groups(
            vec![fragment(
                0,
                "Dr. Kim paid 3.14. Visit example.com now! 다음 문장입니다.",
                0.0,
                100.0,
            )],
            &[],
        );
        assert_eq!(
            sentences(&g),
            [
                "Dr. Kim paid 3.14.",
                "Visit example.com now!",
                "다음 문장입니다."
            ]
        );
        let second = &g[2];
        assert_eq!(second.runs[0].object_start, 19);
    }
    #[test]
    fn joins_wrapped_sentence_and_preserves_line_rectangles() {
        let g = groups(
            vec![
                fragment(0, "This is a long", 0.0, 100.0),
                fragment(1, "sentence.", 0.0, 86.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["This is a long sentence."]);
        assert_eq!(g[1].bounds.len(), 2);
    }
    #[test]
    fn preserves_hyphen_without_guessing_word_spelling() {
        let g = groups(
            vec![
                fragment(0, "A long hyphen-", 0.0, 100.0),
                fragment(1, "ated word.", 0.0, 86.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["A long hyphen-ated word."]);
    }
    #[test]
    fn separates_columns_without_blocking_independent_cells() {
        let g = groups(
            vec![
                fragment(0, "Left.", 0.0, 100.0),
                fragment(1, "Right.", 100.0, 100.0),
                fragment(2, "Next.", 0.0, 86.0),
            ],
            &[],
        );
        assert_eq!(sentences(&g), ["Left.", "Next.", "Right."]);
        assert_eq!(
            g.iter().filter(|g| g.kind == GroupKind::Paragraph).count(),
            2
        );
        assert!(!g[0].uncertain);
        assert!(g[0].edit_blocked.is_none());
    }
    #[test]
    fn reconstructs_each_column_across_interleaved_rows() {
        let g = groups(
            vec![
                fragment(0, "Left column first", 0.0, 100.0),
                fragment(1, "Right column first", 200.0, 100.0),
                fragment(2, "Left second line", 0.0, 86.0),
                fragment(3, "Right second line", 200.0, 86.0),
                fragment(4, "Left final line.", 0.0, 72.0),
                fragment(5, "Right final line.", 200.0, 72.0),
            ],
            &[],
        );
        let blocks: Vec<_> = g
            .iter()
            .filter(|g| g.kind == GroupKind::Paragraph)
            .collect();
        assert_eq!(blocks.len(), 2);
        assert!(blocks
            .iter()
            .all(|g| g.bounds.len() == 3 && !g.uncertain && g.edit_blocked.is_none()));
        assert!(!blocks[0].text.contains("Right"));
    }
    #[test]
    fn overlapping_fragments_remain_blocked() {
        let g = groups(
            vec![
                fragment(0, "Overlap", 0.0, 100.0),
                fragment(1, "Other", 10.0, 100.0),
            ],
            &[],
        );
        assert!(g.iter().all(|g| g.uncertain && g.edit_blocked.is_some()));
    }
    #[test]
    fn small_bullet_and_larger_body_share_one_line() {
        let mut bullet = fragment(0, "■", 0.0, 100.0);
        bullet.0.em = 6.0;
        bullet.1.font_size = 6.0;
        let g = groups(vec![bullet, fragment(1, "본문 문장", 10.0, 100.0)], &[]);
        assert_eq!(sentences(&g), ["■ 본문 문장"]);
    }
    #[test]
    fn underlines_do_not_fragment_a_sentence() {
        let g = groups(
            vec![
                fragment(0, "Link", 0.0, 100.0),
                fragment(1, "text.", 30.0, 100.0),
            ],
            &[[0.0, 101.0, 60.0, 101.5]],
        );
        assert_eq!(sentences(&g), ["Link text."]);
    }
    #[test]
    fn cell_rules_stop_horizontal_and_vertical_merges() {
        let g = groups(
            vec![
                fragment(0, "Cell", 0.0, 100.0),
                fragment(1, "Next", 30.0, 100.0),
            ],
            &[[26.0, 90.0, 27.0, 120.0]],
        );
        assert_eq!(sentences(&g), ["Cell", "Next"]);
        let g = groups(
            vec![
                fragment(0, "Upper cell", 0.0, 100.0),
                fragment(1, "Lower", 0.0, 86.0),
            ],
            &[[0.0, 98.0, 100.0, 99.0]],
        );
        assert_eq!(sentences(&g), ["Upper cell", "Lower"]);
    }
    #[test]
    fn mixed_formatting_preserves_source_runs() {
        let a = fragment(0, "Hello", 0.0, 100.0);
        let mut b = fragment(1, "world.", 36.0, 100.0);
        b.1.font = "Courier-Bold".into();
        b.1.color = [255, 0, 0, 255];
        let g = groups(vec![a, b], &[]);
        assert_eq!(sentences(&g), ["Hello world."]);
        assert_eq!(g[1].runs.len(), 2);
    }
    #[test]
    fn joins_longer_following_line_and_first_line_indent() {
        let g = groups(
            vec![
                fragment(0, "A short start", 12.0, 100.0),
                fragment(1, "continues with a longer line.", 0.0, 83.0),
            ],
            &[],
        );
        assert_eq!(
            g.iter().filter(|g| g.kind == GroupKind::Paragraph).count(),
            1
        );
        assert_eq!(g[0].bounds.len(), 2);
    }
    #[test]
    fn paragraph_geometry_has_priority_over_short_complete_sentence() {
        for y in [74.0, 86.0] {
            let g = groups(
                vec![
                    fragment(0, "End.", 0.0, 100.0),
                    fragment(1, "A much longer new paragraph.", 0.0, y),
                ],
                &[],
            );
            assert_eq!(
                g.iter().filter(|g| g.kind == GroupKind::Paragraph).count(),
                if y == 74.0 { 2 } else { 1 }
            );
        }
    }
    #[test]
    fn large_line_gap_or_indent_starts_new_paragraph() {
        let g = groups(
            vec![
                fragment(0, "First paragraph", 0.0, 100.0),
                fragment(1, "Next paragraph", 24.0, 86.0),
                fragment(2, "Last.", 24.0, 60.0),
            ],
            &[],
        );
        assert_eq!(
            g.iter().filter(|g| g.kind == GroupKind::Paragraph).count(),
            3
        );
    }
}
