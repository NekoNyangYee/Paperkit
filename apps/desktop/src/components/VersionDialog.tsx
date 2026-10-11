import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { Download, Info, RefreshCw, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { compareVersions, latestRelease } from "../lib/releases";

export function VersionDialog() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [release, setRelease] = useState<Awaited<ReturnType<typeof latestRelease>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [downloadStarted, setDownloadStarted] = useState(false);
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
    setDownloadStarted(false);
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
    if (open) void check();
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
            <DialogTitle className="font-semibold">Paperkit 버전 확인</DialogTitle>
            <IconButton icon={X} label="버전 창 닫기" onClick={() => changeOpen(false)} />
          </div>
          <DialogDescription className="mt-2 text-sm text-stone-500">
            현재 버전 {version ?? (isTauri() ? "확인 중…" : "데스크톱 앱에서 확인 가능")}
          </DialogDescription>
          <button
            onClick={() => void check()}
            disabled={loading}
            className="mt-3 flex items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            {loading ? "확인 중…" : "최신 버전 확인"}
          </button>
          <div role="status" className="mt-4 text-sm">
            {error ??
              (release
                ? `최신 릴리즈 ${release.tag} · ${comparison === null ? "버전 비교 불가" : comparison > 0 ? "새 버전이 있습니다" : comparison === 0 ? "최신 버전입니다" : "설치된 버전이 더 높습니다"}`
                : "공개된 정식 릴리즈를 조회합니다.")}
          </div>
          {comparison !== null && comparison > 0 && release && (
            <div className="mt-4">
              <button
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-emerald-800 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!release.downloadUrl || opening}
                onClick={async () => {
                  if (!release.downloadUrl) return;
                  setOpening(true);
                  try {
                    await openUrl(release.downloadUrl);
                    setDownloadStarted(true);
                  } catch {
                    setError("설치 파일 다운로드를 열지 못했습니다. 다시 시도해 주세요.");
                  } finally {
                    setOpening(false);
                  }
                }}
              >
                <Download size={16} /> {opening ? "다운로드 여는 중…" : "업데이트"}
              </button>
              <p className="mt-2 text-xs text-stone-500">
                {!release.downloadUrl
                  ? "업데이트 설치 파일이 아직 준비되지 않았습니다."
                  : downloadStarted
                    ? "브라우저에서 다운로드한 설치 파일을 실행해 주세요. 설치 전 작업을 저장해 주세요."
                    : "새 버전 설치 파일을 다운로드합니다."}
              </p>
            </div>
          )}
          {release && (
            <>
              <p className="mt-2 text-xs text-stone-500">
                {release.published && `게시일 ${new Date(release.published).toLocaleDateString()}`}
              </p>
              <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-sm">
                {release.notes || "릴리즈 설명이 없습니다."}
              </pre>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
