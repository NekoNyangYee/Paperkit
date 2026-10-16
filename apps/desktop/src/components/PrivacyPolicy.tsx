import { useState } from "react";
import Markdown from "react-markdown";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";
import policy from "../content/privacy-policy.md?raw";

export function PrivacyPolicy() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="cursor-pointer rounded text-xs text-stone-500 underline underline-offset-4 hover:text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-700"
        onClick={() => setOpen(true)}
      >
        개인정보 처리방침
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex w-[min(92vw,760px)] flex-col overflow-hidden p-0">
          <header className="flex shrink-0 items-center justify-between gap-4 border-b border-stone-200 px-6 py-4">
            <div>
              <DialogTitle className="text-lg font-semibold">개인정보 처리방침</DialogTitle>
              <DialogDescription className="mt-1 text-xs text-stone-500">
                Paperkit의 정보 처리와 사용자 선택을 안내합니다.
              </DialogDescription>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 cursor-pointer rounded-lg border border-stone-200 px-3 py-2 text-sm hover:bg-stone-100"
            >
              닫기
            </button>
          </header>
          <article
            aria-label="개인정보 처리방침 내용"
            tabIndex={0}
            className="release-notes min-h-0 overflow-auto px-6 py-5 text-sm leading-7"
          >
            <Markdown skipHtml>{policy}</Markdown>
          </article>
        </DialogContent>
      </Dialog>
    </>
  );
}
