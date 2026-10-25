//! Append a stamp without regenerating any original text, paths or shared streams.
use crate::engine::error::EngineError;
use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, ObjectId, Stream,
};

fn resources(doc: &Document, mut page: ObjectId) -> Result<Dictionary, EngineError> {
    let mut seen = std::collections::HashSet::new();
    while seen.insert(page) && seen.len() <= 128 {
        let node = doc
            .get_dictionary(page)
            .map_err(|_| EngineError::EditFailed)?;
        if let Ok(value) = node.get(b"Resources") {
            return doc
                .dereference(value)
                .and_then(|(_, value)| value.as_dict())
                .cloned()
                .map_err(|_| EngineError::EditFailed);
        }
        match node.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => page = parent,
            Err(_) => return Ok(Dictionary::new()),
        }
    }
    Err(EngineError::EditFailed)
}

pub(crate) fn append(
    original: &[u8],
    width: u32,
    height: u32,
    bgra: &[u8],
    placements: &[(i32, [f32; 6])],
    watermark: bool,
) -> Result<Vec<u8>, EngineError> {
    let mut doc = Document::load_mem(original).map_err(|_| EngineError::EditFailed)?;
    let mut rgb = Vec::with_capacity(bgra.len() / 4 * 3);
    let mut alpha = Vec::with_capacity(bgra.len() / 4);
    for pixel in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        alpha.push(pixel[3]);
    }
    let mut image = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => width,
            "Height" => height, "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB",
        },
        rgb,
    );
    if alpha.iter().any(|&value| value != 255) {
        let mut mask = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => width,
                "Height" => height, "BitsPerComponent" => 8, "ColorSpace" => "DeviceGray",
            },
            alpha,
        );
        mask.compress().map_err(|_| EngineError::EditFailed)?;
        image.dict.set("SMask", doc.add_object(mask));
    }
    image.compress().map_err(|_| EngineError::EditFailed)?;
    let image = doc.add_object(image);
    let pages = doc.get_pages();
    for &(index, matrix) in placements {
        let page = *pages
            .get(&(index as u32 + 1))
            .ok_or(EngineError::InvalidPage)?;
        let mut resource = resources(&doc, page)?;
        let mut xobjects = match resource.get(b"XObject") {
            Ok(value) => doc
                .dereference(value)
                .and_then(|(_, value)| value.as_dict())
                .cloned()
                .map_err(|_| EngineError::EditFailed)?,
            Err(_) => Dictionary::new(),
        };
        let mut sequence = 0;
        let name = loop {
            let name = format!("PaperkitStamp{sequence}");
            if !xobjects.has(name.as_bytes()) {
                break name;
            }
            sequence += 1;
        };
        xobjects.set(name.as_bytes(), image);
        resource.set("XObject", xobjects);

        // An original unmatched Q is ignored by PDFium. Supply enough saved states
        // so it cannot consume our isolation state; restore every remaining q.
        let data = doc
            .get_page_content_with_limit(page, 64 * 1024 * 1024)
            .map_err(|_| EngineError::EditFailed)?;
        let (mut depth, mut minimum) = (0i32, 0i32);
        if let Ok(content) = Content::decode_strict(&data) {
            for operation in content.operations {
                match operation.operator.as_str() {
                    "q" => depth += 1,
                    "Q" => depth -= 1,
                    _ => (),
                }
                minimum = minimum.min(depth);
            }
        }
        let prefix = (1 - minimum) as usize;
        let restore = (depth + prefix as i32) as usize;
        let prefix = doc.add_object(Stream::new(dictionary! {}, b"q\n".repeat(prefix)));
        let mut operations = vec![Operation::new("Q", vec![]); restore];
        operations.push(Operation::new("q", vec![]));
        operations.push(Operation::new(
            "cm",
            matrix.into_iter().map(Object::Real).collect(),
        ));
        if watermark {
            operations.push(Operation::new(
                "BMC",
                vec![Object::Name(super::watermarks::TAG.to_vec())],
            ));
        }
        operations.push(Operation::new("Do", vec![Object::Name(name.into_bytes())]));
        if watermark {
            operations.push(Operation::new("EMC", vec![]));
        }
        operations.push(Operation::new("Q", vec![]));
        let suffix = doc.add_object(Stream::new(
            dictionary! {},
            Content { operations }
                .encode()
                .map_err(|_| EngineError::EditFailed)?,
        ));
        let mut contents = vec![Object::Reference(prefix)];
        contents.extend(
            doc.get_page_contents(page)
                .into_iter()
                .map(Object::Reference),
        );
        contents.push(Object::Reference(suffix));
        let page = doc
            .get_dictionary_mut(page)
            .map_err(|_| EngineError::EditFailed)?;
        page.set("Resources", resource);
        page.set("Contents", contents);
    }
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|_| EngineError::EditFailed)?;
    Ok(bytes)
}
