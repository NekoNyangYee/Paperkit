//! Role-based coordination. Engines exchange bytes, never native handles or object IDs.
//! qpdf only repairs unopened documents; it never rewrites an active edit selection.
use super::error::EngineError;
use pdfium_render::prelude::*;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_PDF: u64 = 128 * 1024 * 1024;
const MAX_LOG: u64 = 1024 * 1024;

pub(crate) struct Ensemble {
    qpdf: PathBuf,
}

impl Ensemble {
    pub fn new(resources: &Path) -> Self {
        Self {
            qpdf: resources
                .join("qpdf/bin")
                .join(if cfg!(windows) { "qpdf.exe" } else { "qpdf" }),
        }
    }

    pub fn available(&self) -> bool {
        self.qpdf.is_file()
    }

    /// Cross-check a native editing candidate without changing a single byte.
    /// Missing optional tools preserve the original PDFium/lopdf route.
    pub fn validate(&self, bytes: &[u8]) -> Result<(), EngineError> {
        if !self.available() {
            return Ok(());
        }
        let workspace = tempfile::tempdir().map_err(|_| EngineError::VerificationFailed)?;
        fs::write(workspace.path().join("input.pdf"), bytes)
            .map_err(|_| EngineError::VerificationFailed)?;
        if self.run(workspace.path(), &["--check", "input.pdf"])? != 0 {
            return Err(EngineError::VerificationFailed);
        }
        Ok(())
    }

    pub fn open<'a>(
        &self,
        pdfium: &'a Pdfium,
        bytes: Vec<u8>,
    ) -> Result<(PdfDocument<'a>, bool), EngineError> {
        match pdfium.load_pdf_from_byte_vec(bytes.clone(), None) {
            Ok(document) if !document.pages().is_empty() => Ok((document, false)),
            Err(PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)) => {
                Err(EngineError::PasswordRequired)
            }
            _ => {
                let recovered = self.repair(&bytes)?;
                let parsed = lopdf::Document::load_mem(&recovered)
                    .map_err(|_| EngineError::InvalidDocument)?;
                let expected = parsed.get_pages().len();
                let document = pdfium
                    .load_pdf_from_byte_vec(recovered, None)
                    .map_err(|_| EngineError::InvalidDocument)?;
                if expected == 0 || document.pages().len() as usize != expected {
                    return Err(EngineError::InvalidDocument);
                }
                // Force a real page load before admitting the recovered session.
                document
                    .pages()
                    .get(0)
                    .map_err(|_| EngineError::InvalidDocument)?;
                Ok((document, true))
            }
        }
    }

    pub(crate) fn repair(&self, bytes: &[u8]) -> Result<Vec<u8>, EngineError> {
        if !self.available() || bytes.len() as u64 > MAX_PDF || protected(bytes) {
            return Err(EngineError::InvalidDocument);
        }
        let workspace = tempfile::tempdir().map_err(|_| EngineError::InvalidDocument)?;
        fs::write(workspace.path().join("input.pdf"), bytes)
            .map_err(|_| EngineError::InvalidDocument)?;
        // qpdf's query returns 0 for encrypted files and 2 for unencrypted files.
        // No passwords, decryption, permission overrides or signature rewrites.
        if self.run(workspace.path(), &["--is-encrypted", "input.pdf"])? != 2 {
            return Err(EngineError::PasswordRequired);
        }
        let status = self.run(
            workspace.path(),
            &[
                "--stream-data=preserve",
                "--object-streams=preserve",
                "input.pdf",
                "output.pdf",
            ],
        )?;
        if ![0, 3].contains(&status) || self.run(workspace.path(), &["--check", "output.pdf"])? != 0
        {
            return Err(EngineError::InvalidDocument);
        }
        let path = workspace.path().join("output.pdf");
        if fs::metadata(&path)
            .map_err(|_| EngineError::InvalidDocument)?
            .len()
            > MAX_PDF
        {
            return Err(EngineError::TooLarge);
        }
        let result = fs::read(path).map_err(|_| EngineError::InvalidDocument)?;
        if protected(&result) {
            return Err(EngineError::InvalidDocument);
        }
        Ok(result)
    }

    fn run(&self, directory: &Path, args: &[&str]) -> Result<i32, EngineError> {
        let stdout = directory.join("stdout.log");
        let stderr = directory.join("stderr.log");
        let mut command = Command::new(&self.qpdf);
        command
            .args(args)
            .current_dir(directory)
            .stdin(Stdio::null())
            .stdout(fs::File::create(&stdout).map_err(|_| EngineError::VerificationFailed)?)
            .stderr(fs::File::create(&stderr).map_err(|_| EngineError::VerificationFailed)?);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command
            .spawn()
            .map_err(|_| EngineError::VerificationFailed)?;
        let started = Instant::now();
        let result = loop {
            let oversized = [
                (&stdout, MAX_LOG),
                (&stderr, MAX_LOG),
                (&directory.join("output.pdf"), MAX_PDF),
            ]
            .iter()
            .any(|(path, max)| fs::metadata(path).is_ok_and(|m| m.len() > *max));
            if oversized || started.elapsed() > Duration::from_secs(15) {
                break Err(EngineError::VerificationFailed);
            }
            match child.try_wait() {
                Ok(Some(status)) => break status.code().ok_or(EngineError::VerificationFailed),
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => break Err(EngineError::VerificationFailed),
            }
        };
        if result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        result
    }
}

// Conservatively decline repair if a damaged parser cannot establish permissions.
// False positives here preserve the source instead of risking signed/encrypted data.
fn protected(bytes: &[u8]) -> bool {
    let lexical = [b"/Encrypt".as_slice(), b"/ByteRange", b"/DocMDP"]
        .iter()
        .any(|token| bytes.windows(token.len()).any(|w| w == *token));
    lexical
        || lopdf::Document::load_mem(bytes).is_ok_and(|document| {
            document.is_encrypted()
                || document.objects.values().any(|object| {
                    object.as_dict().is_ok_and(|dict| {
                        dict.get(b"Type")
                            .and_then(lopdf::Object::as_name)
                            .is_ok_and(|name| name == b"Sig")
                            || dict
                                .get(b"FT")
                                .and_then(lopdf::Object::as_name)
                                .is_ok_and(|name| name == b"Sig")
                    })
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn never_repairs_encryption_or_signature_markers() {
        for token in ["/Encrypt", "/ByteRange", "/DocMDP"] {
            assert!(protected(token.as_bytes()));
        }
        assert!(!protected(b"%PDF-1.7\nplain invalid data"));
    }
    #[test]
    fn absent_optional_tool_keeps_native_validation_available() {
        let tools = Ensemble::new(Path::new("not-an-installed-resource-directory"));
        assert!(!tools.available());
        assert!(tools.validate(b"native candidate").is_ok());
        assert_eq!(tools.repair(b"invalid"), Err(EngineError::InvalidDocument));
    }

    #[test]
    #[ignore = "requires bundled qpdf"]
    fn qpdf_repairs_broken_xref_rejects_invalid_candidates_and_never_rewrites_protected_input() {
        use lopdf::{dictionary, Object, Stream};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src-tauri/resources");
        let ensemble = Ensemble::new(&root);
        assert!(ensemble.available());
        let mut doc = lopdf::Document::with_version("1.7");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(),0.into(),600.into(),800.into()], "Contents" => content, "Resources" => dictionary! {} });
        doc.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 }));
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        ensemble.validate(&bytes).unwrap();
        let marker = bytes
            .windows(b"startxref\n".len())
            .rposition(|w| w == b"startxref\n")
            .unwrap();
        bytes.truncate(marker);
        bytes.extend_from_slice(b"startxref\n1\n%%EOF\n");
        let original = bytes.clone();
        assert!(
            ensemble.validate(&bytes).is_err(),
            "damaged xref is not a valid edit candidate"
        );
        let repaired = ensemble.repair(&bytes).unwrap();
        ensemble.validate(&repaired).unwrap();
        assert_eq!(
            lopdf::Document::load_mem(&repaired)
                .unwrap()
                .get_pages()
                .len(),
            1
        );
        assert_eq!(bytes, original);
        assert!(ensemble.validate(b"not a PDF").is_err());
        for name in ["password.pdf", "restricted.pdf"] {
            let protected = fs::read(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/fixtures")
                    .join(name),
            )
            .unwrap();
            assert!(ensemble.repair(&protected).is_err());
        }
    }
}
