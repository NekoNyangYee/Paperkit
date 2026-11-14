import { useEffect, useRef, useState } from "react";
import { X, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Textarea } from "@/shared/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { readPage, type ReadPageResult } from "../../lib/ensemble/read-page";
import { userErrorMessage } from "@/shared/lib/errors";
import { useDialogClose } from "@/shared/ui/use-dialog-close";

export function PageTextDialog({
  fileId,
  revision,
  pageIndex,
  onClose,
}: {
  fileId: string;
  revision: number;
  pageIndex: number;
  onClose: () => void;
}) {
  const { open, close: finishClose } = useDialogClose(onClose);
  const close = () => {
    request.current?.abort();
    finishClose();
  };
  const [result, setResult] = useState<ReadPageResult | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const request = useRef<AbortController | null>(null);
  async function load(forceOcr = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setProgress(0);
    setError(null);
    setCopied(false);
    try {
      const next = await readPage({
        fileId,
        revision,
        pageIndex,
        forceOcr,
        signal: controller.signal,
        onProgress: setProgress,
      });
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(userErrorMessage(cause, "extract"));
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  useEffect(() => {
    setResult(null);
    void load();
    return () => request.current?.abort();
  }, [fileId, revision, pageIndex]);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex max-h-[85dvh] w-[min(94vw,760px)] flex-col gap-4 p-6">
        <div className="flex items-center justify-between">
          <DialogTitle className="text-lg font-semibold">페이지 글자 · {pageIndex + 1}</DialogTitle>
          <IconButton icon={X} label="글자 추출 창 닫기" onClick={close} />
        </div>
        <DialogDescription className="sr-only">
          현재 페이지에서 읽은 글자를 확인하고 복사합니다.
        </DialogDescription>
        {pending && (
          <p role="status" className="text-sm text-stone-500">
            글자를 읽는 중…{progress > 0 ? ` ${progress}%` : ""}
          </p>
        )}
        {result && (
          <>
            {result.source === "tesseract" && (
              <p className="text-xs text-stone-500">
                이미지에서 읽은 글자입니다. 사용 전에 내용을 확인해 주세요.
              </p>
            )}
            <Textarea
              aria-label="추출한 글자"
              readOnly
              value={result.text}
              rows={13}
              className="min-h-0 resize-none overflow-auto text-sm"
            />
            {!result.text && (
              <p className="text-sm text-stone-500">
                이 페이지에서 읽을 수 있는 글자를 찾지 못했어요.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-stone-600">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {error && (
            <Button variant="outline" disabled={pending} onClick={() => void load()}>
              다시 시도
            </Button>
          )}
          <Button variant="ghost" disabled={pending} onClick={() => void load(true)}>
            <RefreshCw size={14} />
            이미지에서 다시 읽기
          </Button>
          <Button
            disabled={pending || !result?.text}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(result!.text);
                setCopied(true);
              } catch {
                setError("글자를 복사하지 못했어요. 다시 눌러 주세요.");
              }
            }}
          >
            <Copy size={14} />
            {copied ? "복사됨" : "복사"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
