//! Transform one paint operation while preserving every other source byte.
use crate::{engine::error::EngineError, text::GraphicObject};
use lopdf::{
    content::{Content, Operation},
    Dictionary, Document, Object, Stream,
};

fn paints(operator: &str) -> bool {
    matches!(
        operator,
        "Do" | "BI"
            | "sh"
            | "S"
            | "s"
            | "f"
            | "F"
            | "f*"
            | "B"
            | "B*"
            | "b"
            | "b*"
            | "Tj"
            | "TJ"
            | "'"
            | "\""
    )
}
fn kind(operator: &str) -> Option<&'static str> {
    match operator {
        "Do" => Some("draw"),
        "BI" => Some("image"),
        "sh" => Some("shading"),
        "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => Some("path"),
        _ => None,
    }
}

pub(crate) fn edit(
    original: &[u8],
    index: i32,
    objects: &[GraphicObject],
    id: usize,
    matrix: Option<[f32; 6]>,
) -> Result<Vec<u8>, EngineError> {
    let mut doc = Document::load_mem(original).map_err(|_| EngineError::EditFailed)?;
    let page = *doc
        .get_pages()
        .get(&(index as u32 + 1))
        .ok_or(EngineError::InvalidPage)?;
    let data = doc
        .get_page_content_with_limit(page, 64 * 1024 * 1024)
        .map_err(|_| EngineError::UnsupportedText)?;
    let content = Content::decode_strict(&data).map_err(|_| EngineError::UnsupportedText)?;
    let spans = super::spans::operations(&data, &content.operations)?;
    let draws: Vec<_> = content
        .operations
        .iter()
        .enumerate()
        .filter_map(|(i, op)| kind(&op.operator).map(|kind| (i, kind)))
        .collect();
    if draws.len() != objects.len()
        || draws.iter().zip(objects).any(|((_, kind), o)| {
            if *kind == "draw" {
                !matches!(o.kind, "image" | "form")
            } else {
                *kind != o.kind
            }
        })
    {
        return Err(EngineError::UnsupportedText);
    }
    let ordinal = objects
        .iter()
        .position(|o| o.id == id)
        .ok_or(EngineError::StaleObject)?;
    let target = draws[ordinal].0;
    let identity = [1., 0., 0., 1., 0., 0.];
    let mut ctm = identity;
    let mut stack = Vec::new();
    let mut scopes = Vec::new();
    let mut states = Vec::new();
    let mut paint_count = 0;
    let mut path_start = None;
    let mut target_path = None;
    for (i, op) in content.operations.iter().enumerate() {
        states.push(ctm);
        match op.operator.as_str() {
            "q" => stack.push((i, ctm, paint_count)),
            "Q" => {
                let (start, saved, count) = stack.pop().ok_or(EngineError::UnsupportedText)?;
                if start < target && target < i && paint_count == count + 1 {
                    scopes.push((start, i));
                }
                ctm = saved;
            }
            "cm" => {
                let values: Vec<_> = op
                    .operands
                    .iter()
                    .map(|o| o.as_float().map_err(|_| EngineError::UnsupportedText))
                    .collect::<Result<_, _>>()?;
                ctm = super::movement::multiply(
                    ctm,
                    values
                        .try_into()
                        .map_err(|_| EngineError::UnsupportedText)?,
                );
            }
            "m" | "re" => {
                if path_start.is_none() {
                    path_start = Some(i);
                }
            }
            "n" => path_start = None,
            _ => (),
        }
        if paints(&op.operator) {
            if i == target && kind(&op.operator) == Some("path") {
                target_path = path_start;
            }
            paint_count += 1;
            if kind(&op.operator) == Some("path") {
                path_start = None;
            }
        }
    }
    if !stack.is_empty() {
        return Err(EngineError::UnsupportedText);
    }
    let (start, end) = if matrix.is_some() {
        scopes
            .into_iter()
            .min_by_key(|(start, _)| *start)
            .unwrap_or((target_path.unwrap_or(target), target))
    } else {
        (target, target)
    };
    let range = spans[start].start..spans[end].end;
    let mut output = data[..range.start].to_vec();
    if let Some(matrix) = matrix {
        let local = super::movement::multiply(
            super::movement::multiply(super::movement::inverse(states[start])?, matrix),
            states[start],
        );
        if local.iter().any(|v| !v.is_finite()) {
            return Err(EngineError::UnsupportedText);
        }
        output.extend_from_slice(b"\nq\n");
        output.extend(
            Content {
                operations: vec![Operation::new(
                    "cm",
                    local.into_iter().map(Object::Real).collect(),
                )],
            }
            .encode()
            .map_err(|_| EngineError::EditFailed)?,
        );
        output.push(b'\n');
        output.extend_from_slice(&data[range.clone()]);
        output.extend_from_slice(b"\nQ\n");
    } else if kind(&content.operations[target].operator) == Some("path") {
        output.extend_from_slice(b"\nn\n");
    } else {
        output.push(b'\n');
    }
    output.extend_from_slice(&data[range.end..]);
    let stream = doc.add_object(Stream::new(Dictionary::new(), output));
    doc.get_dictionary_mut(page)
        .map_err(|_| EngineError::EditFailed)?
        .set("Contents", stream);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|_| EngineError::EditFailed)?;
    Ok(bytes)
}
