import { Button } from "@/shared/ui/button";
import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { isDesktop } from "@/shared/desktop/files";
import { useFileStore } from "@/features/file-input/model/file-store";
import { FileThumbnail } from "./FileThumbnail";
import { FileText, Upload, RotateCcw } from "lucide-react";
import { IconButton } from "@/shared/ui/icon-button";
import { MessageDialog } from "@/shared/ui/MessageDialog";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileInput() {
  const area = useRef<HTMLElement>(null);
  const dialogOpen = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const file = useFileStore((state) => state.file);
  const { phase, error, ready, initialize, receive, reportError, openFile } = useFileStore();
  const busy = choosing || phase === "restoring" || phase === "checking" || phase === "clearing";
  const [listenerError, setListenerError] = useState<string | null>(null);
  const desktop = isDesktop();

  async function chooseFile() {
    if (!desktop || !ready || busy || dialogOpen.current) return;
    dialogOpen.current = true;
    setChoosing(true);
    let selected: string | null = null;
    try {
      selected = await open({
        title: "PDF 파일 선택",
        directory: false,
        multiple: false,
        filters: [{ name: "PDF 문서", extensions: ["pdf"] }],
      });
    } catch (cause) {
      reportError(cause);
    } finally {
      dialogOpen.current = false;
      setChoosing(false);
    }
    if (selected !== null) await receive([selected]);
  }

  useEffect(() => {
    if (!desktop) return;
    void initialize();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (disposed || dialogOpen.current || !useFileStore.getState().ready) return;
        if (payload.type === "leave") {
          setDragging(false);
          return;
        }
        // Tauri positions are physical pixels; DOM bounds are CSS pixels.
        const rect = area.current?.getBoundingClientRect();
        const x = payload.position.x / window.devicePixelRatio;
        const y = payload.position.y / window.devicePixelRatio;
        const inside =
          !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        setDragging(payload.type !== "drop" && inside);
        if (payload.type === "drop" && inside) void receive(payload.paths);
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setListenerError(
            `드래그 앤 드롭을 연결하지 못했습니다. 파일 선택 버튼을 이용해 주세요. (${String(cause)})`,
          );
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop, initialize, receive]);

  return (
    <section
      ref={area}
      aria-labelledby="workspace-title"
      aria-busy={busy}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()}
      className={`w-full max-w-2xl rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors sm:px-12 sm:py-16 ${dragging ? "border-emerald-700 bg-emerald-50" : "border-stone-300 bg-white/80"}`}
    >
      <div
        className={`mx-auto grid size-20 place-items-center rounded-2xl ${dragging ? "bg-emerald-100" : "bg-stone-100"}`}
        aria-hidden="true"
      >
        {file && !dragging ? (
          <FileText size={36} className="text-emerald-900" />
        ) : (
          <Upload size={36} className="text-emerald-900" />
        )}
      </div>
      <h1 id="workspace-title" className="mt-7 text-2xl font-semibold tracking-tight">
        {dragging ? "여기에 놓아주세요" : file ? "이 파일을 열까요?" : "PDF 파일을 끌어다 놓으세요"}
      </h1>
      <p className="mt-3 text-sm leading-6 text-stone-500">
        {file
          ? "선택한 파일을 확인한 뒤 PDF를 열어주세요."
          : "또는 아래 버튼을 눌러 파일을 선택하세요."}
      </p>
      {file && (
        <div
          className="mt-7 rounded-2xl bg-stone-100/80 px-5 py-5 text-left"
          aria-label="선택한 파일 정보"
          aria-live="polite"
        >
          <div className="flex items-center gap-4">
            <span className="mt-0.5 rounded bg-white px-2 py-1 text-xs font-semibold text-emerald-900">
              PDF
            </span>
            <div className="min-w-0 flex-1">
              <p className="break-all text-sm font-semibold text-stone-800">{file.name}</p>
              <p className="mt-1 text-xs text-stone-500">{formatSize(file.sizeBytes)}</p>
              <p className="mt-2 break-all text-xs leading-5 text-stone-400">{file.path}</p>
            </div>
            <FileThumbnail key={file.id} fileId={file.id} />
          </div>
        </div>
      )}
      <div className="mt-7 flex flex-wrap justify-center gap-3">
        <Button
          variant="ghost"
          type="button"
          onClick={() => void chooseFile()}
          disabled={!desktop || !ready || busy}
          className={`min-h-12 min-w-36 rounded-xl px-6 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-40 ${file ? "border border-stone-300 bg-white text-stone-600 hover:bg-stone-50" : "bg-emerald-900 text-white hover:bg-emerald-800"}`}
        >
          {busy ? "확인 중…" : file ? "다른 파일 선택" : "파일 선택"}
        </Button>
        {file && (
          <Button
            variant="ghost"
            type="button"
            onClick={openFile}
            disabled={!desktop || !ready || busy}
            className="min-h-12 min-w-36 rounded-xl bg-emerald-900 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:opacity-40"
          >
            PDF 열기
          </Button>
        )}
      </div>
      <div role="status" aria-live="polite">
        {busy && (
          <p className="mt-5 text-sm text-stone-500">
            {choosing
              ? "파일을 선택해 주세요."
              : phase === "restoring"
                ? "선택 상태를 불러오고 있습니다."
                : phase === "clearing"
                  ? "선택을 해제하고 있습니다."
                  : "파일을 확인하고 있습니다."}
          </p>
        )}
      </div>
      <MessageDialog title="파일 확인" message={error ?? listenerError} />
      {desktop && !ready && phase === "error" && (
        <IconButton label="다시 연결" icon={RotateCcw} onClick={() => void initialize()} />
      )}
      {!desktop && (
        <p className="mt-5 text-xs text-stone-500">
          파일 선택과 드래그 앤 드롭은 데스크톱 앱에서 사용할 수 있습니다.
        </p>
      )}
    </section>
  );
}
