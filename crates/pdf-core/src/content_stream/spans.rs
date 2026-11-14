//! Locate already-parsed operations without re-encoding untouched PDF numbers,
//! strings or comments. Inline images use the strict parser to confirm boundaries.
use super::super::engine::error::EngineError;
use lopdf::content::Operation;
use std::ops::Range;

fn delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || byte == 0 || b"()<>[]{}/%".contains(&byte)
}

pub(super) fn operations(
    data: &[u8],
    operations: &[Operation],
) -> Result<Vec<Range<usize>>, EngineError> {
    let mut spans = Vec::new();
    let (mut i, mut start, mut depth) = (0, 0, 0usize);
    while i < data.len() {
        match data[i] {
            b'%' => {
                while i < data.len() && !b"\r\n".contains(&data[i]) {
                    i += 1;
                }
            }
            b'(' => {
                i += 1;
                let mut nesting = 1;
                while i < data.len() && nesting > 0 {
                    match data[i] {
                        b'\\' => {
                            i += 1;
                            if i < data.len() {
                                i += 1;
                            }
                        }
                        b'(' => {
                            nesting += 1;
                            i += 1;
                        }
                        b')' => {
                            nesting -= 1;
                            i += 1;
                        }
                        _ => i += 1,
                    }
                }
                if nesting != 0 {
                    return Err(EngineError::UnsupportedText);
                }
            }
            b'<' if data.get(i + 1) == Some(&b'<') => {
                depth += 1;
                i += 2;
            }
            b'<' => {
                i += 1;
                while i < data.len() && data[i] != b'>' {
                    i += 1;
                }
                if i == data.len() {
                    return Err(EngineError::UnsupportedText);
                }
                i += 1;
            }
            b'>' if data.get(i + 1) == Some(&b'>') && depth > 0 => {
                depth -= 1;
                i += 2;
            }
            b'[' => {
                depth += 1;
                i += 1;
            }
            b']' if depth > 0 => {
                depth -= 1;
                i += 1;
            }
            b'/' => {
                i += 1;
                while i < data.len() && !delimiter(data[i]) {
                    i += 1;
                }
            }
            b if b.is_ascii_whitespace() || b == 0 => i += 1,
            b')' | b'>' | b']' | b'{' | b'}' => return Err(EngineError::UnsupportedText),
            _ => {
                let token_start = i;
                while i < data.len() && !delimiter(data[i]) {
                    i += 1;
                }
                if i == token_start {
                    return Err(EngineError::UnsupportedText);
                }
                if depth != 0 {
                    continue;
                }
                let token = &data[token_start..i];
                if token
                    .first()
                    .is_some_and(|b| b.is_ascii_digit() || b"+-.".contains(b))
                    || [b"true".as_slice(), b"false", b"null"].contains(&token)
                {
                    continue;
                }
                let expected = operations
                    .get(spans.len())
                    .ok_or(EngineError::UnsupportedText)?;
                if token != expected.operator.as_bytes() {
                    return Err(EngineError::UnsupportedText);
                }
                if token == b"BI" {
                    // Do not tokenize arbitrary image bytes as operators. A boundary
                    // is accepted only if a strict one-operation parse agrees with
                    // the already-decoded image (including its exact raw bytes).
                    let mut end = None;
                    for (offset, _) in data[i..]
                        .windows(4)
                        .enumerate()
                        .filter(|(_, w)| {
                            w[0].is_ascii_whitespace()
                                && &w[1..3] == b"EI"
                                && w[3].is_ascii_whitespace()
                        })
                        .take(64)
                    {
                        let candidate = i + offset + 4;
                        if lopdf::content::Content::decode_strict(&data[token_start..candidate])
                            .is_ok_and(|c| {
                                c.operations.len() == 1
                                    && c.operations[0].operator == expected.operator
                                    && c.operations[0].operands == expected.operands
                            })
                        {
                            end = Some(candidate);
                            break;
                        }
                    }
                    i = end.ok_or(EngineError::UnsupportedText)?;
                }
                spans.push(start..i);
                start = i;
            }
        }
    }
    if spans.len() != operations.len() || depth != 0 {
        return Err(EngineError::UnsupportedText);
    }
    Ok(spans)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::Content;
    #[test]
    fn ignores_operator_words_in_names_strings_hex_arrays_and_comments() {
        let data = b"q % Do is not a draw\n 1.000000001 0 0 1 2 3 cm BT /FontDo 12 Tf [(Do\\)Tj) 12 <446f>] TJ ET /ImageDo Do Q\n";
        let content = Content::decode_strict(data).unwrap();
        let spans = operations(data, &content.operations).unwrap();
        for (span, op) in spans.iter().zip(content.operations) {
            let parsed = Content::decode_strict(&data[span.clone()])
                .unwrap()
                .operations;
            assert_eq!(parsed.len(), 1);
            assert_eq!(parsed[0].operator, op.operator);
            assert_eq!(parsed[0].operands, op.operands);
        }
        assert!(std::str::from_utf8(&data[spans[1].clone()])
            .unwrap()
            .contains("1.000000001"));
    }

    #[test]
    fn preserves_inline_image_data_without_tokenizing_its_bytes() {
        let data = b"q 80 0 0 80 10 10 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID ABC\nEI Q\n";
        let parsed = Content::decode_strict(data).unwrap();
        let spans = operations(data, &parsed.operations).unwrap();
        assert_eq!(parsed.operations[2].operator, "BI");
        assert!(data[spans[2].clone()]
            .windows(3)
            .any(|bytes| bytes == b"ABC"));
        assert_eq!(spans.len(), 4);
    }
}
