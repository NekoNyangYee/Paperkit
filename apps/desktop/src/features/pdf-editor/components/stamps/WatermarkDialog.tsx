import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/shared/ui/dialog";
import { userErrorMessage } from "@/shared/lib/errors";
import { IconButton } from "@/shared/ui/icon-button";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import { Slider } from "@/shared/ui/slider";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";
import { SelectField } from "@/shared/ui/select";
import { Input, Textarea } from "@/shared/ui/input";
import { useConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useDialogClose } from "@/shared/ui/use-dialog-close";
import type { PreviewPage, EditAction } from "@/shared/pdf/types";
import {
  DEFAULT_WATERMARK_OPTIONS,
  restoredWatermarkImage,
  WATERMARK_MODE_DEFAULTS,
  watermarkBounds,
  watermarkPng,
  watermarkSource,
  type WatermarkOptions,
} from "@/features/pdf-editor/lib/stamps/watermark";
import placeholderUrl from "@/features/pdf-editor/lib/stamps/watermark-placeholder.svg";

const IMAGE_PLACEHOLDER = { url: placeholderUrl, width: 640, height: 400 };

export function WatermarkDialog({
  page,
  onClose,
  onApply,
  applyError,
  initialText,
}: {
  page: PreviewPage;
  onClose: () => void;
  onApply: (action: EditAction) => Promise<boolean>;
  applyError?: string | null;
  initialText?: string;
}) {
  const { open, close } = useDialogClose(onClose);
  const resetDialog = useConfirmDialog({
    title: "워터마크 설정 초기화",
    description:
      "입력한 텍스트와 선택한 이미지, 색상, 투명도, 크기, 각도, 적용 범위를 처음 값으로 되돌릴까요?",
  });
  const saved = initialText === undefined ? page.text.watermarkSettings : undefined;
  const [options, setOptions] = useState<WatermarkOptions>(() =>
    saved
      ? {
          kind: saved.kind,
          text: saved.text,
          image: restoredWatermarkImage(saved.image),
          opacity: saved.opacity,
          angle: saved.angle,
          color: saved.color,
          date: saved.date,
        }
      : { ...DEFAULT_WATERMARK_OPTIONS, text: initialText ?? DEFAULT_WATERMARK_OPTIONS.text },
  );
  const [enabled, setEnabled] = useState(
    initialText !== undefined || (page.text.watermarkPages?.includes(page.pageIndex) ?? false),
  );
  const [scope, setScope] = useState<"all" | "current">(saved?.scope ?? "all");
  const [size, setSize] = useState<number>(saved?.size ?? WATERMARK_MODE_DEFAULTS.text.size);
  const [background, setBackground] = useState(page.imageUrl);
  const [backgroundReady, setBackgroundReady] = useState(!page.text.watermarkObjects?.length);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [backgroundRetry, setBackgroundRetry] = useState(0);
  const content = useMemo(
    () => ({
      kind: options.kind,
      text: options.text,
      image: options.image,
      color: options.color,
      date: options.date,
    }),
    [options.kind, options.text, options.image, options.color, options.date],
  );
  const [preview, setPreview] = useState<{
    content: typeof content;
    source: Awaited<ReturnType<typeof watermarkSource>>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const applying = useRef(false);
  useEffect(() => {
    let disposed = false;
    setBackgroundError(null);
    const objects = page.text.watermarkObjects;
    if (!objects?.length) {
      setBackground(page.imageUrl);
      setBackgroundReady(true);
      return;
    }
    setBackgroundReady(false);
    void invoke<string>("editing_background", {
      fileId: page.fileId,
      revision: page.state.revision,
      pageIndex: page.pageIndex,
      width: page.width,
      objects,
    })
      .then((url) => {
        if (!disposed) {
          setBackground(url);
          setBackgroundReady(true);
        }
      })
      .catch(() => {
        if (!disposed) setBackgroundError("미리보기를 준비하지 못했어요. 다시 불러와 주세요.");
      });
    return () => {
      disposed = true;
    };
  }, [page, backgroundRetry]);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    setError(null);
    if (content.kind === "image" && !content.image) {
      setPreview(null);
      return;
    }
    void watermarkSource(content)
      .then((source) => {
        if (!disposed) setPreview({ content, source });
      })
      .catch((cause: unknown) => {
        if (!disposed) {
          setPreview(null);
          setError(userErrorMessage(cause, "image"));
        }
      });
    return () => {
      disposed = true;
    };
  }, [content, enabled]);
  function changeKind(kind: WatermarkOptions["kind"]) {
    if (kind === options.kind) return;
    // Drop the previous source synchronously; an outstanding text render must never
    // become the image preview or be submitted as the selected image's PNG.
    setPreview(null);
    setError(null);
    setOptions((previous) => ({
      ...previous,
      kind,
      text: kind === "image" ? "" : DEFAULT_WATERMARK_OPTIONS.text,
      angle: WATERMARK_MODE_DEFAULTS[kind].angle,
    }));
    setSize(WATERMARK_MODE_DEFAULTS[kind].size);
  }
  const validContent =
    options.kind === "text" ? !!options.text.trim() || !!options.date : !!options.image;
  const placeholder = options.kind === "image" && !options.image;
  const visible =
    enabled && placeholder
      ? IMAGE_PLACEHOLDER
      : enabled && validContent && preview?.content === content
        ? preview.source
        : null;
  const ready = validContent && preview?.content === content;
  const hasWatermark = (page.text.watermarkPages ?? []).some(
    (index) => scope === "all" || index === page.pageIndex,
  );
  const bounds = visible ? watermarkBounds(visible.width, visible.height, options.angle) : null;
  const fit = bounds
    ? Math.min(size / 100, (((0.8 * page.height) / page.width) * bounds.width) / bounds.height)
    : 0;
  async function reset() {
    if (!(await resetDialog.confirm())) return;
    setOptions({ ...DEFAULT_WATERMARK_OPTIONS });
    setSize(WATERMARK_MODE_DEFAULTS.text.size);
    setScope("all");
    setError(null);
  }
  async function apply() {
    if (applying.current || (enabled ? !ready || !preview || !backgroundReady : !hasWatermark))
      return;
    applying.current = true;
    setPending(true);
    setError(null);
    try {
      const target = scope === "all" ? null : page.pageIndex;
      const action: EditAction =
        enabled && preview
          ? {
              kind: "addWatermark",
              page: target,
              png: (await watermarkPng(options, preview.source)).png,
              widthRatio: size / 100,
              settings: {
                kind: options.kind,
                text: options.text,
                image: options.kind === "image" ? preview.source.url : null,
                opacity: options.opacity,
                angle: options.angle,
                color: options.color,
                date: options.date,
                size,
                scope,
              },
            }
          : { kind: "removeWatermark", page: target };
      if (await onApply(action)) close();
      else setError("워터마크 변경을 적용하지 못했습니다. 다시 시도해 주세요.");
    } catch (cause) {
      setError(userErrorMessage(cause, "watermark"));
    } finally {
      applying.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !applying.current && !resetDialog.isOpen) close();
      }}
    >
      <DialogContent className="grid h-[min(680px,calc(100dvh-64px))] w-[min(94vw,900px)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden p-5 [@media(max-height:650px)]:gap-3 [@media(max-height:650px)]:p-4">
        <header className="min-w-0">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-lg font-semibold">워터마크</DialogTitle>
            <IconButton icon={X} label="워터마크 창 닫기" disabled={pending} onClick={close} />
          </div>
          <DialogDescription className="sr-only">
            워터마크를 켜서 추가·교체하거나, 꺼서 제거하세요. 적용 전 미리보기로 확인할 수 있습니다.
          </DialogDescription>
        </header>
        <div className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
          <fieldset
            disabled={pending}
            className="min-h-0 min-w-0 space-y-4 overflow-y-auto [@media(max-height:650px)]:space-y-3"
          >
            <legend className="sr-only">워터마크 설정</legend>
            <div className="flex items-center justify-between rounded-lg border border-stone-200 px-3 py-2">
              <label htmlFor="watermark-enabled" className="text-sm font-medium">
                워터마크 사용
              </label>
              <Switch
                id="watermark-enabled"
                checked={enabled}
                disabled={pending}
                onCheckedChange={(value) => {
                  setEnabled(value);
                  setError(null);
                }}
              />
            </div>
            {enabled && (
              <>
                <RadioGroup
                  aria-label="워터마크 종류"
                  value={options.kind}
                  onValueChange={(kind) => changeKind(kind as WatermarkOptions["kind"])}
                  disabled={pending}
                  className="flex items-center gap-5 text-sm"
                >
                  {(["text", "image"] as const).map((kind) => (
                    <label key={kind} className="flex items-center gap-2">
                      <RadioGroupItem value={kind} />
                      {kind === "text" ? "텍스트" : "이미지"}
                    </label>
                  ))}
                </RadioGroup>
                {options.kind === "text" ? (
                  <div>
                    <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
                      <label htmlFor="watermark-text">워터마크 텍스트</label>
                      <label className="flex shrink-0 items-center gap-2 text-xs text-stone-500">
                        <span>색상</span>
                        <Input
                          type="color"
                          aria-label="워터마크 색상"
                          value={options.color}
                          onChange={(event) =>
                            setOptions({ ...options, color: event.target.value })
                          }
                          className="h-6 w-10 cursor-pointer p-0.5"
                        />
                      </label>
                    </div>
                    <Textarea
                      id="watermark-text"
                      aria-label="워터마크 텍스트"
                      maxLength={200}
                      rows={2}
                      value={options.text}
                      onChange={(event) => setOptions({ ...options, text: event.target.value })}
                      className="block h-20 resize-none [@media(max-height:650px)]:h-16"
                    />
                    <div className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <label htmlFor="watermark-date" className="flex min-w-0 items-center gap-2">
                        <span>날짜 추가</span>
                        {options.date && <span className="text-stone-500">{options.date}</span>}
                      </label>
                      <Switch
                        id="watermark-date"
                        aria-label="날짜 추가"
                        checked={options.date !== null}
                        disabled={pending}
                        onCheckedChange={(checked) =>
                          setOptions({
                            ...options,
                            date: checked
                              ? new Intl.DateTimeFormat("sv-SE", {
                                  year: "numeric",
                                  month: "2-digit",
                                  day: "2-digit",
                                }).format(new Date())
                              : null,
                          })
                        }
                      />
                    </div>
                  </div>
                ) : (
                  <label className="block text-sm">
                    워터마크 이미지 파일
                    <Input
                      type="file"
                      aria-label="워터마크 이미지 파일"
                      accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
                      onChange={(event) => {
                        const image = event.target.files?.[0];
                        if (image) setOptions({ ...options, image });
                        event.target.value = "";
                      }}
                      className="mt-2 h-auto py-2 text-xs"
                    />
                    <span
                      className="mt-1 block truncate text-xs text-stone-500"
                      title={
                        options.image?.name ??
                        "미리보기용 기본 이미지입니다. 적용하려면 이미지 파일을 선택하세요."
                      }
                    >
                      {options.image?.name ?? "이미지 선택"}
                    </span>
                  </label>
                )}
              </>
            )}
            <div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                {enabled && (
                  <>
                    <div className="min-w-0 text-xs">
                      <span>투명도 {options.opacity}%</span>
                      <Slider
                        aria-label="워터마크 투명도"
                        min={5}
                        max={100}
                        step={1}
                        value={[options.opacity]}
                        disabled={pending}
                        onValueChange={([opacity]) => setOptions({ ...options, opacity: opacity! })}
                        className="mt-1"
                      />
                    </div>
                    <div className="min-w-0 text-xs">
                      <span>크기 {size}%</span>
                      <Slider
                        aria-label="워터마크 크기"
                        min={10}
                        max={90}
                        step={1}
                        value={[size]}
                        disabled={pending}
                        onValueChange={([value]) => setSize(value!)}
                        className="mt-1"
                      />
                    </div>
                    <div className="min-w-0 text-xs">
                      <span>각도 {options.angle}°</span>
                      <Slider
                        aria-label="워터마크 각도"
                        min={-90}
                        max={90}
                        step={1}
                        value={[options.angle]}
                        disabled={pending}
                        onValueChange={([angle]) => setOptions({ ...options, angle: angle! })}
                        className="mt-1"
                      />
                    </div>
                  </>
                )}
                <div className="min-w-0 text-xs">
                  <span>적용 범위</span>
                  <SelectField
                    label="워터마크 적용 범위"
                    value={scope}
                    onValueChange={(value) => setScope(value as "all" | "current")}
                    disabled={pending}
                    className="mt-1 w-full"
                    options={[
                      { value: "all", label: "전체 페이지" },
                      { value: "current", label: `현재 페이지 (${page.pageIndex + 1}페이지)` },
                    ]}
                  />
                </div>
              </div>
              {enabled && (
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="link"
                    size="link"
                    disabled={pending}
                    onClick={() => void reset()}
                    title="모든 워터마크 설정을 처음 값으로 되돌립니다."
                  >
                    초기화
                  </Button>
                </div>
              )}
            </div>
          </fieldset>
          <div className="flex min-h-0 min-w-0 flex-col rounded-xl bg-stone-100 p-3">
            <p className="mb-2 shrink-0 text-xs font-medium text-stone-500">
              미리보기 · {page.pageIndex + 1}페이지
            </p>
            <div
              aria-label="워터마크 미리보기 영역"
              className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
              style={{ containerType: "size" }}
            >
              {backgroundReady ? (
                <div
                  className="relative shrink-0 overflow-hidden bg-white shadow-sm"
                  style={{
                    width: `min(100cqw, calc(100cqh * ${page.width / page.height}))`,
                    aspectRatio: `${page.width}/${page.height}`,
                  }}
                >
                  <img
                    src={background}
                    alt="워터마크 적용 전 페이지"
                    className="absolute inset-0 size-full"
                  />
                  {visible && bounds && (
                    <img
                      src={visible.url}
                      alt={placeholder ? "워터마크 기본 이미지 미리보기" : "워터마크 미리보기"}
                      className="absolute left-1/2 top-1/2 max-w-none"
                      style={{
                        width: `${((fit * visible.width) / bounds.width) * 100}%`,
                        opacity: options.opacity / 100,
                        transform: `translate(-50%, -50%) rotate(${options.angle}deg)`,
                      }}
                    />
                  )}
                </div>
              ) : (
                <p className="text-xs text-stone-500" role="status">
                  미리보기 준비 중…
                </p>
              )}
            </div>
          </div>
        </div>
        <footer className="min-w-0">
          {(applyError || error || backgroundError) && (
            <p role="alert" className="mb-2 text-sm text-red-700">
              {applyError ?? error ?? backgroundError}
            </p>
          )}
          {backgroundError && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setBackgroundRetry((value) => value + 1)}
            >
              미리보기 다시 불러오기
            </Button>
          )}
          <div className="flex justify-end gap-3">
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" disabled={pending} onClick={close}>
                취소
              </Button>
              <Button
                disabled={pending || (enabled ? !ready || !backgroundReady : !hasWatermark)}
                onClick={() => void apply()}
              >
                {pending ? "적용 중…" : enabled ? "워터마크 적용" : "워터마크 제거"}
              </Button>
            </div>
          </div>
        </footer>
      </DialogContent>
      {resetDialog.dialog}
    </Dialog>
  );
}
