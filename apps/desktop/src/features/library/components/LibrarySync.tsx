import { useEffect } from "react";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { useFileStore } from "@/features/file-input/model/file-store";
import { rememberDocument } from "../model/remember-document";

// Register metadata only. Opening a local document never uploads its PDF bytes.
export function LibrarySync() {
  const owner = useAuthStore((s) => s.session?.user.id);
  const accessToken = useAuthStore((s) => s.session?.access_token);
  const file = useFileStore((s) => s.file);
  const opened = useFileStore((s) => s.openedFileId);
  const scopeOwner = useFileStore((s) => s.scopeOwner);
  const ready = useFileStore((s) => s.ready);
  useEffect(() => {
    if (!owner || owner !== scopeOwner || !ready || !file || file.id !== opened) return;
    void rememberDocument(owner, file);
  }, [owner, accessToken, file, opened, scopeOwner, ready]);
  return null;
}
