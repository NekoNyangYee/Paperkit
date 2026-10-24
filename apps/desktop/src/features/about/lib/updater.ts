import { Channel, invoke } from "@tauri-apps/api/core";

export type UpdateProgress = { downloaded: number; total: number | null };

export async function downloadUpdate(tag: string, onProgress: (value: UpdateProgress) => void) {
  const progress = new Channel<UpdateProgress>();
  progress.onmessage = onProgress;
  await invoke("download_update", { tag, progress });
}

export async function installUpdate() {
  await invoke("install_update");
}
