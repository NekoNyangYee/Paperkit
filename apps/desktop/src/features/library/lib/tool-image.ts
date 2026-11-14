import { UserFacingError } from "@/shared/lib/errors";

// Shared image preparation for creating and editing saved tools.
export async function readToolImage(file: File): Promise<string> {
  if (file.size > 8 * 1024 * 1024) throw new UserFacingError("8 MB 이하의 이미지를 선택해 주세요.");
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16_777_216)
      throw new UserFacingError("이미지 크기를 조금 줄여 다시 선택해 주세요.");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("이미지를 읽지 못했습니다.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    if (url.length > 1_398_126)
      throw new UserFacingError("이미지 크기를 조금 줄여 다시 선택해 주세요.");
    return url;
  } finally {
    bitmap.close();
  }
}
