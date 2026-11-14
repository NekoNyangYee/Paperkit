import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ImagePlus, Plus, Stamp, Trash2, Type, X, Check, Pencil } from "lucide-react";
import { SignatureDialog } from "@/features/pdf-editor/components/stamps/SignatureDialog";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { Button } from "@/shared/ui/button";
import { IconButton } from "@/shared/ui/icon-button";
import { Input, Textarea } from "@/shared/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { useConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useDialogClose } from "@/shared/ui/use-dialog-close";
import { useToolStore } from "../model/tool-store";
import type { LibraryTool, ToolKind } from "../lib/api";
import { LibrarySignIn } from "./LibrarySignIn";
import { UserFacingError, userErrorMessage, type ErrorContext } from "@/shared/lib/errors";
import { readToolImage } from "../lib/tool-image";
import { ToolEditDialog } from "./ToolEditDialog";

const labels: Record<ToolKind, string> = {
  image: "이미지",
  text: "문구",
  watermark: "워터마크",
  signature: "전자서명",
};
const kinds = ["image", "text", "watermark", "signature"] as const;
function ToolPreview({ tool, small = false }: { tool: LibraryTool; small?: boolean }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded border border-stone-200 bg-stone-50 ${small ? "size-10" : "h-24 w-full"}`}
    >
      {tool.kind === "image" || tool.kind === "signature" ? (
        <img src={tool.content} alt="" className="max-h-full max-w-full object-contain p-2" />
      ) : tool.kind === "watermark" ? (
        small ? (
          <Stamp size={17} strokeWidth={1.5} className="text-stone-400" />
        ) : (
          <span className="max-w-full truncate px-3 text-sm font-semibold tracking-wider text-stone-400">
            {tool.content}
          </span>
        )
      ) : small ? (
        <Type size={18} strokeWidth={1.5} className="text-stone-400" />
      ) : (
        <p className="line-clamp-3 w-full whitespace-pre-wrap px-3 text-xs leading-5 text-stone-600">
          {tool.content}
        </p>
      )}
    </div>
  );
}
function useTools() {
  const owner = useAuthStore((s) => s.session?.user.id);
  const accessToken = useAuthStore((s) => s.session?.access_token);
  const state = useToolStore();
  useEffect(() => {
    const current = useToolStore.getState();
    if (owner && (current.owner !== owner || current.error)) void current.load(owner);
  }, [owner, accessToken]);
  return { ...state, tools: state.owner === owner ? state.tools : [], owner };
}

export function ToolShelf() {
  const { tools, owner, error, loading, load } = useTools();
  const [open, setOpen] = useState<"list" | "create" | null>(null);
  if (!owner) return null;
  return (
    <aside
      aria-labelledby="toolbox-title"
      className="min-w-0 border-t border-stone-300/80 pt-6 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="toolbox-title" className="text-base font-semibold">
          내 도구함
        </h2>
        {owner && <IconButton icon={Plus} label="도구 추가" onClick={() => setOpen("create")} />}
      </div>
      {!owner ? (
        <LibrarySignIn />
      ) : (
        <>
          {loading && (
            <p role="status" className="py-7 text-xs text-stone-500">
              도구함을 불러오는 중…
            </p>
          )}
          {error && (
            <div role="alert" className="mt-4 text-xs leading-5 text-stone-600">
              {error}
              <Button variant="ghost" size="sm" onClick={() => void load(owner)}>
                다시 시도
              </Button>
            </div>
          )}
          {!loading && !error && !tools.length && (
            <p className="py-6 text-xs text-stone-400">도구 없음</p>
          )}
          <div className="mt-5 space-y-3">
            {tools.slice(0, 4).map((tool) => (
              <button
                key={tool.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-md text-left hover:bg-stone-200/40 focus-visible:outline-emerald-700"
                onClick={() => setOpen("list")}
              >
                <ToolPreview tool={tool} small />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{tool.name}</span>
                  <span className="mt-1 block text-[11px] text-stone-400">{labels[tool.kind]}</span>
                </span>
              </button>
            ))}
          </div>
          {tools.length > 4 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-5 w-full justify-between border border-stone-300 bg-transparent text-xs text-stone-600"
              onClick={() => setOpen("list")}
            >
              모두 보기 · {tools.length}
              <ArrowUpRight size={14} />
            </Button>
          )}
        </>
      )}
      {open && <ToolboxDialog initialAdding={open === "create"} onClose={() => setOpen(null)} />}
    </aside>
  );
}

export function ToolboxDialog({
  onClose,
  onUse,
  initialAdding = false,
}: {
  onClose: () => void;
  onUse?: (tool: LibraryTool) => Promise<boolean>;
  initialAdding?: boolean;
}) {
  const { owner } = useTools();
  if (!owner) return null;
  return (
    <ToolboxContent
      key={owner ?? "guest"}
      owner={owner}
      onClose={onClose}
      onUse={onUse}
      initialAdding={initialAdding}
    />
  );
}
function ToolboxContent({
  owner,
  onClose,
  onUse,
  initialAdding,
}: {
  owner?: string;
  onClose: () => void;
  onUse?: (tool: LibraryTool) => Promise<boolean>;
  initialAdding: boolean;
}) {
  const closing = useDialogClose(onClose);
  const { tools, loading, error: loadError, load, add, remove } = useTools();
  const [adding, setAdding] = useState(initialAdding);
  const [editing, setEditing] = useState<LibraryTool | null>(null);
  const [kind, setKind] = useState<ToolKind>("image");
  const [filter, setFilter] = useState<ToolKind | "all">("all");
  const [drawingSignature, setDrawingSignature] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const imageRequest = useRef(0);
  const mounted = useRef(true);
  const [copied, setCopied] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const removeDialog = useConfirmDialog({
    title: "도구 삭제",
    description: "저장된 도구를 삭제할까요? 이미 PDF에 넣은 내용은 유지됩니다.",
    confirmLabel: "삭제",
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      imageRequest.current++;
    };
  }, []);
  const current = () => mounted.current && useAuthStore.getState().session?.user.id === owner;
  const filteredTools = tools.filter((tool) => filter === "all" || tool.kind === filter);
  const useTool = (tool: LibraryTool) => {
    void perform(
      async () => {
        if (onUse) {
          if (await onUse(tool)) closing.close();
        } else {
          await navigator.clipboard.writeText(tool.content);
          if (current()) setCopied(tool.id);
        }
      },
      tool.kind === "text" || (!onUse && tool.kind === "watermark")
        ? "clipboard"
        : tool.kind === "signature"
          ? "signature"
          : "edit",
    );
  };
  async function perform(task: () => Promise<void>, context: ErrorContext = "tools") {
    if (working.current || !owner || !current()) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      if (current()) setError(userErrorMessage(cause, context));
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  }
  async function chooseImage(file: File) {
    const request = ++imageRequest.current;
    await perform(async () => {
      const url = await readToolImage(file);
      if (current() && request === imageRequest.current) {
        setContent(url);
        setName((previous) => previous || file.name.replace(/\.[^.]+$/, ""));
      }
    }, "image");
  }
  const close = () => {
    if (!working.current) closing.close();
  };
  return (
    <Dialog
      open={closing.open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="w-[min(94vw,760px)] p-0"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (busy) e.preventDefault();
        }}
      >
        <div className="flex items-start justify-between border-b border-stone-200 px-6 py-5">
          <div>
            <DialogTitle className="text-lg font-semibold">
              {adding ? "도구 추가" : "내 도구함"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {adding ? "도구 종류 선택" : "저장한 도구 목록"}
            </DialogDescription>
          </div>
          <IconButton icon={X} label="도구함 닫기" disabled={busy} onClick={close} />
        </div>
        {removeDialog.dialog}
        {editing && owner && (
          <ToolEditDialog tool={editing} owner={owner} onClose={() => setEditing(null)} />
        )}
        {drawingSignature && (
          <SignatureDialog
            purpose="tool"
            onClose={() => setDrawingSignature(false)}
            onApply={async (png) => {
              if (!current()) return false;
              if (png.length > 1_048_576)
                throw new UserFacingError("서명을 조금 간단하게 그린 뒤 다시 선택해 주세요.");
              setContent(
                `data:image/png;base64,${btoa(png.map((byte) => String.fromCharCode(byte)).join(""))}`,
              );
              setError(null);
              return true;
            }}
          />
        )}
        <div className="p-6">
          {!owner ? (
            <LibrarySignIn />
          ) : (
            <>
              {!adding && (
                <div className="mb-5 flex items-center justify-between">
                  <span className="text-xs text-stone-400">보관한 도구 {tools.length} / 50</span>
                  {
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || loading || tools.length >= 50}
                      onClick={() => {
                        setAdding(true);
                        setContent("");
                        setName("");
                        setKind("image");
                        setError(null);
                      }}
                    >
                      <Plus size={14} />
                      <span className="sr-only">도구 추가</span>
                    </Button>
                  }
                </div>
              )}
              {adding ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!kind || !content.trim() || !name.trim()) return;
                    void perform(async () => {
                      await add({ name: name.trim(), kind, content }, owner);
                      if (current()) {
                        if (initialAdding) {
                          closing.close();
                          return;
                        }
                        setAdding(false);
                        setFilter("all");
                        setContent("");
                        setName("");
                      }
                    }, "toolSave");
                  }}
                >
                  <fieldset disabled={busy} className="space-y-5">
                    <div
                      className="flex flex-wrap gap-1 border-b border-stone-200"
                      role="group"
                      aria-label="도구 종류"
                    >
                      {kinds.map((value) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={kind === value}
                          onClick={() => {
                            imageRequest.current++;
                            setKind(value);
                            setContent("");
                            setError(null);
                          }}
                          className={`border-b-2 px-4 pb-2.5 text-sm ${kind === value ? "border-emerald-800 font-medium text-emerald-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}
                        >
                          {labels[value]}
                        </button>
                      ))}
                    </div>
                    {kind && (
                      <>
                        <label className="block text-xs font-medium text-stone-600">
                          이름
                          <Input
                            required
                            maxLength={80}
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder={
                              kind === "image"
                                ? "예: 회사 로고"
                                : kind === "signature"
                                  ? "예: 내 서명"
                                  : kind === "text"
                                    ? "예: 견적서 안내"
                                    : "예: 외부 전달용"
                            }
                            className="mt-2 text-sm"
                          />
                        </label>
                        {kind === "signature" ? (
                          <button
                            type="button"
                            className="flex min-h-36 w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50 p-5 text-xs text-stone-500 hover:border-stone-400"
                            onClick={() => setDrawingSignature(true)}
                          >
                            {content ? (
                              <img
                                src={content}
                                alt="보관할 서명 미리보기"
                                className="max-h-32 max-w-full object-contain"
                              />
                            ) : (
                              <Stamp size={25} strokeWidth={1.3} />
                            )}
                            <span>{content ? "서명 다시 그리기" : "서명 그리기"}</span>
                          </button>
                        ) : kind === "image" ? (
                          <div>
                            <input
                              ref={fileInput}
                              type="file"
                              accept="image/png,image/jpeg,image/webp,image/bmp"
                              aria-label="보관할 이미지"
                              className="sr-only"
                              tabIndex={-1}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (file) void chooseImage(file);
                              }}
                            />
                            <button
                              type="button"
                              className="flex min-h-36 w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-stone-300 bg-stone-50 p-5 text-xs text-stone-500 hover:border-stone-400"
                              onClick={() => fileInput.current?.click()}
                            >
                              {content ? (
                                <img
                                  src={content}
                                  alt="보관할 이미지 미리보기"
                                  className="max-h-32 max-w-full object-contain"
                                />
                              ) : (
                                <ImagePlus size={25} strokeWidth={1.3} />
                              )}
                              <span>{content ? "다른 이미지 선택" : "로고·도장 이미지 선택"}</span>
                            </button>
                          </div>
                        ) : (
                          <label className="block text-xs font-medium text-stone-600">
                            {kind === "watermark" ? "워터마크 문구" : "내용"}
                            <Textarea
                              required
                              maxLength={4000}
                              rows={5}
                              value={content}
                              onChange={(e) => setContent(e.target.value)}
                              className="mt-2 resize-y text-sm"
                              placeholder={
                                kind === "watermark"
                                  ? "예: 검토용 · 외부 배포 금지"
                                  : "자주 사용하는 문구를 입력하세요."
                              }
                            />
                          </label>
                        )}
                        <div className="flex justify-end border-t border-stone-100 pt-4">
                          <Button
                            type="submit"
                            size="sm"
                            disabled={!name.trim() || !content.trim() || busy}
                            className="bg-emerald-900 text-white hover:bg-emerald-800"
                          >
                            {busy ? "처리 중…" : "보관하기"}
                          </Button>
                        </div>
                      </>
                    )}
                  </fieldset>
                </form>
              ) : (
                <>
                  <div
                    role="group"
                    aria-label="도구 필터"
                    className="mb-5 flex flex-wrap gap-1 border-b border-stone-200"
                  >
                    {(["all", ...kinds] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                        className={`border-b-2 px-3 pb-2.5 text-xs ${filter === value ? "border-emerald-800 font-medium text-emerald-900" : "border-transparent text-stone-500 hover:text-stone-800"}`}
                      >
                        {value === "all" ? "전체" : labels[value]}
                      </button>
                    ))}
                  </div>
                  {loading && (
                    <p role="status" className="py-10 text-center text-sm text-stone-500">
                      도구함을 불러오는 중…
                    </p>
                  )}
                  {!loading && !loadError && !tools.length && (
                    <div className="py-12 text-center">
                      <p className="text-sm text-stone-600">아직 보관한 도구가 없습니다.</p>
                    </div>
                  )}
                  {!loading && !loadError && tools.length > 0 && !filteredTools.length && (
                    <p role="status" className="py-12 text-center text-sm text-stone-500">
                      보관한 {filter === "all" ? "" : `${labels[filter]} `}도구가 없습니다.
                    </p>
                  )}
                  <div className="grid max-h-[48vh] grid-cols-2 gap-4 overflow-auto sm:grid-cols-3">
                    {filteredTools.map((tool) => (
                      <div key={tool.id} className="relative min-w-0">
                        <button
                          type="button"
                          aria-label={`${tool.name} ${onUse ? (tool.kind === "watermark" ? "설정 열기" : tool.kind === "text" ? "문구 복사" : "문서에 넣기") : tool.kind === "text" || tool.kind === "watermark" ? "문구 복사" : "미리보기"}`}
                          disabled={
                            busy ||
                            !!editing ||
                            (!onUse && (tool.kind === "image" || tool.kind === "signature"))
                          }
                          onClick={() => useTool(tool)}
                          className="group block w-full rounded-md text-left outline-offset-4 transition-colors enabled:hover:bg-stone-50 focus-visible:outline-emerald-700 disabled:cursor-default"
                        >
                          <ToolPreview tool={tool} />
                          <span
                            className="mt-2 block truncate pr-14 text-xs font-medium"
                            title={tool.name}
                          >
                            {tool.name}
                          </span>
                          <span className="mt-1 flex min-h-5 items-center gap-2 text-[10px] text-stone-400">
                            {labels[tool.kind]}
                            {copied === tool.id && (
                              <span
                                role="status"
                                className="inline-flex items-center gap-1 text-emerald-800"
                              >
                                <Check size={12} />
                                복사됨
                              </span>
                            )}
                          </span>
                        </button>
                        <IconButton
                          icon={Pencil}
                          label={`${tool.name} 수정`}
                          disabled={busy || !!editing}
                          className="absolute bottom-5 right-7 size-6 text-stone-400"
                          onClick={() => {
                            setError(null);
                            setEditing(tool);
                          }}
                        />
                        <IconButton
                          icon={Trash2}
                          label={`${tool.name} 삭제`}
                          disabled={busy || !!editing}
                          className="absolute bottom-5 right-0 size-6 text-stone-400"
                          onClick={async () => {
                            if (await removeDialog.confirm())
                              void perform(() => remove(tool.id, owner), "toolRemove");
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </>
              )}
              {(error || (!adding && loadError)) && (
                <div
                  role="alert"
                  className="mt-4 flex items-center justify-between gap-3 text-xs leading-5 text-red-700"
                >
                  <span>{error ?? loadError}</span>
                  {loadError && !adding && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || loading}
                      onClick={() => void load(owner)}
                    >
                      다시 시도
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
