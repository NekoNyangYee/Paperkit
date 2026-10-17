use crate::error::EngineError as PreviewError;
use pdfium_render::prelude::*;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn save_new(
    pdfium: &Pdfium,
    document: &PdfDocument<'_>,
    bytes: &[u8],
    target: &Path,
) -> Result<(), PreviewError> {
    // Never overwrite any existing path, including the source and links to it.
    if !target.is_absolute()
        || target
            .extension()
            .is_none_or(|ext| !ext.eq_ignore_ascii_case("pdf"))
    {
        return Err(PreviewError::SaveFailed);
    }
    if fs::symlink_metadata(target).is_ok() {
        return Err(PreviewError::TargetExists);
    }
    let parent = target.parent().ok_or(PreviewError::SaveFailed)?;
    let temp = parent.join(format!(
        ".paperkit-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| PreviewError::SaveFailed)?;
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(temp.clone());
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| PreviewError::SaveFailed)?;
    drop(file);
    let written = fs::read(&temp).map_err(|_| PreviewError::SaveFailed)?;
    if written != bytes {
        return Err(PreviewError::VerificationFailed);
    }
    let reopened = pdfium
        .load_pdf_from_byte_vec(written, None)
        .map_err(|_| PreviewError::VerificationFailed)?;
    if reopened.pages().len() != document.pages().len() {
        return Err(PreviewError::VerificationFailed);
    }
    let config = PdfRenderConfig::new()
        .set_target_width(300)
        .set_maximum_height(2200);
    for index in 0..document.pages().len() {
        let before = document
            .pages()
            .get(index)
            .map_err(|_| PreviewError::VerificationFailed)?;
        let after = reopened
            .pages()
            .get(index)
            .map_err(|_| PreviewError::VerificationFailed)?;
        if before
            .text()
            .map_err(|_| PreviewError::VerificationFailed)?
            .all()
            != after
                .text()
                .map_err(|_| PreviewError::VerificationFailed)?
                .all()
            || before
                .render_with_config(&config)
                .map_err(|_| PreviewError::VerificationFailed)?
                .as_rgba_bytes()
                != after
                    .render_with_config(&config)
                    .map_err(|_| PreviewError::VerificationFailed)?
                    .as_rgba_bytes()
        {
            return Err(PreviewError::VerificationFailed);
        }
    }
    // Atomic no-clobber publication on the same volume. Unsupported filesystems fail safely.
    fs::hard_link(&temp, target).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            PreviewError::TargetExists
        } else {
            PreviewError::SaveFailed
        }
    })?;
    Ok(())
}
