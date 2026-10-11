import { VersionDialog } from "./components/VersionDialog";
import { FileInput } from "./components/FileInput";
import { PdfPreview } from "./components/PdfPreview";
import { useAppStore } from "./stores/app-store";

export function App() {
  const file = useAppStore((state) => state.file);
  const openedFileId = useAppStore((state) => state.openedFileId);
  if (file && file.id === openedFileId) return <PdfPreview key={file.id} file={file} />;
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10 sm:px-12">
      <div className="absolute right-5 top-5">
        <VersionDialog />
      </div>
      <FileInput />
    </main>
  );
}
