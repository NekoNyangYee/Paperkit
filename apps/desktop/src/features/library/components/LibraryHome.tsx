import { FileInput } from "@/features/file-input/components/FileInput";
import { DocumentLibrary } from "./DocumentLibrary";
import { ToolShelf } from "./Toolbox";
import { useAuthStore } from "@/features/auth/model/auth-store";

export function LibraryHome() {
  const owner = useAuthStore((state) => state.session?.user.id);
  return (
    <div
      className={`mx-auto w-full py-2 sm:py-5 ${owner ? "max-w-[1120px]" : "my-auto max-w-2xl"}`}
    >
      {owner ? (
        <div className="grid min-w-0 gap-8 lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-9">
          <div className="min-w-0">
            <FileInput />
            <div className="mt-8">
              <DocumentLibrary />
            </div>
          </div>
          <ToolShelf />
        </div>
      ) : (
        <FileInput />
      )}
    </div>
  );
}
