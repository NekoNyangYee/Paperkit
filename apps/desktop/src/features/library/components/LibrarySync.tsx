import { useEffect } from "react";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { useFileStore } from "@/features/file-input/model/file-store";
import { libraryRequest } from "../lib/api";
import { useDocumentStatus } from "../model/document-status";
import { userErrorMessage } from "@/shared/lib/errors";

// Register metadata only. Opening a local document never uploads its PDF bytes.
export function LibrarySync() {
  const owner = useAuthStore((s) => s.session?.user.id);
  const accessToken = useAuthStore((s) => s.session?.access_token);
  const file = useFileStore((s) => s.file);
  const opened = useFileStore((s) => s.openedFileId);
  useEffect(() => {
    if (!owner || !file || file.id !== opened) return;
    const controller = new AbortController();
    void libraryRequest(
      "/library/documents",
      {
        method: "POST",
        body: JSON.stringify({
          sourcePath: file.path,
          displayName: file.name,
          sizeBytes: file.sizeBytes,
        }),
        signal: controller.signal,
      },
      owner,
    )
      .then(() => {
        if (!controller.signal.aborted && useAuthStore.getState().session?.user.id === owner)
          useDocumentStatus.setState((state) => ({
            owner,
            error: null,
            revision: state.revision + 1,
          }));
      })
      .catch((cause: unknown) => {
        // A failed metadata registration must not interrupt local editing.
        if (!controller.signal.aborted && useAuthStore.getState().session?.user.id === owner)
          useDocumentStatus.setState({
            owner,
            error: userErrorMessage(cause, "library"),
          });
      });
    return () => controller.abort();
  }, [owner, accessToken, file, opened]);
  return null;
}
