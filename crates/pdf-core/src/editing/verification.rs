//! Exact RGBA comparison outside edited regions, using row slices rather than
//! checking every rectangle for every pixel. The three-pixel margin is unchanged.
pub(crate) fn unchanged_outside(
    before: &[u8],
    after: &[u8],
    width: usize,
    regions: &[[[i32; 2]; 4]],
) -> bool {
    if width == 0 || before.len() != after.len() || before.len() % (width * 4) != 0 {
        return false;
    }
    if regions.is_empty() || before == after {
        return before == after;
    }
    let boxes: Vec<_> = regions
        .iter()
        .map(|q| {
            (
                (q.iter().map(|p| p[0]).min().unwrap() as i64 - 3).clamp(0, width as i64) as usize,
                q.iter().map(|p| p[1]).min().unwrap() as i64 - 3,
                (q.iter().map(|p| p[0]).max().unwrap() as i64 + 4).clamp(0, width as i64) as usize,
                q.iter().map(|p| p[1]).max().unwrap() as i64 + 3,
            )
        })
        .collect();
    let mut intervals = Vec::with_capacity(boxes.len());
    for (y, (a, b)) in before
        .chunks_exact(width * 4)
        .zip(after.chunks_exact(width * 4))
        .enumerate()
    {
        if a == b {
            continue;
        }
        intervals.clear();
        intervals.extend(
            boxes
                .iter()
                .filter(|&&(_, top, _, bottom)| y as i64 >= top && y as i64 <= bottom)
                .map(|&(left, _, right, _)| (left, right)),
        );
        intervals.sort_unstable();
        let mut cursor = 0;
        for &(left, right) in &intervals {
            if left > cursor && a[cursor * 4..left * 4] != b[cursor * 4..left * 4] {
                return false;
            }
            cursor = cursor.max(right);
        }
        if a[cursor * 4..] != b[cursor * 4..] {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_pixel_reference_with_overlapping_and_clipped_regions() {
        let regions = [
            [[-5, -5], [5, -5], [5, 5], [-5, 5]],
            [[4, 4], [9, 4], [9, 9], [4, 9]],
        ];
        let before = vec![0; 20 * 20 * 4];
        for y in 0..20 {
            for x in 0..20 {
                let mut after = before.clone();
                after[(y * 20 + x) * 4 + 3] = 255;
                let allowed = regions.iter().any(|q| {
                    x as i32 >= q.iter().map(|p| p[0]).min().unwrap() - 3
                        && x as i32 <= q.iter().map(|p| p[0]).max().unwrap() + 3
                        && y as i32 >= q.iter().map(|p| p[1]).min().unwrap() - 3
                        && y as i32 <= q.iter().map(|p| p[1]).max().unwrap() + 3
                });
                assert_eq!(
                    unchanged_outside(&before, &after, 20, &regions),
                    allowed,
                    "{x},{y}"
                );
                assert!(!unchanged_outside(&before, &after, 20, &[]));
            }
        }
        assert!(!unchanged_outside(&before, &[], 20, &regions));
    }
}
