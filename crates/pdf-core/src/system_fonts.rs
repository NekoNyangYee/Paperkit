//! Exact face-name lookup; never substitute a family or guess a font weight.
use crate::{fonts::validate_original, render::PreviewError};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

static IMPORTED: OnceLock<Mutex<HashMap<String, Arc<Vec<u8>>>>> = OnceLock::new();
fn imported() -> &'static Mutex<HashMap<String, Arc<Vec<u8>>>> {
    IMPORTED.get_or_init(Mutex::default)
}

/// App-session-only fonts. Match full/PostScript names, never family-only aliases.
pub(crate) fn import_exact(
    path: &std::path::Path,
    expected: &[String],
) -> Result<Vec<String>, String> {
    use std::io::Read;
    if expected.is_empty() || expected.len() > 256 {
        return Err("먼저 원본 글꼴을 사용할 텍스트를 선택해 주세요.".into());
    }
    let file = std::fs::File::open(path).map_err(|_| "글꼴 파일을 읽지 못했습니다.")?;
    let mut data = Vec::new();
    file.take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "글꼴 파일을 읽지 못했습니다.")?;
    if data.len() > 32 * 1024 * 1024 {
        return Err("32 MB 이하의 글꼴 파일을 선택해 주세요.".into());
    }
    let mut matched = HashMap::new();
    let mut result = Vec::new();
    for index in 0..ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(256) {
        let aliases = names(&data, index);
        let requested: Vec<_> = expected
            .iter()
            .filter(|name| aliases.contains(&normalized(name)))
            .collect();
        if requested.is_empty() {
            continue;
        }
        let bytes = standalone(&data, index).ok_or("이 글꼴 형식은 아직 지원하지 않습니다.")?;
        validate_original(&bytes, "").map_err(|_| "편집에 사용할 수 없는 글꼴 파일입니다.")?;
        let bytes = Arc::new(bytes);
        for name in requested {
            matched.insert(normalized(name), bytes.clone());
            result.push(name.clone());
        }
    }
    if result.is_empty() {
        return Err("선택한 파일에 원본과 일치하는 글꼴 이름·굵기가 없거나 지원하지 않는 형식입니다. TrueType TTF/TTC 파일을 확인해 주세요.".into());
    }
    let mut registry = imported()
        .lock()
        .map_err(|_| "글꼴 상태를 읽지 못했습니다.")?;
    let retained: usize = registry
        .iter()
        .filter(|(key, _)| !matched.contains_key(*key))
        .map(|(_, bytes)| bytes.len())
        .sum();
    if retained + matched.values().map(|bytes| bytes.len()).sum::<usize>() > 128 * 1024 * 1024 {
        return Err("이번 실행에서 불러올 수 있는 글꼴 용량을 초과했습니다.".into());
    }
    registry.extend(matched);
    Ok(result)
}

static BUNDLED: OnceLock<PathBuf> = OnceLock::new();
pub(crate) fn register_bundled(directory: &std::path::Path) {
    if !directory.as_os_str().is_empty() {
        let _ = BUNDLED.set(directory.to_path_buf());
    }
}
pub(crate) fn available(name: &str) -> bool {
    imported()
        .lock()
        .is_ok_and(|fonts| fonts.contains_key(&normalized(name)))
        || index().contains_key(&normalized(name))
}

fn normalized(name: &str) -> String {
    let name = name
        .split_once('+')
        .filter(|(prefix, _)| prefix.len() == 6 && prefix.bytes().all(|b| b.is_ascii_uppercase()))
        .map_or(name, |(_, name)| name);
    name.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_lowercase)
        .collect()
}

fn names(data: &[u8], index: u32) -> Vec<String> {
    let Ok(face) = ttf_parser::Face::parse(data, index) else {
        return vec![];
    };
    // PDFium's TrueType loader and the browser must receive the same face.
    if face
        .raw_face()
        .table(ttf_parser::Tag::from_bytes(b"glyf"))
        .is_none()
    {
        return vec![];
    }
    face.names()
        .into_iter()
        .filter(|n| matches!(n.name_id, 4 | 6))
        .filter_map(|n| n.to_string())
        .map(|n| normalized(&n))
        .collect()
}

fn index() -> &'static HashMap<String, Vec<(PathBuf, u32)>> {
    static INDEX: OnceLock<HashMap<String, Vec<(PathBuf, u32)>>> = OnceLock::new();
    INDEX.get_or_init(|| {
        let mut result: HashMap<String, Vec<(PathBuf, u32)>> = HashMap::new();
        let mut directories = Vec::new();
        if let Some(root) = std::env::var_os("WINDIR") {
            directories.push(PathBuf::from(root).join("Fonts"));
        }
        if let Some(root) = std::env::var_os("LOCALAPPDATA") {
            directories.push(PathBuf::from(root).join("Microsoft/Windows/Fonts"));
        }
        let mut paths = Vec::new();
        if let Some(directory) = BUNDLED.get() {
            for font in crate::fonts::catalog() {
                if crate::fonts::load(directory, &font.id, "").is_ok() {
                    paths.push(directory.join(&font.file));
                }
            }
        }
        for directory in directories {
            if let Ok(entries) = std::fs::read_dir(directory) {
                paths.extend(entries.flatten().map(|e| e.path()));
            }
        }
        paths.sort();
        for path in paths {
            if !path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "ttf" | "ttc" | "otf"))
            {
                continue;
            }
            if std::fs::metadata(&path).map_or(true, |m| m.len() > 32 * 1024 * 1024) {
                continue;
            }
            let Ok(data) = std::fs::read(&path) else {
                continue;
            };
            for face in 0..ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(256) {
                for name in names(&data, face) {
                    result.entry(name).or_default().push((path.clone(), face));
                }
            }
        }
        result
    })
}

// Extract a TTC face into a standalone sfnt shared by PDFium and FontFace.
fn standalone(data: &[u8], index: u32) -> Option<Vec<u8>> {
    let face = ttf_parser::Face::parse(data, index).ok()?;
    if ttf_parser::fonts_in_collection(data).is_none() {
        return Some(data.to_vec());
    }
    let records = face.raw_face().table_records;
    let count = records.len();
    if count == 0 || count > 4095 {
        return None;
    }
    let mut out = vec![0u8; 12 + count as usize * 16];
    out[..4].copy_from_slice(&[0, 1, 0, 0]);
    out[4..6].copy_from_slice(&count.to_be_bytes());
    let power = (count as f64).log2().floor() as u16;
    let search = 16u16.checked_shl(power as u32)?;
    out[6..8].copy_from_slice(&search.to_be_bytes());
    out[8..10].copy_from_slice(&power.to_be_bytes());
    out[10..12].copy_from_slice(&(count * 16 - search).to_be_bytes());
    let mut head = None;
    for (i, record) in records.into_iter().enumerate() {
        let mut table = face.raw_face().table(record.tag)?.to_vec();
        let offset = out.len();
        if record.tag == ttf_parser::Tag::from_bytes(b"head") {
            table.get_mut(8..12)?.fill(0);
            head = Some(offset);
        }
        let checksum = sum(&table);
        let entry = 12 + i * 16;
        out[entry..entry + 4].copy_from_slice(&record.tag.to_bytes());
        out[entry + 4..entry + 8].copy_from_slice(&checksum.to_be_bytes());
        out[entry + 8..entry + 12].copy_from_slice(&(offset as u32).to_be_bytes());
        out[entry + 12..entry + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
        out.extend(table);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    let adjustment = 0xB1B0AFBAu32.wrapping_sub(sum(&out));
    let head = head?;
    out[head + 8..head + 12].copy_from_slice(&adjustment.to_be_bytes());
    Some(out)
}
fn sum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

pub(crate) fn load(name: &str, text: &str) -> Result<Vec<u8>, PreviewError> {
    let key = normalized(name);
    if let Some(bytes) = imported()
        .lock()
        .map_err(|_| PreviewError::FontUnavailable)?
        .get(&key)
        .cloned()
    {
        validate_original(&bytes, text)?;
        return Ok(bytes.as_ref().clone());
    }
    let candidates = index().get(&key).ok_or(PreviewError::FontUnavailable)?;
    let mut error = PreviewError::FontUnavailable;
    for (path, face) in candidates {
        let Ok(data) = std::fs::read(path) else {
            continue;
        };
        if data.len() > 32 * 1024 * 1024 || !names(&data, *face).contains(&key) {
            continue;
        }
        if let Some(bytes) = standalone(&data, *face) {
            match validate_original(&bytes, text) {
                Ok(()) => return Ok(bytes),
                Err(e) => error = e,
            }
        }
    }
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_exact_face_and_strips_only_pdf_subset_prefix() {
        assert_eq!(
            normalized("ABCDEF+Example-Bold"),
            normalized("Example Bold")
        );
        assert_ne!(normalized("Example-Bold"), normalized("Example-Regular"));
        assert_ne!(normalized("Example+Bold"), normalized("Bold"));
    }
    #[test]
    fn rejects_malformed_collection() {
        assert!(standalone(b"ttcf", 0).is_none());
    }

    #[test]
    #[ignore = "requires installed Windows Korean TTC fonts"]
    fn extracts_installed_collection_with_valid_checksum_and_unicode() {
        let bytes = load("Gulim", "한글 수정 ABC").unwrap();
        assert!(ttf_parser::fonts_in_collection(&bytes).is_none());
        assert_eq!(sum(&bytes), 0xB1B0AFBA);
        assert!(names(&bytes, 0).contains(&normalized("Gulim")));
        assert_eq!(
            load("PaperkitMissingFont-Bold", "a"),
            Err(PreviewError::FontUnavailable)
        );
    }
}
