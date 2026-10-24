use crate::document::PdfFileInfo;

#[derive(Debug, Clone)]
pub struct SelectedFile {
    pub id: String,
    pub info: PdfFileInfo,
}

/// Owns selection metadata, not yet a parsed PDFium document.
#[derive(Default)]
pub struct Selection {
    revision: u64,
    file: Option<SelectedFile>,
}

impl Selection {
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn file(&self) -> Option<&SelectedFile> {
        self.file.as_ref()
    }

    /// A frontend reload invalidates work from the previous frontend instance.
    pub fn synchronize(&mut self) {
        self.revision += 1;
    }

    pub fn begin(&mut self, revision: u64) -> bool {
        if revision <= self.revision {
            return false;
        }
        self.revision = revision;
        true
    }

    pub fn commit(&mut self, revision: u64, info: PdfFileInfo) -> bool {
        if revision != self.revision {
            return false;
        }
        self.file = Some(SelectedFile {
            id: format!("file-{revision}"),
            info,
        });
        true
    }

    pub fn clear(&mut self, revision: u64) -> bool {
        if !self.begin(revision) {
            return false;
        }
        self.file = None;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn info(name: &str) -> PdfFileInfo {
        PdfFileInfo {
            path: name.into(),
            name: name.into(),
            size_bytes: 12,
        }
    }
    #[test]
    fn newest_request_wins_even_when_results_arrive_in_reverse_order() {
        let mut selection = Selection::default();
        assert!(selection.begin(1));
        assert!(selection.begin(2));
        assert!(selection.commit(2, info("b.pdf")));
        assert!(!selection.commit(1, info("a.pdf")));
        assert_eq!(selection.file().unwrap().info.name, "b.pdf");
        assert!(!selection.begin(1));
    }
    #[test]
    fn failed_request_keeps_previous_selection_and_blocks_older_work() {
        let mut selection = Selection::default();
        selection.begin(1);
        selection.commit(1, info("original.pdf"));
        selection.begin(2);
        selection.begin(3); // validation fails; no commit
        assert!(!selection.commit(2, info("late.pdf")));
        assert_eq!(selection.file().unwrap().id, "file-1");
    }
    #[test]
    fn clear_invalidates_inflight_work_and_reselection_gets_new_id() {
        let mut selection = Selection::default();
        selection.begin(1);
        selection.clear(2);
        assert!(!selection.commit(1, info("old.pdf")));
        assert!(selection.file().is_none());
        selection.begin(3);
        selection.commit(3, info("new.pdf"));
        assert_eq!(selection.file().unwrap().id, "file-3");
    }
    #[test]
    fn reload_preserves_file_but_invalidates_pending_validation() {
        let mut selection = Selection::default();
        selection.begin(1);
        selection.commit(1, info("original.pdf"));
        selection.begin(2);
        selection.synchronize();
        assert!(!selection.commit(2, info("late.pdf")));
        assert_eq!(selection.file().unwrap().info.name, "original.pdf");
        assert_eq!(selection.revision(), 3);
    }
}
