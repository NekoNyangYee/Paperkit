export function canvasContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이미지를 생성할 수 없습니다. 다시 시도해 주세요.");
  return context;
}

export function canvasPng(canvas: HTMLCanvasElement) {
  const url = canvas.toDataURL("image/png");
  if (!url.startsWith("data:image/png;base64,")) throw new Error("이미지를 생성하지 못했습니다.");
  return {
    url,
    png: Array.from(atob(url.split(",")[1]), (char) => char.charCodeAt(0)),
    width: canvas.width,
    height: canvas.height,
  };
}

// Crop transparent margins so every signature gets the same useful default size.
export function signaturePng(canvas: HTMLCanvasElement) {
  const { width, height } = canvas;
  const pixels = canvasContext(canvas).getImageData(0, 0, width, height).data;
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left) throw new Error("먼저 서명을 그려 주세요.");
  const margin = 6;
  left = Math.max(0, left - margin);
  top = Math.max(0, top - margin);
  right = Math.min(width - 1, right + margin);
  bottom = Math.min(height - 1, bottom + margin);
  const cropped = document.createElement("canvas");
  cropped.width = right - left + 1;
  cropped.height = bottom - top + 1;
  canvasContext(cropped).drawImage(
    canvas,
    left,
    top,
    cropped.width,
    cropped.height,
    0,
    0,
    cropped.width,
    cropped.height,
  );
  return canvasPng(cropped);
}
