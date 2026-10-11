use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

/// Basic file inspection only, not proof that PDFium can parse the document.
#[derive(Debug, Clone)]
pub struct PdfFileInfo {
    pub path: PathBuf,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileCheckError {
    NotFound,
    PermissionDenied,
    NotAFile,
    EmptyFile,
    NotPdfExtension,
    InvalidHeader,
    ReadFailed,
}

impl From<io::Error> for FileCheckError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::NotFound => Self::NotFound,
            io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            _ => Self::ReadFailed,
        }
    }
}

pub fn inspect_pdf_file(path: &Path) -> Result<PdfFileInfo, FileCheckError> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(FileCheckError::NotAFile);
    }
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
    {
        return Err(FileCheckError::NotPdfExtension);
    }
    // Opening for read verifies actual access, unlike checking readonly flags.
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(FileCheckError::NotAFile);
    }
    if metadata.len() == 0 {
        return Err(FileCheckError::EmptyFile);
    }
    // Conservative MVP: header at offset zero, PDF 1.0..1.7 or 2.0, then EOL.
    // Read only nine bytes, not the entire document.
    let mut header = [0; 9];
    file.read_exact(&mut header).map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            FileCheckError::InvalidHeader
        } else {
            error.into()
        }
    })?;
    let supported = (header[5] == b'1' && (b'0'..=b'7').contains(&header[7]))
        || (header[5] == b'2' && header[7] == b'0');
    if &header[..5] != b"%PDF-"
        || header[6] != b'.'
        || !supported
        || !matches!(header[8], b'\r' | b'\n')
    {
        return Err(FileCheckError::InvalidHeader);
    }
    Ok(PdfFileInfo {
        path: path.to_path_buf(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        size_bytes: metadata.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT_ID: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "paperkit-file-check-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn accepts_unicode_uppercase_extension_and_preserves_original_bytes() {
        let fixture = Fixture::new();
        let bytes = b"%PDF-1.7\r\nexample body (not a complete PDF)";
        let path = fixture.write("한글 문서.PDF", bytes);
        let info = inspect_pdf_file(&path).unwrap();
        assert_eq!(info.name, "한글 문서.PDF");
        assert_eq!(info.path, path);
        assert_eq!(info.size_bytes, bytes.len() as u64);
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn accepts_pdf_2_header() {
        let fixture = Fixture::new();
        assert!(inspect_pdf_file(&fixture.write("v2.pdf", b"%PDF-2.0\n")).is_ok());
    }
    #[test]
    fn rejects_missing_directory_empty_and_wrong_extension() {
        let fixture = Fixture::new();
        assert_eq!(
            inspect_pdf_file(&fixture.0.join("missing.pdf")).unwrap_err(),
            FileCheckError::NotFound
        );
        assert_eq!(
            inspect_pdf_file(&fixture.0).unwrap_err(),
            FileCheckError::NotAFile
        );
        assert_eq!(
            inspect_pdf_file(&fixture.write("empty.pdf", b"")).unwrap_err(),
            FileCheckError::EmptyFile
        );
        assert_eq!(
            inspect_pdf_file(&fixture.write("wrong.txt", b"%PDF-1.7\n")).unwrap_err(),
            FileCheckError::NotPdfExtension
        );
    }
    #[test]
    fn rejects_renamed_text_truncated_or_malformed_headers() {
        let fixture = Fixture::new();
        for bytes in [
            b"plain text".as_slice(),
            b"%PDF-",
            b"%PDF-x.y\n",
            b"%PDF-1.7x",
            b" %PDF-1.7\n",
        ] {
            assert_eq!(
                inspect_pdf_file(&fixture.write("fake.pdf", bytes)).unwrap_err(),
                FileCheckError::InvalidHeader
            );
        }
    }
    #[test]
    fn maps_permission_errors() {
        assert_eq!(
            FileCheckError::from(io::Error::from(io::ErrorKind::PermissionDenied)),
            FileCheckError::PermissionDenied
        );
    }
    #[cfg(windows)]
    #[test]
    fn rejects_file_locked_against_reading() {
        use std::os::windows::fs::OpenOptionsExt;
        let fixture = Fixture::new();
        let path = fixture.write("locked.pdf", b"%PDF-1.7\n");
        let _lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(matches!(
            inspect_pdf_file(&path),
            Err(FileCheckError::PermissionDenied | FileCheckError::ReadFailed)
        ));
    }
}
