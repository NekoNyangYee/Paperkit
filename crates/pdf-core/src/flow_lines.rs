//! Wrap within original PDF rows without flattening lists or hanging indents.
use std::collections::{HashMap, HashSet};

pub(crate) struct Line {
    pub indices: Vec<usize>,
    pub indent: f32,
    pub baseline: Option<f32>,
}

/// Size to the longest source/user row, then let wrapping enforce the page edge.
pub(crate) fn natural_width(
    text: &[char],
    styles: &[usize],
    advances: &HashMap<(usize, char), f32>,
    first_indent: f32,
    boundaries: &HashMap<usize, (f32, f32)>,
) -> f32 {
    let mut indent = first_indent;
    let mut used = indent;
    let mut width = used;
    for (i, &ch) in text.iter().enumerate() {
        if let Some(&(next, _)) = boundaries.get(&i) {
            width = width.max(used);
            indent = next;
            used = indent;
        }
        if ch == '\n' {
            width = width.max(used);
            used = indent;
        } else {
            used += advances[&(styles[i], ch)];
        }
    }
    width.max(used)
}

pub(crate) fn wrap(
    text: &[char],
    styles: &[usize],
    advances: &HashMap<(usize, char), f32>,
    width: f32,
    first_indent: f32,
    boundaries: &HashMap<usize, (f32, f32)>,
    retained: &HashSet<usize>,
) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut pending = Vec::new();
    let mut used = 0.0;
    let mut indent = first_indent;
    let mut baseline = None;
    let mut keep_row = false;
    for (i, &ch) in text.iter().enumerate() {
        if let Some(&(next_indent, next_baseline)) = boundaries.get(&i) {
            if !pending.is_empty() {
                lines.push(Line {
                    indices: std::mem::take(&mut pending),
                    indent,
                    baseline,
                });
                used = 0.0;
            }
            indent = next_indent;
            baseline = Some(next_baseline);
            keep_row = retained.contains(&i);
        }
        if ch == '\n' {
            lines.push(Line {
                indices: std::mem::take(&mut pending),
                indent,
                baseline: baseline.take(),
            });
            used = 0.0;
            keep_row = false;
            continue;
        }
        let advance = advances[&(styles[i], ch)];
        let line_width = width - indent;
        if !keep_row && used + advance > line_width && !pending.is_empty() {
            let tail = pending
                .iter()
                .rposition(|&j| text[j] == ' ')
                .map(|space| pending.split_off(space + 1))
                .unwrap_or_default();
            lines.push(Line {
                indices: std::mem::replace(&mut pending, tail),
                indent,
                baseline: baseline.take(),
            });
            used = pending
                .iter()
                .map(|&j| advances[&(styles[j], text[j])])
                .sum();
            if used + advance > line_width && !pending.is_empty() {
                lines.push(Line {
                    indices: std::mem::take(&mut pending),
                    indent,
                    baseline: None,
                });
                used = 0.0;
            }
        }
        pending.push(i);
        used += advance;
    }
    lines.push(Line {
        indices: pending,
        indent,
        baseline,
    });
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn widening_keeps_rows_and_narrowing_wraps_inside_each_row() {
        let text: Vec<char> = "Question First option Second".chars().collect();
        let styles = vec![0; text.len()];
        let advances = text.iter().map(|&ch| ((0, ch), 1.0)).collect();
        let boundaries = HashMap::from([(0, (0.0, 700.0)), (9, (2.0, 680.0)), (22, (2.0, 650.0))]);
        let wide = wrap(
            &text,
            &styles,
            &advances,
            100.0,
            0.0,
            &boundaries,
            &HashSet::new(),
        );
        assert_eq!(wide.len(), 3);
        assert_eq!(wide[1].indent, 2.0);
        assert_eq!(wide[2].baseline, Some(650.0));
        let narrow = wrap(
            &text,
            &styles,
            &advances,
            10.0,
            0.0,
            &boundaries,
            &HashSet::new(),
        );
        assert!(narrow.len() > 3);
        assert_eq!(
            narrow.iter().filter(|line| line.baseline.is_some()).count(),
            3
        );
        assert_eq!(
            narrow
                .iter()
                .flat_map(|line| &line.indices)
                .copied()
                .collect::<Vec<_>>(),
            (0..text.len()).collect::<Vec<_>>()
        );
    }
}
