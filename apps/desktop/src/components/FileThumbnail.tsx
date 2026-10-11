import { useEffect, useState } from "react";
import { LoaderCircle, RotateCcw, X, ZoomIn } from "lucide-react";
import { errorMessage } from "../lib/desktop";
import { renderPage, releasePreview } from "../lib/preview";
import { useAppStore } from "../stores/app-store";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogTrigger,
} from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { MessageDialog } from "./MessageDialog";

export function FileThumbnail({ fileId }: { fileId: string }) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setImage(null);
    setError(null);
    void renderPage(fileId, 0, 1600)
      .then(async (page) => {
        if (typeof Image.prototype.decode === "function") {
          const bitmap = new Image();
          bitmap.src = page.imageUrl;
          await bitmap.decode();
        }
        if (active) setImage({ url: page.imageUrl, width: page.width, height: page.height });
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
    };
  }, [fileId, retry]);
  useEffect(
    () => () => {
      if (useAppStore.getState().openedFileId !== fileId)
        void releasePreview(fileId).catch(() => {});
    },
    [fileId],
  );
  return (
    <div className="w-28 shrink-0 text-center sm:w-32">
      <div className="flex h-40 items-center justify-center overflow-hidden rounded-lg border border-stone-200 bg-white p-2 shadow-sm sm:h-44">
        {image ? (
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                aria-label="미리보기 확대"
                title="미리보기 확대"
                className="group relative flex h-full w-full items-center justify-center rounded focus-visible:outline-emerald-700"
              >
                <img
                  src={image.url}
                  alt="선택한 PDF의 첫 페이지"
                  className="max-h-full max-w-full object-contain"
                />
                <span className="absolute inset-0 grid place-items-center rounded bg-black/20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <ZoomIn size={30} className="text-white" aria-hidden="true" />
                </span>
              </button>
            </DialogTrigger>
            <DialogContent className="flex h-[90dvh] w-[min(92vw,1100px)] flex-col bg-stone-100">
              <div className="mb-2 flex items-center justify-between gap-4">
                <DialogTitle className="text-sm font-medium">PDF 미리보기</DialogTitle>
                <DialogClose asChild>
                  <IconButton icon={X} label="미리보기 닫기" />
                </DialogClose>
              </div>
              <DialogDescription className="sr-only">
                선택한 PDF의 첫 페이지 확대 미리보기
              </DialogDescription>
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <img
                  src={image.url}
                  width={image.width}
                  height={image.height}
                  alt="선택한 PDF 확대 미리보기"
                  className="h-full w-full object-contain"
                />
              </div>
            </DialogContent>
          </Dialog>
        ) : error ? (
          <IconButton
            label="미리보기 다시 시도"
            icon={RotateCcw}
            onClick={() => setRetry((n) => n + 1)}
          />
        ) : (
          <span role="status" aria-label="미리보기 준비 중">
            <LoaderCircle
              className="animate-spin motion-reduce:animate-none text-stone-400"
              aria-hidden="true"
            />
          </span>
        )}
      </div>
      <MessageDialog title="미리보기 오류" message={error} onRetry={() => setRetry((n) => n + 1)} />
    </div>
  );
}
