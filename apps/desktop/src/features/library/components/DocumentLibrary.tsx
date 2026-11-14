import { useEffect, useState } from "react";
import { FileText, Search, Star, Trash2, RefreshCw } from "lucide-react";
import { useAuthStore } from "@/features/auth/model/auth-store";
import { useFileStore } from "@/features/file-input/model/file-store";
import { isDesktop } from "@/shared/desktop/files";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { IconButton } from "@/shared/ui/icon-button";
import { useConfirmDialog } from "@/shared/ui/confirm-dialog";
import { getDocuments, libraryRequest, type LibraryDocument } from "../lib/api";
import { LibrarySignIn } from "./LibrarySignIn";
import { useDocumentStatus } from "../model/document-status";
import { userErrorMessage } from "@/shared/lib/errors";

function size(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const date = new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric" });

export function DocumentLibrary() {
  const owner = useAuthStore((s) => s.session?.user.id);
  if (!owner) return null;
  // Remount when accounts change so another user's search and document list never persist.
  return <DocumentLibraryContent key={owner} owner={owner} />;
}
function DocumentLibraryContent({ owner }: { owner?: string }) {
  const accessToken = useAuthStore((state) => state.session?.access_token);
  const syncRevision = useDocumentStatus((state) => (state.owner === owner ? state.revision : 0));
  const syncError = useDocumentStatus((state) => (state.owner === owner ? state.error : null));
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState(false);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(!!owner);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const ready = useFileStore((s) => s.ready);
  const phase = useFileStore((s) => s.phase);
  const removeDialog = useConfirmDialog({
    title: "문서함에서 제거",
    description:
      "내 문서함의 기록과 서버 복구본을 제거합니다. 컴퓨터에 있는 원본 PDF는 유지됩니다.",
    confirmLabel: "제거",
  });
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(query.trim());
      setOffset(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!owner) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      q: search,
      favorites: String(favorites),
      offset: String(offset),
    });
    void getDocuments(params, controller.signal, owner)
      .then((values) => {
        if (controller.signal.aborted) return;
        setDocuments((previous) =>
          offset
            ? [...previous, ...values.filter((v) => !previous.some((d) => d.id === v.id))]
            : values,
        );
        setMore(values.length === 50);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(userErrorMessage(cause, "library"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [owner, accessToken, search, favorites, offset, revision, syncRevision]);

  async function toggleFavorite(document: LibraryDocument) {
    setWorking(document.id);
    setError(null);
    try {
      await libraryRequest(
        `/documents/${document.id}/favorite`,
        { method: "PUT", body: JSON.stringify({ favorite: !document.favorite }) },
        owner,
      );
      setOffset(0);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(userErrorMessage(cause, "favorite"));
    } finally {
      setWorking(null);
    }
  }
  async function remove(document: LibraryDocument) {
    if (!(await removeDialog.confirm())) return;
    setWorking(document.id);
    setError(null);
    try {
      await libraryRequest(`/documents/${document.id}`, { method: "DELETE" }, owner);
      setOffset(0);
      setRevision((v) => v + 1);
    } catch (cause) {
      setError(userErrorMessage(cause, "remove"));
    } finally {
      setWorking(null);
    }
  }

  return (
    <section aria-labelledby="library-title" className="min-w-0 border-t border-stone-300/80 pt-6">
      {removeDialog.dialog}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="library-title" className="text-base font-semibold">
          내 문서함
        </h2>
        {owner && (
          <div className="flex items-center gap-2">
            <div
              className="flex items-center rounded-md bg-stone-200/60 p-0.5"
              aria-label="문서 필터"
            >
              {[
                [false, "전체"],
                [true, "즐겨찾기"],
              ].map(([value, label]) => (
                <button
                  key={String(value)}
                  type="button"
                  aria-pressed={favorites === value}
                  onClick={() => {
                    setFavorites(value as boolean);
                    setOffset(0);
                  }}
                  className={`rounded px-2.5 py-1 text-xs ${favorites === value ? "bg-white font-medium text-stone-800 shadow-sm" : "text-stone-500 hover:text-stone-800"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <IconButton
              icon={RefreshCw}
              label="문서함 새로고침"
              disabled={loading || !!working}
              onClick={() => {
                setOffset(0);
                setRevision((v) => v + 1);
              }}
            />
          </div>
        )}
      </div>
      {!owner ? (
        <LibrarySignIn />
      ) : (
        <>
          <label className="relative mt-4 block">
            <Search
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400"
            />
            <Input
              type="search"
              maxLength={255}
              aria-label="내 문서 검색"
              placeholder="문서 이름으로 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-9 bg-white/70 pl-9 text-sm"
            />
          </label>
          {(error || syncError) && (
            <div
              role="alert"
              className="mt-3 flex items-center justify-between gap-2 text-xs text-stone-600"
            >
              <span>{error ?? syncError}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setOffset(0);
                  setRevision((v) => v + 1);
                }}
              >
                다시 시도
              </Button>
            </div>
          )}
          <div aria-busy={loading} className="mt-3">
            {!loading && !error && documents.length === 0 && (
              <div className="py-9 text-center text-sm text-stone-500">
                <FileText
                  size={25}
                  strokeWidth={1.3}
                  className="mx-auto mb-3 text-stone-400"
                  aria-hidden="true"
                />
                <p>
                  {search
                    ? "검색한 문서가 없습니다."
                    : favorites
                      ? "즐겨찾기한 문서가 없습니다."
                      : "아직 열어본 문서가 없습니다."}
                </p>
              </div>
            )}
            {documents.map((document) => (
              <div
                key={document.id}
                className="group flex items-center gap-2 border-b border-stone-200/80 py-2.5 last:border-0"
              >
                <FileText
                  size={20}
                  strokeWidth={1.5}
                  className="ml-1 shrink-0 text-stone-400"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  title={document.sourcePath}
                  disabled={!isDesktop() || !ready || phase === "checking" || !!working || loading}
                  onClick={() => void useFileStore.getState().receive([document.sourcePath])}
                  className="min-w-0 flex-1 rounded px-1.5 py-1 text-left hover:text-emerald-800 focus-visible:outline-emerald-700 disabled:opacity-50"
                >
                  <span className="block truncate text-sm font-medium">{document.displayName}</span>
                  <span className="mt-1 block truncate text-[11px] text-stone-400">
                    {document.sourcePath.replace(/[/\\][^/\\]+$/, "")}
                  </span>
                </button>
                <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-stone-400 sm:block">
                  {size(document.sizeBytes)}
                </span>
                <span className="hidden w-20 shrink-0 text-right text-xs text-stone-400 sm:block">
                  {date.format(document.lastOpenedAt)}
                </span>
                <IconButton
                  icon={Star}
                  label={`${document.displayName} 즐겨찾기`}
                  aria-pressed={document.favorite}
                  disabled={!!working || loading}
                  className={
                    document.favorite
                      ? "text-amber-600 [&_svg]:fill-amber-100"
                      : "text-stone-300 hover:text-stone-600"
                  }
                  onClick={() => void toggleFavorite(document)}
                />
                <IconButton
                  icon={Trash2}
                  label={`${document.displayName} 문서함에서 제거`}
                  disabled={!!working || loading}
                  className="text-stone-400 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                  onClick={() => void remove(document)}
                />
              </div>
            ))}
            {loading && (
              <p role="status" className="py-6 text-center text-xs text-stone-500">
                문서 목록을 불러오는 중…
              </p>
            )}
            {more && !loading && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setOffset(documents.length)}
              >
                더 보기
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
