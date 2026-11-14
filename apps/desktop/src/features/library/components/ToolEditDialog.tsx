import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Input, Textarea } from "@/shared/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/shared/ui/dialog";
import { useDialogClose } from "@/shared/ui/use-dialog-close";
import { UserFacingError, userErrorMessage } from "@/shared/lib/errors";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { SignatureDialog } from "@/features/pdf-editor/components/stamps/SignatureDialog";
import { useToolStore } from "../model/tool-store";
import { readToolImage } from "../lib/tool-image";
import type { LibraryTool } from "../lib/api";

export function ToolEditDialog({
  tool,
  owner,
  onClose,
}: {
  tool: LibraryTool;
  owner: string;
  onClose: () => void;
}) {
  const { open, close } = useDialogClose(onClose);
  const [name, setName] = useState(tool.name);
  const [content, setContent] = useState(tool.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const working = useRef(false);
  const mounted = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && useAuthStore.getState().session?.user.id === owner;
  const dismiss = () => {
    if (!working.current) close();
  };
  async function perform(task: () => Promise<void>, image = false) {
    if (working.current || !current()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      if (current()) setError(userErrorMessage(cause, image ? "image" : "toolSave"));
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  }
  const isImage = tool.kind === "image" || tool.kind === "signature";
  const changed = name.trim() !== tool.name || content !== tool.content;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        className="w-[min(92vw,480px)] p-0"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4">
          <DialogTitle className="text-base font-semibold">도구 수정</DialogTitle>
          <IconButton icon={X} label="수정 창 닫기" disabled={busy} onClick={dismiss} />
        </div>
        <DialogDescription className="sr-only">저장한 도구의 이름과 내용 수정</DialogDescription>
        <form
          className="space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!changed || !name.trim() || !content.trim()) return;
            void perform(async () => {
              await useToolStore
                .getState()
                .update(tool.id, { name: name.trim(), kind: tool.kind, content }, owner);
              if (current()) close();
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <label className="block text-xs font-medium text-stone-600">
              이름
              <Input
                className="mt-2 text-sm"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {isImage ? (
              <div className="space-y-3">
                <div className="flex h-36 items-center justify-center rounded-md border border-stone-200 bg-stone-50 p-3">
                  <img
                    src={content}
                    alt="수정할 도구 미리보기"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                {tool.kind === "signature" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setDrawing(true)}
                  >
                    서명 다시 그리기
                  </Button>
                ) : (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/bmp"
                      aria-label="바꿀 이미지"
                      className="sr-only"
                      tabIndex={-1}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        event.target.value = "";
                        if (file)
                          void perform(async () => {
                            const next = await readToolImage(file);
                            if (current()) setContent(next);
                          }, true);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInput.current?.click()}
                    >
                      이미지 바꾸기
                    </Button>
                  </>
                )}
              </div>
            ) : (
              <label className="block text-xs font-medium text-stone-600">
                {tool.kind === "watermark" ? "워터마크 문구" : "내용"}
                <Textarea
                  className="mt-2 resize-y text-sm"
                  required
                  rows={4}
                  maxLength={4000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <p role="alert" className="text-xs leading-5 text-stone-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={dismiss}>
              취소
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={busy || !changed || !name.trim() || !content.trim()}
              className="bg-emerald-900 text-white hover:bg-emerald-800"
            >
              {busy ? "저장 중…" : "저장"}
            </Button>
          </div>
        </form>
        {drawing && (
          <SignatureDialog
            purpose="tool"
            onClose={() => setDrawing(false)}
            onApply={async (png) => {
              if (!current()) return false;
              if (png.length > 1_048_576)
                throw new UserFacingError("서명을 조금 간단하게 그린 뒤 다시 선택해 주세요.");
              setContent(
                `data:image/png;base64,${btoa(png.map((byte) => String.fromCharCode(byte)).join(""))}`,
              );
              return true;
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
