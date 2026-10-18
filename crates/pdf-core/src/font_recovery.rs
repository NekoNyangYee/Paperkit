//! Recover a Unicode cmap from a PDF's explicit CID mapping without changing glyph outlines.
use lopdf::{Document, Encoding, Object};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

type RecoveryEntry = ([u8; 32], Option<Vec<u8>>);
thread_local! {
    // The worker owns this cache. PDF content is part of the key because identical
    // font streams in different PDFs can have different ToUnicode mappings.
    static RECOVERED: std::cell::RefCell<std::collections::VecDeque<RecoveryEntry>> = const { std::cell::RefCell::new(std::collections::VecDeque::new()) };
}

fn resolved<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, value)| value)
}

pub(crate) fn matching_embedded(pdf: &[u8], name: &str, text: &str) -> Option<Vec<u8>> {
    let doc = Document::load_mem(pdf).ok()?;
    let mut seen = std::collections::BTreeSet::new();
    let mut inspected = 0;
    for object in doc.objects.values() {
        let Ok(descriptor) = object.as_dict() else {
            continue;
        };
        if descriptor.get(b"Type").ok().and_then(|o| o.as_name().ok()) != Some(b"FontDescriptor") {
            continue;
        }
        let Some(candidate_name) = descriptor
            .get(b"FontName")
            .ok()
            .and_then(|o| o.as_name().ok())
            .and_then(|n| std::str::from_utf8(n).ok())
        else {
            continue;
        };
        if crate::system_fonts::normalized(candidate_name) != crate::system_fonts::normalized(name)
        {
            continue;
        }
        let Some(stream) = descriptor
            .get(b"FontFile2")
            .ok()
            .and_then(|o| resolved(&doc, o))
            .and_then(|o| o.as_stream().ok())
        else {
            continue;
        };
        inspected += 1;
        if inspected > 256 {
            break;
        }
        let Ok(bytes) = stream.get_plain_content_with_limit(32 * 1024 * 1024) else {
            continue;
        };
        if !seen.insert(Sha256::digest(&bytes).to_vec()) {
            continue;
        }
        if crate::fonts::validate_original(&bytes, text).is_ok() {
            return Some(bytes);
        }
        if let Some(repaired) = recover(pdf, &bytes) {
            if crate::fonts::validate_original(&repaired, text).is_ok() {
                return Some(repaired);
            }
        }
    }
    None
}

pub(crate) fn recover(pdf: &[u8], original: &[u8]) -> Option<Vec<u8>> {
    let mut hash = Sha256::new();
    hash.update((pdf.len() as u64).to_le_bytes());
    hash.update(pdf);
    hash.update(original);
    let key: [u8; 32] = hash.finalize().into();
    if let Some(hit) = RECOVERED.with(|cache| {
        let mut cache = cache.borrow_mut();
        let index = cache.iter().position(|(id, _)| *id == key)?;
        let entry = cache.remove(index)?;
        let result = entry.1.clone();
        cache.push_back(entry);
        Some(result)
    }) {
        return hit;
    }
    let result = recover_uncached(pdf, original);
    RECOVERED.with(|cache| {
        let mut cache = cache.borrow_mut();
        cache.push_back((key, result.clone()));
        while cache.len() > 32
            || cache
                .iter()
                .map(|(_, bytes)| bytes.as_ref().map_or(0, Vec::len))
                .sum::<usize>()
                > 16 * 1024 * 1024
        {
            cache.pop_front();
        }
    });
    result
}

fn recover_uncached(pdf: &[u8], original: &[u8]) -> Option<Vec<u8>> {
    let face = ttf_parser::Face::parse(original, 0).ok()?;
    face.raw_face()
        .table(ttf_parser::Tag::from_bytes(b"glyf"))?;
    // PDF subsetters may omit OS/2 entirely. Absence is not an explicit restriction.
    // Only this document-bound recovery path accepts missing metadata.
    if face.tables().os2.is_some() && !face.is_outline_embedding_allowed() {
        return None;
    }
    let doc = Document::load_mem(pdf).ok()?;
    let mut recovered = BTreeMap::new();
    for object in doc.objects.values() {
        let Ok(font) = object.as_dict() else { continue };
        if font.get(b"Subtype").ok().and_then(|v| v.as_name().ok()) != Some(b"Type0".as_slice())
            || font.get(b"Encoding").ok().and_then(|v| v.as_name().ok())
                != Some(b"Identity-H".as_slice())
        {
            continue;
        }
        let Some(descendant) = font
            .get(b"DescendantFonts")
            .ok()
            .and_then(|v| resolved(&doc, v))
            .and_then(|v| v.as_array().ok())
            .and_then(|v| v.first())
            .and_then(|v| resolved(&doc, v))
            .and_then(|v| v.as_dict().ok())
        else {
            continue;
        };
        if descendant
            .get(b"Subtype")
            .ok()
            .and_then(|v| v.as_name().ok())
            != Some(b"CIDFontType2".as_slice())
        {
            continue;
        }
        let Some(stream) = descendant
            .get(b"FontDescriptor")
            .ok()
            .and_then(|v| resolved(&doc, v))
            .and_then(|v| v.as_dict().ok())
            .and_then(|v| v.get(b"FontFile2").ok())
            .and_then(|v| resolved(&doc, v))
            .and_then(|v| v.as_stream().ok())
        else {
            continue;
        };
        if stream
            .get_plain_content_with_limit(32 * 1024 * 1024)
            .ok()?
            .as_slice()
            != original
        {
            continue;
        }
        let Ok(Encoding::UnicodeMapEncoding(cmap)) =
            font.get_font_encoding_with_limit(&doc, 4 * 1024 * 1024)
        else {
            continue;
        };
        let gids = match descendant
            .get(b"CIDToGIDMap")
            .ok()
            .and_then(|v| resolved(&doc, v))
        {
            Some(Object::Name(name)) if name == b"Identity" => None,
            Some(Object::Stream(stream)) => Some(stream.get_plain_content_with_limit(131072).ok()?),
            _ => continue, // Never infer a missing CID-to-glyph mapping.
        };
        for cid in 0..=u16::MAX {
            let Some(unicode) = cmap.get(u32::from(cid), 2) else {
                continue;
            };
            let Ok(text) = String::from_utf16(&unicode) else {
                continue;
            };
            let mut chars = text.chars();
            let Some(ch) = chars.next() else { continue };
            if chars.next().is_some()
                || ch.is_control()
                || (ch as u32 & 0xFFFF) >= 0xFFFE
                || (0xFDD0..=0xFDEF).contains(&(ch as u32))
            {
                continue;
            }
            let gid = if let Some(bytes) = &gids {
                let offset = usize::from(cid) * 2;
                let Some(bytes) = bytes.get(offset..offset + 2) else {
                    continue;
                };
                u16::from_be_bytes([bytes[0], bytes[1]])
            } else {
                cid
            };
            if gid == 0 || gid >= face.number_of_glyphs() {
                continue;
            }
            if recovered
                .insert(ch as u32, gid)
                .is_some_and(|old| old != gid)
            {
                return None;
            }
        }
    }
    if recovered.is_empty() {
        return None;
    }
    let mut mapping = BTreeMap::new();
    if let Some(cmap) = face.tables().cmap {
        for subtable in cmap
            .subtables
            .into_iter()
            .filter(|table| table.is_unicode())
        {
            subtable.codepoints(|code| {
                if let Some(gid) = subtable.glyph_index(code).filter(|gid| gid.0 != 0) {
                    mapping.entry(code).or_insert(gid.0);
                }
            });
        }
    }
    // An existing Unicode entry pointing at a different outline is ambiguous.
    for (code, gid) in recovered {
        if mapping.insert(code, gid).is_some_and(|old| old != gid) {
            return None;
        }
    }
    let mut cmap = Vec::new();
    cmap.extend(0u16.to_be_bytes());
    cmap.extend(1u16.to_be_bytes());
    cmap.extend(3u16.to_be_bytes());
    cmap.extend(10u16.to_be_bytes());
    cmap.extend(12u32.to_be_bytes());
    cmap.extend(12u16.to_be_bytes());
    cmap.extend(0u16.to_be_bytes());
    cmap.extend((16 + 12 * mapping.len() as u32).to_be_bytes());
    cmap.extend(0u32.to_be_bytes());
    cmap.extend((mapping.len() as u32).to_be_bytes());
    for (code, gid) in mapping {
        cmap.extend(code.to_be_bytes());
        cmap.extend(code.to_be_bytes());
        cmap.extend(u32::from(gid).to_be_bytes());
    }
    let mut tables = BTreeMap::new();
    for record in face.raw_face().table_records {
        if record.tag.to_bytes() == *b"DSIG" {
            continue;
        }
        tables.insert(
            record.tag.to_bytes(),
            face.raw_face().table(record.tag)?.to_vec(),
        );
    }
    tables.insert(*b"cmap", cmap);
    complete_subset_metadata(&face, &mut tables);
    rebuild(tables)
}

/// Supply browser-required metadata omitted by PDF subsetters, leaving outlines,
/// advances, hinting and existing metadata untouched. Never install this subset.
fn complete_subset_metadata(face: &ttf_parser::Face<'_>, tables: &mut BTreeMap<[u8; 4], Vec<u8>>) {
    tables.entry(*b"OS/2").or_insert_with(|| {
        let mut data = vec![0; 78]; // OpenType OS/2 version 0.
        let style = face
            .raw_face()
            .table(ttf_parser::Tag::from_bytes(b"head"))
            .and_then(|head| head.get(44..46))
            .map_or(0, |b| u16::from_be_bytes([b[0], b[1]]));
        let bold = style & 1 != 0;
        let italic = style & 2 != 0;
        data[4..6].copy_from_slice(&(if bold { 700u16 } else { 400 }).to_be_bytes());
        data[6..8].copy_from_slice(&5u16.to_be_bytes());
        data[8..10].copy_from_slice(&8u16.to_be_bytes()); // Document editing, not installable.
        let selection: u16 = if bold || italic {
            (u16::from(bold) << 5) | u16::from(italic)
        } else {
            64
        };
        data[62..64].copy_from_slice(&selection.to_be_bytes());
        data[66..68].copy_from_slice(&u16::MAX.to_be_bytes());
        data[68..70].copy_from_slice(&face.ascender().to_be_bytes());
        data[70..72].copy_from_slice(&face.descender().to_be_bytes());
        data[72..74].copy_from_slice(&face.line_gap().to_be_bytes());
        data[74..76].copy_from_slice(&(face.ascender().max(0) as u16).to_be_bytes());
        data[76..78].copy_from_slice(&face.descender().unsigned_abs().to_be_bytes());
        data
    });
    tables.entry(*b"post").or_insert_with(|| {
        let mut data = vec![0; 32];
        data[..4].copy_from_slice(&0x00030000u32.to_be_bytes());
        data
    });
    tables.entry(*b"name").or_insert_with(|| {
        // The UI retains the original PDF name. This internal name cannot collide
        // with an installed full font and does not claim to be one.
        let entries = [
            (1u16, "PaperkitSubset"),
            (2, "Regular"),
            (4, "PaperkitSubset"),
            (6, "PaperkitSubset"),
        ];
        let mut data = Vec::new();
        data.extend(0u16.to_be_bytes());
        data.extend((entries.len() as u16).to_be_bytes());
        data.extend((6 + entries.len() as u16 * 12).to_be_bytes());
        let mut strings = Vec::new();
        for (id, value) in entries {
            let value: Vec<u8> = value.encode_utf16().flat_map(u16::to_be_bytes).collect();
            for word in [3, 1, 0x0409, id, value.len() as u16, strings.len() as u16] {
                data.extend(word.to_be_bytes());
            }
            strings.extend(value);
        }
        data.extend(strings);
        data
    });
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn rebuild(tables: BTreeMap<[u8; 4], Vec<u8>>) -> Option<Vec<u8>> {
    let count = u16::try_from(tables.len()).ok()?;
    if count == 0 || count > 4095 {
        return None;
    }
    let power = 15 - count.leading_zeros() as u16;
    let search = 16u16.checked_shl(u32::from(power))?;
    let mut out = vec![0; 12 + usize::from(count) * 16];
    out[..4].copy_from_slice(&0x00010000u32.to_be_bytes());
    out[4..6].copy_from_slice(&count.to_be_bytes());
    out[6..8].copy_from_slice(&search.to_be_bytes());
    out[8..10].copy_from_slice(&power.to_be_bytes());
    out[10..12].copy_from_slice(&(count * 16 - search).to_be_bytes());
    let mut head = None;
    for (index, (tag, mut data)) in tables.into_iter().enumerate() {
        let offset = out.len();
        if tag == *b"head" {
            data.get_mut(8..12)?.fill(0);
            head = Some(offset);
        }
        let entry = 12 + index * 16;
        out[entry..entry + 4].copy_from_slice(&tag);
        out[entry + 4..entry + 8].copy_from_slice(&checksum(&data).to_be_bytes());
        out[entry + 8..entry + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        out[entry + 12..entry + 16].copy_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    let head = head?;
    let adjustment = 0xB1B0AFBAu32.wrapping_sub(checksum(&out));
    out[head + 8..head + 12].copy_from_slice(&adjustment.to_be_bytes());
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{edit::EditAction, render::PreviewEngine};
    use lopdf::{dictionary, Stream};

    #[test]
    fn rejects_malformed_fonts() {
        assert!(recover(b"%PDF-1.7", b"invalid font").is_none());
    }

    #[test]
    #[ignore = "requires PAPERKIT_TEST_PDF pointing to the STK regression document"]
    fn stk_original_subset_edits_and_roundtrips() {
        let path = std::path::PathBuf::from(
            std::env::var_os("PAPERKIT_TEST_PDF").expect("PAPERKIT_TEST_PDF"),
        );
        let original = std::fs::read(&path).unwrap();
        let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources");
        let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
        let before = engine.render("stk".into(), path.clone(), 0, 800).unwrap();
        let source = before
            .text
            .objects
            .iter()
            .find(|o| o.font.ends_with("+HCRBatang"))
            .unwrap();
        let bytes = engine.font("stk".into(), 0, 0, source.id).unwrap();
        assert!(
            bytes.len() < 200_000,
            "must use original subset, not installed full font"
        );
        let doc = Document::load_mem(&original).unwrap();
        let raw = doc
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .filter_map(|s| s.get_plain_content().ok())
            .find(|b| ttf_parser::Face::parse(b, 0).is_ok_and(|f| f.number_of_glyphs() == 525))
            .unwrap();
        let recovered = ttf_parser::Face::parse(&bytes, 0).unwrap();
        let embedded = ttf_parser::Face::parse(&raw, 0).unwrap();
        for tag in [b"glyf", b"hmtx", b"loca"] {
            assert_eq!(
                recovered.raw_face().table(ttf_parser::Tag::from_bytes(tag)),
                embedded.raw_face().table(ttf_parser::Tag::from_bytes(tag))
            );
        }
        let group = before
            .text
            .groups
            .iter()
            .find(|g| g.can_flow && g.text.contains("전시 종료 후 당일 철거"))
            .unwrap();
        let text = format!("{} dd", group.text);
        let edit_started = std::time::Instant::now();
        engine
            .edit(
                "stk".into(),
                0,
                EditAction::FlowBlock {
                    page: 0,
                    group: group.id,
                    text,
                    width: None,
                    height: None,
                },
            )
            .unwrap();
        eprintln!("edit_ms={}", edit_started.elapsed().as_millis());
        let render_started = std::time::Instant::now();
        let edited = engine.render("stk".into(), path.clone(), 0, 800).unwrap();
        eprintln!("render_ms={}", render_started.elapsed().as_millis());
        assert!(edited.text.objects.iter().any(|o| o.text.contains("dd")));
        let directory = std::env::temp_dir().join(format!("paperkit-stk-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("edited.pdf");
        let save_started = std::time::Instant::now();
        engine
            .edit(
                "stk".into(),
                1,
                EditAction::Save {
                    path: output.clone(),
                },
            )
            .unwrap();
        eprintln!("save_ms={}", save_started.elapsed().as_millis());
        assert_eq!(
            engine
                .render("reopened".into(), output, 0, 800)
                .unwrap()
                .png,
            edited.png
        );
        assert_eq!(std::fs::read(path).unwrap(), original);
        if let Some(directory) = std::env::var_os("PAPERKIT_FONT_CHECK_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let data = serde_json::to_string(&bytes).unwrap();
            std::fs::write(directory.join("font-check.html"),format!("<!doctype html><meta charset=utf-8><body>pending<script>new FontFace('original',new Uint8Array({data})).load().then(f=>{{document.fonts.add(f);document.body.textContent='FONT_LOAD_OK';document.body.style.fontFamily='original';}}).catch(e=>document.body.textContent='FONT_LOAD_FAILED: '+e)</script>")).unwrap();
        }
    }

    #[test]
    #[ignore = "requires bundled PDFium and fonts"]
    fn recovers_embedded_cmap_and_edits_without_installed_original() {
        let resources = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources");
        let data = std::fs::read(resources.join("fonts/Pretendard-Regular.ttf")).unwrap();
        let face = ttf_parser::Face::parse(&data, 0).unwrap();
        let glyphs: Vec<_> = "가나다"
            .chars()
            .map(|ch| face.glyph_index(ch).unwrap().0)
            .collect();
        let mut tables = BTreeMap::new();
        for record in face.raw_face().table_records {
            if !matches!(
                &record.tag.to_bytes(),
                b"DSIG" | b"OS/2" | b"name" | b"post"
            ) {
                tables.insert(
                    record.tag.to_bytes(),
                    face.raw_face().table(record.tag).unwrap().to_vec(),
                );
            }
        }
        tables.insert(*b"cmap", vec![0, 0, 0, 0]);
        let stripped = rebuild(tables).unwrap();
        assert!(crate::fonts::validate_original(&stripped, "가나").is_err());
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let font_file = doc.add_object(Stream::new(
            dictionary! {"Length1"=>stripped.len() as i64},
            stripped.clone(),
        ));
        let descriptor=doc.add_object(dictionary!{"Type"=>"FontDescriptor","FontName"=>"ABCDEF+PaperkitRecoveryOnly","Flags"=>4,"FontBBox"=>vec![Object::Integer(0),0.into(),1000.into(),1000.into()],"ItalicAngle"=>0,"Ascent"=>1000,"Descent"=>-200,"CapHeight"=>700,"StemV"=>80,"FontFile2"=>font_file});
        let descendant=doc.add_object(dictionary!{"Type"=>"Font","Subtype"=>"CIDFontType2","BaseFont"=>"ABCDEF+PaperkitRecoveryOnly","CIDSystemInfo"=>dictionary!{"Registry"=>Object::string_literal("Adobe"),"Ordering"=>Object::string_literal("Identity"),"Supplement"=>0},"FontDescriptor"=>descriptor,"CIDToGIDMap"=>"Identity","DW"=>1000});
        let cmap=format!("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Recovery def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n5 beginbfchar\n<0000> <FFFF>\n<0001> <FFFF>\n<0002> <FFFF>\n<{:04X}> <AC00>\n<{:04X}> <B098>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend",glyphs[0],glyphs[1]);
        let unicode = doc.add_object(Stream::new(dictionary! {}, cmap.into_bytes()));
        let font=doc.add_object(dictionary!{"Type"=>"Font","Subtype"=>"Type0","BaseFont"=>"ABCDEF+PaperkitRecoveryOnly","Encoding"=>"Identity-H","DescendantFonts"=>vec![Object::Reference(descendant)],"ToUnicode"=>unicode});
        let content = doc.add_object(Stream::new(
            dictionary! {},
            format!(
                "BT /F1 16 Tf 20 220 Td <{:04X}{:04X}> Tj ET",
                glyphs[0], glyphs[1]
            )
            .into_bytes(),
        ));
        let page=doc.add_object(dictionary!{"Type"=>"Page","Parent"=>pages,"MediaBox"=>vec![Object::Integer(0),0.into(),300.into(),300.into()],"Resources"=>dictionary!{"Font"=>dictionary!{"F1"=>font}},"Contents"=>content});
        doc.objects.insert(
            pages,
            dictionary! {"Type"=>"Pages","Kids"=>vec![Object::Reference(page)],"Count"=>1}.into(),
        );
        let root = doc.add_object(dictionary! {"Type"=>"Catalog","Pages"=>pages});
        doc.trailer.set("Root", root);
        let mut original = Vec::new();
        doc.save_to(&mut original).unwrap();
        let repaired = recover(&original, &stripped).unwrap();
        assert_eq!(recover(&original, &stripped).unwrap(), repaired);
        // Same font bytes must not reuse a different document's Unicode map.
        let mut other = Document::load_mem(&original).unwrap();
        let stream = other
            .get_object_mut(unicode)
            .unwrap()
            .as_stream_mut()
            .unwrap();
        stream.set_content(
            String::from_utf8(stream.content.clone())
                .unwrap()
                .replace("<B098>", "<B099>")
                .into_bytes(),
        );
        let mut other_bytes = Vec::new();
        other.save_to(&mut other_bytes).unwrap();
        let other_font = recover(&other_bytes, &stripped).unwrap();
        assert!(crate::fonts::validate_original(&other_font, "나").is_err());
        assert_eq!(recover(&original, &stripped).unwrap(), repaired);
        crate::fonts::validate_original(&repaired, "나가").unwrap();
        assert!(
            crate::fonts::validate_original(&repaired, "다").is_err(),
            "never invent a missing Unicode mapping"
        );
        assert_eq!(checksum(&repaired), 0xB1B0AFBA);
        let repaired_face = ttf_parser::Face::parse(&repaired, 0).unwrap();
        assert_eq!(
            repaired_face
                .raw_face()
                .table(ttf_parser::Tag::from_bytes(b"glyf")),
            face.raw_face().table(ttf_parser::Tag::from_bytes(b"glyf"))
        );
        let engine = PreviewEngine::start(resources.join("pdfium/pdfium.dll")).unwrap();
        let directory = std::env::temp_dir().join(format!("paperkit-cmap-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("source.pdf");
        std::fs::write(&path, &original).unwrap();
        let before = engine
            .render("recovery".into(), path.clone(), 0, 800)
            .unwrap();
        assert_eq!(before.text.objects[0].text.trim(), "가나");
        assert_eq!(before.text.objects[0].edit_blocked, None);
        let browser_font = engine.font("recovery".into(), 0, 0, 0).unwrap();
        crate::fonts::validate_original(&browser_font, "나가").unwrap();
        let group = before
            .text
            .groups
            .iter()
            .find(|group| group.can_flow)
            .unwrap();
        engine
            .edit(
                "recovery".into(),
                0,
                EditAction::FlowBlock {
                    page: 0,
                    group: group.id,
                    text: "나가나가".into(),
                    width: Some(240.0),
                    height: None,
                },
            )
            .unwrap();
        let edited = engine
            .render("recovery".into(), path.clone(), 0, 800)
            .unwrap();
        assert_eq!(edited.text.objects[0].text.trim(), "나가나가");
        let output = directory.join("saved.pdf");
        engine
            .edit(
                "recovery".into(),
                1,
                EditAction::Save {
                    path: output.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            engine
                .render("reopened".into(), output, 0, 800)
                .unwrap()
                .png,
            edited.png
        );
        assert_eq!(std::fs::read(path).unwrap(), original);

        // The active subset lacks '다', while another embedded copy of the
        // exact face has it. A Bold face must never satisfy a Regular request.
        let full_file = doc.add_object(Stream::new(
            dictionary! {"Length1" => data.len() as i64},
            data.clone(),
        ));
        let second_descriptor = doc.add_object(dictionary! {"Type"=>"FontDescriptor", "FontName"=>"UVWXYZ+PaperkitRecoveryOnly-Bold", "FontFile2"=>full_file});
        let mut with_sibling = Vec::new();
        doc.save_to(&mut with_sibling).unwrap();
        assert!(matching_embedded(&with_sibling, "ABCDEF+PaperkitRecoveryOnly", "다").is_none());
        doc.get_object_mut(second_descriptor)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("FontName", "UVWXYZ+PaperkitRecoveryOnly");
        let second_descendant = doc.add_object(dictionary! {"Type"=>"Font", "Subtype"=>"CIDFontType2", "BaseFont"=>"UVWXYZ+PaperkitRecoveryOnly", "CIDSystemInfo"=>dictionary!{"Registry"=>Object::string_literal("Adobe"),"Ordering"=>Object::string_literal("Identity"),"Supplement"=>0}, "FontDescriptor"=>second_descriptor, "CIDToGIDMap"=>"Identity", "DW"=>1000});
        let second_font = doc.add_object(dictionary! {"Type"=>"Font", "Subtype"=>"Type0", "BaseFont"=>"UVWXYZ+PaperkitRecoveryOnly", "Encoding"=>"Identity-H", "DescendantFonts"=>vec![Object::Reference(second_descendant)], "ToUnicode"=>unicode});
        doc.get_object_mut(page)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .get_mut(b"Resources")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .get_mut(b"Font")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("F2", second_font);
        let stream = doc
            .get_object_mut(content)
            .unwrap()
            .as_stream_mut()
            .unwrap();
        let mut commands = stream.content.clone();
        commands.extend_from_slice(
            format!("\nBT /F2 16 Tf 20 60 Td <{:04X}> Tj ET", glyphs[0]).as_bytes(),
        );
        stream.set_content(commands);
        with_sibling.clear();
        doc.save_to(&mut with_sibling).unwrap();
        let recovered_sibling =
            matching_embedded(&with_sibling, "ABCDEF+PaperkitRecoveryOnly", "다").unwrap();
        assert_eq!(recovered_sibling, data);
        let sibling_path = directory.join("sibling.pdf");
        std::fs::write(&sibling_path, &with_sibling).unwrap();
        let sibling_page = engine
            .render("sibling".into(), sibling_path.clone(), 0, 800)
            .unwrap();
        let sibling_group = sibling_page
            .text
            .groups
            .iter()
            .find(|g| g.can_flow)
            .unwrap();
        engine
            .edit(
                "sibling".into(),
                0,
                EditAction::FlowBlock {
                    page: 0,
                    group: sibling_group.id,
                    text: "다나가".into(),
                    width: Some(240.0),
                    height: None,
                },
            )
            .unwrap();
        let changed = engine
            .render("sibling".into(), sibling_path.clone(), 0, 800)
            .unwrap();
        assert!(changed
            .text
            .objects
            .iter()
            .any(|o| o.text.trim() == "다나가"));
        assert!(changed.text.objects.iter().any(|o| o.text.trim() == "가"));
        let saved = directory.join("sibling-saved.pdf");
        engine
            .edit(
                "sibling".into(),
                1,
                EditAction::Save {
                    path: saved.clone(),
                },
            )
            .unwrap();
        assert_eq!(
            engine
                .render("sibling-reopened".into(), saved, 0, 800)
                .unwrap()
                .png,
            changed.png
        );
        assert_eq!(std::fs::read(sibling_path).unwrap(), with_sibling);
    }
}
