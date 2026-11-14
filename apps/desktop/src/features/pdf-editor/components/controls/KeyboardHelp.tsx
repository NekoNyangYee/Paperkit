import { Keyboard } from "lucide-react";
import { IconButton } from "@/shared/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";

const shortcuts = [
  ["Delete / Backspace", "선택 요소 삭제"],
  ["Ctrl+C / X / V", "복사 · 잘라내기 · 붙여넣기"],
  ["Ctrl+Z / Ctrl+Shift+Z", "실행 취소 · 다시 실행"],
  ["Ctrl+Y", "다시 실행"],
  ["방향키 / Shift+방향키", "선택 요소 1 / 10 pt 이동"],
  ["F2 / Enter", "선택 문구 수정"],
  ["Enter / Shift+Enter", "문구 반영 · 줄바꿈"],
  ["Ctrl+A", "입력 중인 문구 전체 선택"],
  ["Ctrl+S", "새 PDF로 저장"],
  ["Ctrl+＋ / － / 0", "확대 · 축소 · 100%"],
  ["Escape", "편집 취소 · 선택 해제"],
];
export function KeyboardHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton icon={Keyboard} label="단축키" />
      </PopoverTrigger>
      <PopoverContent className="w-[min(92vw,400px)] p-4" align="end">
        <h2 className="mb-3 text-sm font-semibold">단축키</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-xs">
          {shortcuts.map(([key, action]) => (
            <div key={key} className="contents">
              <dt className="font-medium text-stone-700">{key}</dt>
              <dd className="text-stone-500">{action}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
