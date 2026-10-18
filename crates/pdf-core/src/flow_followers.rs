//! Follow the reading column when a paragraph grows. Coordinates use PDF points.
use crate::{layout::GroupKind, text::PageText};
use std::collections::{BTreeSet, HashMap};

pub(crate) fn rect(points: &[[f32; 2]]) -> [f32; 4] {
    points.iter().fold(
        [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ],
        |r, p| {
            [
                r[0].min(p[0]),
                r[1].min(p[1]),
                r[2].max(p[0]),
                r[3].max(p[1]),
            ]
        },
    )
}

struct Block {
    ids: BTreeSet<usize>,
    area: [f32; 4],
}

pub(crate) struct Planner {
    blocks: Vec<Block>,
    sources: Vec<(usize, [[f32; 2]; 4])>,
}
impl Planner {
    pub(crate) fn excluding(mut self, ids: &BTreeSet<usize>) -> Self {
        self.blocks.retain(|b| b.ids.is_disjoint(ids));
        self
    }
    pub(crate) fn new(page: &PageText) -> Self {
        let mut blocks = Vec::new();
        let mut grouped: BTreeSet<usize> = BTreeSet::new();
        let objects: HashMap<_, _> = page.objects.iter().map(|o| (o.id, o)).collect();
        // Move whole paragraphs, including indented rows, rather than individual
        // text fragments. Sentences overlap their parent paragraph and are ignored.
        for group in page
            .groups
            .iter()
            .filter(|g| g.kind == GroupKind::Paragraph)
        {
            let ids: BTreeSet<_> = group.runs.iter().map(|r| r.object).collect();
            if ids.iter().any(|id| grouped.contains(id))
                || group.runs.iter().any(|r| {
                    r.object_start != 0
                        || objects
                            .get(&r.object)
                            .is_none_or(|o| r.end - r.start < o.text.trim_end().chars().count())
                })
            {
                continue;
            }
            let points: Vec<_> = ids.iter().flat_map(|id| objects[id].bounds).collect();
            if points.is_empty() {
                continue;
            }
            grouped.extend(&ids);
            blocks.push(Block {
                ids,
                area: rect(&points),
            });
        }
        blocks.extend(
            page.objects
                .iter()
                .filter(|o| !grouped.contains(&o.id))
                .map(|o| Block {
                    ids: BTreeSet::from([o.id]),
                    area: rect(&o.bounds),
                }),
        );
        blocks.extend(page.graphics.iter().map(|o| Block {
            ids: BTreeSet::from([o.id]),
            area: rect(&o.bounds),
        }));
        blocks.sort_by(|a, b| b.area[3].total_cmp(&a.area[3]));
        Self {
            blocks,
            sources: page.objects.iter().map(|o| (o.id, o.bounds)).collect(),
        }
    }
    pub(crate) fn find(&self, selected: &BTreeSet<usize>) -> BTreeSet<usize> {
        let points: Vec<_> = self
            .sources
            .iter()
            .filter(|(id, _)| selected.contains(id))
            .flat_map(|(_, q)| *q)
            .collect();
        if points.is_empty() {
            return BTreeSet::new();
        }
        let origin = rect(&points);
        let mut following = BTreeSet::new();
        let mut reachable = vec![origin];
        loop {
            let mut added = false;
            for block in &self.blocks {
                let r = block.area;
                // Backgrounds, enclosing cells, and side-by-side content are not
                // downstream. A spanning block below a column can join its flow.
                if r[3] > origin[1] + 0.5
                    || block
                        .ids
                        .iter()
                        .any(|id| following.contains(id) || selected.contains(id))
                {
                    continue;
                }
                if reachable.iter().any(|p| {
                    let overlap = r[2].min(p[2]) - r[0].max(p[0]);
                    let below = r[3] <= p[1] + 0.5;
                    let attached =
                        r[1] < p[3] && r[3] > p[1] && r[0] <= p[2] + 12.0 && r[2] >= p[0] - 12.0;
                    (below && overlap > 0.5) || attached
                }) {
                    following.extend(&block.ids);
                    reachable.push(r);
                    added = true;
                }
            }
            if !added {
                break;
            }
        }
        following
    }
}

#[cfg(test)]
fn find(page: &PageText, selected: &BTreeSet<usize>) -> BTreeSet<usize> {
    Planner::new(page).find(selected)
}

/// Recognize only short, centered page numbers in the bottom margin. They are
/// fixed page furniture, not the end of the body column.
pub(crate) fn pagination(page: &PageText, bounds: [f32; 4]) -> (BTreeSet<usize>, f32) {
    let mut ids = BTreeSet::new();
    let mut floor = bounds[1];
    for group in page
        .groups
        .iter()
        .filter(|g| g.kind == GroupKind::Paragraph)
    {
        let value = group.text.trim();
        if value.len() > 32
            || !value.chars().any(|c| c.is_ascii_digit())
            || !value
                .chars()
                .all(|c| c.is_ascii_digit() || c.is_whitespace() || "-–—/".contains(c))
        {
            continue;
        }
        let r = rect(&group.bounds.iter().flatten().copied().collect::<Vec<_>>());
        if r[3] < bounds[1] + (bounds[3] - bounds[1]) * 0.08
            && ((r[0] + r[2] - bounds[0] - bounds[2]) * 0.5).abs() < (bounds[2] - bounds[0]) * 0.2
        {
            ids.extend(group.runs.iter().map(|r| r.object));
            floor = floor.max(r[3]);
        }
    }
    (ids, floor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::{GraphicObject, TextObject};
    fn object(id: usize, r: [f32; 4]) -> TextObject {
        TextObject {
            id,
            text: format!("block {id}"),
            font: "Courier".into(),
            font_object_id: 0,
            font_size: 12.0,
            font_weight: None,
            color: [0, 0, 0, 255],
            matrix: [1., 0., 0., 1., r[0], r[1]],
            bounds: [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]],
            screen_bounds: [[0; 2]; 4],
            edit_blocked: None,
            font_change_blocked: None,
        }
    }
    #[test]
    fn follows_headings_indented_lists_and_drawings_without_moving_the_other_column() {
        let mut page = PageText::default();
        page.objects = vec![
            object(0, [40., 700., 240., 712.]),
            object(1, [40., 650., 180., 666.]),
            object(2, [65., 620., 200., 632.]),
            object(3, [340., 650., 540., 662.]),
            object(4, [40., 750., 240., 762.]),
        ];
        page.graphics = vec![
            GraphicObject {
                id: 5,
                kind: "path",
                bounds: object(5, [40., 570., 240., 600.]).bounds,
                screen_bounds: [[0; 2]; 4],
            },
            GraphicObject {
                id: 6,
                kind: "image",
                bounds: object(6, [0., 0., 600., 800.]).bounds,
                screen_bounds: [[0; 2]; 4],
            },
        ];
        assert_eq!(find(&page, &BTreeSet::from([0])), BTreeSet::from([1, 2, 5]));
    }
    #[test]
    fn a_spanning_heading_connects_columns_only_below_the_heading() {
        let mut page = PageText::default();
        page.objects = vec![
            object(0, [40., 700., 240., 712.]),
            object(1, [340., 650., 540., 662.]),
            object(2, [40., 580., 540., 600.]),
            object(3, [340., 540., 540., 552.]),
        ];
        assert_eq!(find(&page, &BTreeSet::from([0])), BTreeSet::from([2, 3]));
    }
}
