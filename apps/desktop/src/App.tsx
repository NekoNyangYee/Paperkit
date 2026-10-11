import { TitleBar } from "./components/TitleBar";
import { FileInput } from "./components/FileInput";
import { PdfPreview } from "./components/PdfPreview";
import { useAppStore } from "./stores/app-store";

export function App() {
  const file = useAppStore((state) => state.file);
  const openedFileId = useAppStore((state) => state.openedFileId);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="min-h-0 flex-1 overflow-auto">
        {file && file.id === openedFileId ? (
          <PdfPreview key={file.id} file={file} />
        ) : (
          <main className="flex min-h-full items-center justify-center px-6 py-10 sm:px-12">
            <FileInput />
          </main>
        )}
      </div>
    </div>
  );
}
