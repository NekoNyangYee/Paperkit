import { canvasContext, canvasPng } from "./canvas";

export interface WatermarkOptions {
  kind: "text" | "image";
  text: string;
  image: File | null;
  opacity: number;
  angle: number;
  color: string;
  date: string | null;
}

export const DEFAULT_WATERMARK_OPTIONS: WatermarkOptions = {
  kind: "text",
  text: "CONFIDENTIAL",
  image: null,
  opacity: 25,
  angle: -30,
  color: "#64748b",
  date: null,
};

export const WATERMARK_MODE_DEFAULTS = {
  text: { size: 60, angle: -30 },
  image: { size: 80, angle: 0 },
} as const;

export type WatermarkContent = Pick<WatermarkOptions, "kind" | "text" | "image" | "color" | "date">;

export function watermarkText(options: Pick<WatermarkOptions, "text" | "date">) {
  return [options.text.trim(), options.date].filter(Boolean).join(" ");
}

// Rasterize content once; preview adjustments use CSS until the user applies them.
export async function watermarkSource(options: WatermarkContent) {
  const source = document.createElement("canvas");
  if (options.kind === "text") {
    const text = watermarkText(options);
    if (!text) throw new Error("워터마크 텍스트를 입력해 주세요.");
    await document.fonts?.ready;
    const lines = text.split(/\r?\n/);
    const font = '600 72px system-ui, "Malgun Gothic", sans-serif';
    const measure = canvasContext(source);
    measure.font = font;
    source.width =
      Math.ceil(Math.max(...lines.map((line) => measure.measureText(line).width))) + 32;
    source.height = lines.length * 96 + 16;
    if (source.width > 12000 || source.height > 2000) throw new Error("텍스트를 조금 줄여 주세요.");
    const context = canvasContext(source);
    context.font = font;
    context.fillStyle = options.color;
    context.textAlign = "center";
    context.textBaseline = "middle";
    lines.forEach((line, index) => context.fillText(line, source.width / 2, 8 + 48 + index * 96));
  } else {
    if (!options.image) throw new Error("워터마크 이미지 파일을 선택해 주세요.");
    if (options.image.size > 32 * 1024 * 1024)
      throw new Error("32 MB 이하의 이미지를 사용해 주세요.");
    const bitmap = await createImageBitmap(options.image);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16 * 1024 * 1024)
        throw new Error("이미지 크기가 너무 큽니다.");
      const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
      source.width = Math.max(1, Math.round(bitmap.width * scale));
      source.height = Math.max(1, Math.round(bitmap.height * scale));
      canvasContext(source).drawImage(bitmap, 0, 0, source.width, source.height);
    } finally {
      bitmap.close();
    }
  }
  const scale = Math.min(1, 1200 / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvasContext(canvas).drawImage(source, 0, 0, canvas.width, canvas.height);
  return { canvas, width: canvas.width, height: canvas.height, url: canvas.toDataURL("image/png") };
}

export function watermarkBounds(width: number, height: number, degrees: number) {
  const angle = (degrees * Math.PI) / 180;
  return {
    width: Math.max(
      1,
      Math.ceil(Math.abs(width * Math.cos(angle)) + Math.abs(height * Math.sin(angle))),
    ),
    height: Math.max(
      1,
      Math.ceil(Math.abs(width * Math.sin(angle)) + Math.abs(height * Math.cos(angle))),
    ),
  };
}

export async function watermarkPng(
  options: WatermarkOptions,
  source?: Awaited<ReturnType<typeof watermarkSource>>,
) {
  const content = source ?? (await watermarkSource(options));
  const { width, height } = content;
  const bounds = watermarkBounds(width, height, options.angle);
  const output = document.createElement("canvas");
  output.width = bounds.width;
  output.height = bounds.height;
  const context = canvasContext(output);
  context.translate(output.width / 2, output.height / 2);
  context.rotate((options.angle * Math.PI) / 180);
  context.globalAlpha = options.opacity / 100;
  context.drawImage(content.canvas, -width / 2, -height / 2, width, height);
  return canvasPng(output);
}
