import type { FileInfo } from "@/shared/desktop/files";
import {
  captureAccount,
  accountIsCurrent,
  onAccountChange,
} from "@/features/auth/lib/account-scope";
import { libraryRequest } from "../lib/api";
import { useDocumentStatus } from "./document-status";
import { userErrorMessage } from "@/shared/lib/errors";

// One successful registration per actual file-open, shared by StrictMode mounts,
// tab activation and token rotations. Never persist guest metadata.
const openings = new Map<string, Promise<void>>();
const unsubscribe = onAccountChange(() => openings.clear());
import.meta.hot?.dispose(() => {
  unsubscribe();
  openings.clear();
});
export function rememberDocument(owner: string, file: FileInfo): Promise<void> {
  const scope = captureAccount(owner);
  const key = JSON.stringify([scope.generation, owner, file.id, file.path, file.sizeBytes]);
  const previous = openings.get(key);
  if (previous) return previous;
  const pending = libraryRequest(
    "/library/documents",
    {
      method: "POST",
      body: JSON.stringify({
        sourcePath: file.path,
        displayName: file.name,
        sizeBytes: file.sizeBytes,
      }),
    },
    owner,
  )
    .then(() => {
      if (accountIsCurrent(scope))
        useDocumentStatus.setState((state) => ({
          owner,
          error: null,
          revision: state.revision + 1,
        }));
    })
    .catch((cause) => {
      if (openings.get(key) === pending) openings.delete(key);
      if (accountIsCurrent(scope))
        useDocumentStatus.setState({ owner, error: userErrorMessage(cause, "library") });
    });
  openings.set(key, pending);
  if (openings.size > 256) openings.delete(openings.keys().next().value!);
  return pending;
}
