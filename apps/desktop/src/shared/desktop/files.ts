import { invoke, isTauri } from "@tauri-apps/api/core";

export interface FileInfo {
  id: string;
  path: string;
  name: string;
  sizeBytes: number;
}

export function isDesktop(): boolean {
  return isTauri();
}

export function errorMessage(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  )
    return cause.message;
  return typeof cause === "string"
    ? cause
    : "파일 확인 중 오류가 발생했습니다. 다시 시도해 주세요.";
}

function parseFile(result: unknown): FileInfo {
  if (
    typeof result !== "object" ||
    result === null ||
    !("id" in result) ||
    typeof result.id !== "string" ||
    !("path" in result) ||
    typeof result.path !== "string" ||
    !("name" in result) ||
    typeof result.name !== "string" ||
    !("sizeBytes" in result) ||
    typeof result.sizeBytes !== "number" ||
    !Number.isSafeInteger(result.sizeBytes) ||
    result.sizeBytes <= 0
  )
    throw new Error("파일 정보 응답이 올바르지 않습니다.");
  return { id: result.id, path: result.path, name: result.name, sizeBytes: result.sizeBytes };
}

export interface SelectionSnapshot {
  revision: number;
  file: FileInfo | null;
  error: string | null;
}

async function selectionCommand(
  command: string,
  args?: Record<string, unknown>,
): Promise<SelectionSnapshot> {
  const result = await invoke<unknown>(command, args);
  if (
    typeof result !== "object" ||
    result === null ||
    !("revision" in result) ||
    typeof result.revision !== "number" ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 0 ||
    !("file" in result)
  ) {
    throw new Error("파일 선택 상태 응답이 올바르지 않습니다.");
  }
  if (!("error" in result)) throw new Error("파일 선택 오류 응답이 올바르지 않습니다.");
  return {
    revision: result.revision,
    file: result.file === null ? null : parseFile(result.file),
    error: result.error === null ? null : errorMessage(result.error),
  };
}

export const synchronizeSelection = () => selectionCommand("synchronize_selection");
export const inspectFile = (paths: string[], revision: number) =>
  selectionCommand("receive_file_input", { paths, revision });
export const clearSelection = (revision: number) =>
  selectionCommand("clear_selection", { revision });
