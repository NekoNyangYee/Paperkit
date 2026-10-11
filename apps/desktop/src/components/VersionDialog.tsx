import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { Download, Info, RefreshCw, X } from "lucide-react";
import appIcon from "../../app-icon.svg";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { compareVersions, latestRelease } from "../lib/releases";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { downloadUpdate, installUpdate } from "../lib/updater";
import { approveAppExit } from "../lib/app-exit";

export function VersionDialog() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [release, setRelease] = useState<Awaited<ReturnType<typeof latestRelease>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatePhase, setUpdatePhase] = useState<"idle" | "downloading" | "ready" | "installing">(
    "idle",
  );
  const [percent, setPercent] = useState<number | null>(null);
  const [readyTag, setReadyTag] = useState<string | null>(null);
  const updating = useRef(false);
  const skipNextCheck = useRef(false);
  const pending = useRef<AbortController | null>(null);
  function changeOpen(value: boolean) {
    setOpen(value);
    if (!value) {
      pending.current?.abort();
      pending.current = null;
      setLoading(false);
    }
  }
  const check = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => controller.abort(), 10000);
    setLoading(true);
    setError(null);
    setRelease(null);
    try {
      if (isTauri()) setVersion(await getVersion());
      if (controller.signal.aborted) return;
      const result = await latestRelease("NekoNyangYee/pdf-editor", controller.signal);
      if (pending.current !== controller) return;
      setRelease(result);
    } catch (cause) {
      if (pending.current === controller)
        setError(
          controller.signal.aborted
            ? "응답 시간이 초과되었습니다. 네트워크를 확인해 주세요."
            : cause instanceof Error
              ? cause.message
              : "릴리즈를 불러오지 못했습니다.",
        );
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (open) {
      if (skipNextCheck.current) skipNextCheck.current = false;
      else void check();
    }
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [open, check]);
  const comparison = release && version ? compareVersions(release.tag, version) : null;
  return (
    <>
      <IconButton icon={Info} label="앱 버전 확인" onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="w-[min(92vw,520px)] p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={appIcon} alt="Paperkit 로고" className="size-10" />
              <DialogTitle className="font-semibold">Paperkit 버전 확인</DialogTitle>
              <button
                type="button"
                aria-label="GitHub 저장소 열기"
                title="GitHub 저장소 열기"
                className="inline-flex size-10 items-center justify-center rounded-lg text-stone-600 hover:bg-stone-100"
                onClick={async () => {
                  try {
                    await openUrl("https://github.com/NekoNyangYee/pdf-editor");
                  } catch {
                    setError("GitHub 저장소를 열지 못했습니다.");
                  }
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.77-.24.77-.54v-2.1c-3.12.68-3.78-1.32-3.78-1.32-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.49-.28-5.1-1.24-5.1-5.54 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.54.23 2.68.11 2.96.71.78 1.15 1.78 1.15 3 0 4.31-2.62 5.25-5.12 5.53.4.35.76 1.03.76 2.08v3.09c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" />
                </svg>
              </button>
            </div>
            <IconButton icon={X} label="버전 창 닫기" onClick={() => changeOpen(false)} />
          </div>
          <DialogDescription className="mt-2 text-sm text-stone-500">
            현재 버전 {version ?? (isTauri() ? "확인 중…" : "데스크톱 앱에서 확인 가능")}
          </DialogDescription>
          <div className="mt-4 flex items-center justify-between gap-4">
            <div role="status" className="min-w-0 flex-1 text-sm leading-6">
              {error ??
                (release
                  ? `최신 릴리즈 ${release.tag} · ${comparison === null ? "버전 비교 불가" : comparison > 0 ? "새 버전이 있습니다" : comparison === 0 ? "최신 버전입니다" : "설치된 버전이 더 높습니다"}`
                  : "공개된 정식 릴리즈를 조회합니다.")}
            </div>

            <button
              onClick={() => void check()}
              disabled={loading || updatePhase === "downloading" || updatePhase === "installing"}
              className="flex shrink-0 items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white"
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
              {loading ? "확인 중…" : "최신 버전 확인"}
            </button>
          </div>

          {comparison !== null && comparison > 0 && release && (
            <div className="mt-4 flex flex-col items-end">
              <button
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={
                  !release.downloadUrl ||
                  updatePhase === "downloading" ||
                  updatePhase === "installing"
                }
                onClick={async () => {
                  if (!release.downloadUrl || updating.current) return;
                  updating.current = true;
                  setError(null);
                  try {
                    if (readyTag === release.tag) {
                      skipNextCheck.current = true;
                      changeOpen(false);
                      if (!(await approveAppExit())) {
                        setOpen(true);
                        return;
                      }
                      setOpen(true);
                      setUpdatePhase("installing");
                      await installUpdate();
                    } else {
                      setReadyTag(null);
                      setUpdatePhase("downloading");
                      setPercent(null);
                      await downloadUpdate(release.tag, ({ downloaded, total }) => {
                        setPercent(
                          total ? Math.min(100, Math.floor((downloaded / total) * 100)) : null,
                        );
                      });
                      setReadyTag(release.tag);
                      setUpdatePhase("ready");
                    }
                  } catch (cause) {
                    setOpen(true);
                    setReadyTag(null);
                    setUpdatePhase("idle");
                    setError(cause instanceof Error ? cause.message : String(cause));
                  } finally {
                    updating.current = false;
                  }
                }}
              >
                <Download size={16} />{" "}
                {updatePhase === "downloading"
                  ? `다운로드 중${percent === null ? "…" : ` ${percent}%`}`
                  : updatePhase === "installing"
                    ? "업데이트 적용 중…"
                    : readyTag === release.tag
                      ? "재시작하여 업데이트"
                      : "업데이트"}
              </button>
              <p className="mt-2 text-xs text-stone-500">
                {!release.downloadUrl
                  ? "업데이트 설치 파일이 아직 준비되지 않았습니다."
                  : updatePhase === "downloading"
                    ? "앱에서 업데이트를 내려받고 검증하고 있습니다."
                    : readyTag === release.tag
                      ? "다운로드가 완료되었습니다. 재시작하면 새 버전을 설치하고 앱을 다시 엽니다."
                      : "앱에서 다운로드합니다. 완료 후 재시작할 시점을 선택할 수 있습니다."}
              </p>
            </div>
          )}
          {release && (
            <>
              <p className="mt-2 text-xs text-stone-500">
                {release.published && `게시일 ${new Date(release.published).toLocaleDateString()}`}
              </p>
              <div
                className="release-notes mt-4 max-h-72 overflow-auto border-t border-stone-200 pt-4 pr-2 text-sm"
                aria-label="릴리즈 노트"
              >
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) => {
                      let url: URL;
                      try {
                        url = new URL(href ?? "", "https://github.com/NekoNyangYee/pdf-editor/");
                      } catch {
                        return <span>{children}</span>;
                      }
                      if (!href || !["https:", "http:"].includes(url.protocol))
                        return <span>{children}</span>;
                      return (
                        <a
                          href={url.href}
                          onClick={async (event) => {
                            event.preventDefault();
                            try {
                              await openUrl(url.href);
                            } catch {
                              setError("링크를 열지 못했습니다.");
                            }
                          }}
                        >
                          {children}
                        </a>
                      );
                    },
                    img: ({ alt }) => <span>{alt}</span>,
                  }}
                >
                  {release.notes || "릴리즈 설명이 없습니다."}
                </Markdown>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
