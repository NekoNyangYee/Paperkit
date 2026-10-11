use crate::text::TextObject;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Alignment {
    Left,
    Center,
    Right,
    Justify,
}

pub(crate) fn source_lines(objects: &[TextObject]) -> Vec<[f32; 3]> {
    let mut objects: Vec<_> = objects.iter().collect();
    objects.sort_by(|a, b| b.matrix[5].total_cmp(&a.matrix[5]));
    let mut lines: Vec<[f32; 3]> = Vec::new();
    for object in objects {
        let left = object.matrix[4];
        let right = object.bounds.iter().map(|p| p[0]).fold(left, f32::max);
        if let Some(line) = lines
            .last_mut()
            .filter(|l| (l[0] - object.matrix[5]).abs() < 1.0)
        {
            line[1] = line[1].min(left);
            line[2] = line[2].max(right);
        } else {
            lines.push([object.matrix[5], left, right]);
        }
    }
    lines
}

pub(crate) fn detect(lines: &[[f32; 3]]) -> Alignment {
    if lines.len() < 2 {
        return Alignment::Left;
    }
    let spread = |f: fn(&[f32; 3]) -> f32| {
        lines.iter().map(f).fold(f32::NEG_INFINITY, f32::max)
            - lines.iter().map(f).fold(f32::INFINITY, f32::min)
    };
    let left = spread(|l| l[1]);
    if left > 2.0 && spread(|l| (l[1] + l[2]) * 0.5) < 1.5 {
        Alignment::Center
    } else if left > 2.0 && spread(|l| l[2]) < 1.5 {
        Alignment::Right
    } else {
        Alignment::Left
    }
}

pub(crate) fn offset(alignment: Alignment, width: f32, used: f32) -> f32 {
    let free = (width - used).max(0.0);
    match alignment {
        Alignment::Center => free / 2.0,
        Alignment::Right => free,
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_shared_edges_without_mistaking_indent_for_center() {
        assert_eq!(
            detect(&[[40., 0., 100.], [20., 20., 80.]]),
            Alignment::Center
        );
        assert_eq!(
            detect(&[[40., 0., 100.], [20., 20., 100.]]),
            Alignment::Right
        );
        assert_eq!(detect(&[[40., 20., 100.], [20., 0., 90.]]), Alignment::Left);
        assert_eq!(offset(Alignment::Right, 100., 40.), 60.);
        assert_eq!(offset(Alignment::Center, 100., 40.), 30.);
    }
}
