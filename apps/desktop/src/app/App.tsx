import { TitleBar } from "@/app/layout/TitleBar";
import { FileInput } from "@/features/file-input/components/FileInput";
import { PdfPreview } from "@/features/pdf-editor/components/preview/PdfPreview";
import { useFileStore } from "@/features/file-input/model/file-store";

export function App() {
  const file = useFileStore((state) => state.file);
  const openedFileId = useFileStore((state) => state.openedFileId);
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
