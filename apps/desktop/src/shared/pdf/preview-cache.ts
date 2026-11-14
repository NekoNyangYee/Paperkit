import type { EditAction, EditState, PreviewPage } from "./types";

export interface CachedPreview {
  page: PreviewPage;
  // Retain the decoded bitmap so returning to a page does not decode its PNG again.
  image?: HTMLImageElement;
}
interface Entry {
  fileId: string;
  pageIndex: number;
  promise: Promise<CachedPreview>;
  value?: CachedPreview;
  bytes: number;
}

/** A bounded, memory-only LRU shared by open documents. Never writes PDF data to disk. */
export class PreviewCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(
    private maxBytes = 128 * 1024 * 1024,
    private maxEntries = 32,
  ) {}

  private key(fileId: string, pageIndex: number, width: number) {
    return JSON.stringify([fileId, pageIndex, width]);
  }
  private touch(key: string, entry: Entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  private remove(key: string, entry: Entry) {
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  get(fileId: string, pageIndex: number, width: number) {
    const key = this.key(fileId, pageIndex, width);
    const entry = this.entries.get(key);
    if (entry?.value) this.touch(key, entry);
    return entry?.value;
  }
  load(fileId: string, pageIndex: number, width: number, read: () => Promise<CachedPreview>) {
    const key = this.key(fileId, pageIndex, width);
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing.value ? Promise.resolve(existing.value) : existing.promise;
    }
    const entry: Entry = { fileId, pageIndex, bytes: 0, promise: undefined! };
    entry.promise = Promise.resolve()
      .then(read)
      .then((value) => {
        // Closing/editing can invalidate a render while Rust or image.decode is still running.
        if (this.entries.get(key) === entry) {
          entry.value = value;
          entry.bytes =
            value.page.width * value.page.height * 4 +
            2 * (value.page.imageUrl.length + JSON.stringify(value.page.text).length);
          this.bytes += entry.bytes;
          this.touch(key, entry);
          this.trim();
        }
        return value;
      })
      .catch((cause) => {
        if (this.entries.get(key) === entry) this.remove(key, entry);
        throw cause;
      });
    this.entries.set(key, entry);
    return entry.promise;
  }
  private trim() {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes && this.entries.size <= this.maxEntries) break;
      if (entry.value) this.remove(key, entry);
    }
  }
  clearFile(fileId: string) {
    for (const [key, entry] of this.entries) if (entry.fileId === fileId) this.remove(key, entry);
  }
  applyEdit(fileId: string, action: EditAction, state: EditState) {
    const global = ["page", "undo", "redo", "addWatermark", "removeWatermark"].includes(
      action.kind,
    );
    for (const [key, entry] of this.entries) {
      if (entry.fileId !== fileId) continue;
      if (global || !entry.value || ("page" in action && entry.pageIndex === action.page)) {
        this.remove(key, entry);
      } else {
        // History/dirty/revision belong to the document, even when its bitmap is unchanged.
        entry.value = { ...entry.value, page: { ...entry.value.page, state } };
      }
    }
  }
}

export const previewCache = new PreviewCache();
