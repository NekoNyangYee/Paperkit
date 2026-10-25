import { TitleBar } from "@/app/layout/TitleBar";
import { FileInput } from "@/features/file-input/components/FileInput";
import { PdfPreview } from "@/features/pdf-editor/components/preview/PdfPreview";
import { useFileStore } from "@/features/file-input/model/file-store";
import { useEffect, useState } from "react";

export function App() {
  const file = useFileStore((state) => state.file);
  const openedFileId = useFileStore((state) => state.openedFileId);
  const tabs = useFileStore((state) => state.tabs);
  const activeTabId = useFileStore((state) => state.activeTabId);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (openedFileId) setVisited((previous) => new Set(previous).add(activeTabId));
  }, [activeTabId, openedFileId]);
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <TitleBar />
      <div className="min-h-0 flex-1 overflow-auto">
        {tabs.map(
          (tab) =>
            tab.file &&
            (tab.id === activeTabId || visited.has(tab.id)) && (
              <div
                key={tab.id}
                role="tabpanel"
                id={`panel-${tab.id}`}
                aria-labelledby={`tab-${tab.id}`}
                hidden={tab.id !== activeTabId}
                className="h-full"
              >
                <PdfPreview file={tab.file} active={tab.id === activeTabId} />
              </div>
            ),
        )}
        {!(file && file.id === openedFileId) && (
          <main
            role="tabpanel"
            id={`panel-${activeTabId}`}
            aria-labelledby={`tab-${activeTabId}`}
            className="flex min-h-full items-center justify-center px-6 py-10 sm:px-12"
          >
            <FileInput />
          </main>
        )}
      </div>
    </div>
  );
}
