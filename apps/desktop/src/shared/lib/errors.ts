export type ErrorContext =
  | "general"
  | "startup"
  | "file"
  | "preview"
  | "edit"
  | "save"
  | "font"
  | "image"
  | "library"
  | "tools"
  | "update"
  | "favorite"
  | "remove"
  | "toolSave"
  | "toolRemove"
  | "clipboard"
  | "signature"
  | "watermark"
  | "extract";

export const errorFallbacks: Record<ErrorContext, string> = {
  general: "작업을 마치지 못했어요. 잠시 후 다시 시도해 주세요.",
  startup: "파일 열기를 준비하지 못했어요. 다시 연결을 눌러 주세요.",
  file: "파일을 열지 못했어요. 파일을 다시 선택해 주세요.",
  preview: "페이지를 아직 표시하지 못했어요. 다시 불러와 주세요.",
  edit: "변경을 적용하지 못했어요. 입력한 내용을 확인한 뒤 다시 시도해 주세요.",
  save: "저장을 마치지 못했어요. 다른 이름이나 폴더를 선택해 주세요.",
  font: "글꼴을 준비하지 못했어요. 다른 글꼴을 선택하거나 다시 불러와 주세요.",
  image: "이미지를 열지 못했어요. 다른 이미지 파일을 선택해 주세요.",
  library: "문서함을 잠시 불러올 수 없어요. 파일 선택으로 작업을 계속할 수 있습니다.",
  tools: "도구함을 잠시 불러올 수 없어요. 잠시 후 다시 시도해 주세요.",
  update: "업데이트를 확인하지 못했어요. 지금 버전으로 계속 사용하고 나중에 다시 시도해 주세요.",
  favorite: "즐겨찾기를 바꾸지 못했어요. 잠시 후 다시 눌러 주세요.",
  remove: "문서를 목록에서 지우지 못했어요. 잠시 후 다시 시도해 주세요.",
  toolSave: "도구를 보관하지 못했어요. 입력한 내용을 확인한 뒤 다시 시도해 주세요.",
  toolRemove: "도구를 지우지 못했어요. 잠시 후 다시 시도해 주세요.",
  clipboard: "복사한 내용을 가져오지 못했어요. 다시 복사하거나 이미지 삽입을 이용해 주세요.",
  signature: "서명을 넣지 못했어요. 그린 서명을 확인한 뒤 다시 눌러 주세요.",
  watermark: "워터마크를 적용하지 못했어요. 설정을 확인한 뒤 다시 눌러 주세요.",
  extract: "페이지 글자를 읽지 못했어요. 잠시 후 다시 시도해 주세요.",
};

// Only messages authored for the UI opt in to being displayed as-is.
export class UserFacingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserFacingError";
  }
}

// For internal decisions only; never render arbitrary native/network exception text.
export function errorDetail(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string")
    return cause.message;
  return "";
}

export function userErrorMessage(cause: unknown, context: ErrorContext = "general"): string {
  if (cause instanceof UserFacingError) return cause.message;
  const detail = errorDetail(cause);
  const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
  if (code === "fileCount" || /PDF 한 개만/.test(detail)) return "PDF를 한 개씩 선택해 주세요.";
  if (code === "notFound" || /파일을 찾을 수 없|파일이 이동/.test(detail))
    return "파일 위치가 바뀐 것 같아요. 파일 선택에서 다시 열어 주세요.";
  if (code === "permissionDenied" || /읽을 권한|접근 권한/.test(detail))
    return "이 파일에 접근할 수 없어요. 열 수 있는 폴더로 복사한 뒤 다시 선택해 주세요.";
  if (
    code === "notAFile" ||
    code === "notPdfExtension" ||
    code === "invalidHeader" ||
    /폴더 대신|확장자가|PDF 헤더/.test(detail)
  )
    return "PDF 파일인지 확인하고 다시 선택해 주세요.";
  if (code === "emptyFile" || /빈 파일|내용이 없는/.test(detail))
    return "파일에 내용이 없는 것 같아요. 다른 PDF를 선택해 주세요.";
  if (/암호가 필요|password/i.test(detail))
    return "암호로 보호된 PDF예요. 암호가 해제된 사본을 선택해 주세요.";
  if (/이미 존재하는 파일|already exists/i.test(detail))
    return "같은 이름의 파일이 있어요. 다른 이름으로 저장해 주세요.";
  if (/원본 글꼴에 입력한 문자가 없|선택한 글꼴에 없는 문자/.test(detail))
    return "이 글꼴로 표시할 수 없는 글자가 있어요. 다른 글꼴을 선택해 주세요.";
  if (/원본 글꼴 데이터를 사용할 수 없/.test(detail))
    return "이 문서의 글꼴을 준비하지 못했어요. 원본 글꼴을 불러오거나 다른 글꼴을 선택해 주세요.";
  if (
    /페이지 경계|페이지 공간이 부족|고정 셀 범위|셀 경계|블록 범위를 벗어|영역을 벗어/.test(detail)
  )
    return "내용을 넣을 공간이 부족해요. 문단 너비나 글자 크기를 조절해 주세요.";
  if (/글자 수와 공백 위치/.test(detail))
    return "문장 길이를 바꾸려면 문단 블록을 선택해 수정해 주세요.";
  if (/검증|보존에 실패|선택하지 않은 영역|수정하지 않은 다른 글자/.test(detail))
    return "문서 모양을 유지하기 어려워 이번 변경은 적용하지 않았어요. 다른 글꼴이나 편집 범위로 다시 시도해 주세요.";
  if (/다른 페이지를 처리|Service busy|database.*locked/i.test(detail))
    return "앞선 작업을 마무리하고 있어요. 잠시 후 다시 시도해 주세요.";
  if (/마지막 한 페이지/.test(detail))
    return "문서에는 한 페이지가 필요해요. 다른 페이지를 추가한 뒤 삭제해 주세요.";
  if (/먼저 서명을/.test(detail)) return "서명을 그린 뒤 다시 눌러 주세요.";
  if (/(?:\d+\s*MB 이하|이미지 크기가 너무|텍스트를 조금 줄여|최대.*도구)/.test(detail))
    return context === "image" || context === "tools"
      ? "파일 크기나 내용을 조금 줄여 다시 시도해 주세요."
      : "조금 더 작은 PDF 파일을 선택해 주세요.";
  if (
    typeof navigator !== "undefined" &&
    navigator.onLine === false &&
    ["library", "tools", "update"].includes(context)
  )
    return context === "library"
      ? "지금은 인터넷에 연결되지 않았어요. 파일 선택으로 작업을 계속할 수 있습니다."
      : "지금은 인터넷에 연결되지 않았어요. 연결되면 다시 시도해 주세요.";
  return errorFallbacks[context];
}
