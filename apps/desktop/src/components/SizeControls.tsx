import { useState } from "react";

export function SizeControls({
  label,
  width,
  height,
  disabled,
  onApply,
}: {
  label: string;
  width: number;
  height: number;
  disabled: boolean;
  onApply: (width: number, height: number) => void;
}) {
  const [w, setW] = useState(width.toFixed(1));
  const [h, setH] = useState(height.toFixed(1));
  const valid = Number.isFinite(+w) && +w > 0 && Number.isFinite(+h) && +h > 0;
  return (
    <form
      aria-label={`${label} 크기`}
      className="flex items-center gap-2 text-xs"
      onPointerDown={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !disabled) onApply(+w, +h);
      }}
    >
      <label>
        가로{" "}
        <input
          aria-label={`${label} 가로`}
          type="number"
          min="0.1"
          step="0.1"
          value={w}
          onChange={(e) => setW(e.target.value)}
          disabled={disabled}
          className="w-16 rounded border px-1 py-1"
        />
      </label>
      <label>
        세로{" "}
        <input
          aria-label={`${label} 세로`}
          type="number"
          min="0.1"
          step="0.1"
          value={h}
          onChange={(e) => setH(e.target.value)}
          disabled={disabled}
          className="w-16 rounded border px-1 py-1"
        />
      </label>
      <button
        type="submit"
        disabled={disabled || !valid}
        className="rounded border px-2 py-1 disabled:opacity-40"
      >
        크기 적용
      </button>
    </form>
  );
}
