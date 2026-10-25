import { isDesktop } from "./files";

export interface TabView {
  pageIndex: number;
  zoom: number;
  sidebarOpen: boolean;
}
export interface SavedWorkspace {
  version: 1;
  tabs: { id: string; path: string | null; view?: TabView }[];
  activeTabId: string;
}
let storePromise: Promise<import("@tauri-apps/plugin-store").Store> | undefined;
let writes = Promise.resolve();
function workspaceStore() {
  return (storePromise ??= import("@tauri-apps/plugin-store")
    .then(({ load }) => load("workspace.json", { autoSave: 150 }))
    .catch((cause) => {
      storePromise = undefined;
      throw cause;
    }));
}
export function parseWorkspace(value: unknown): SavedWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Partial<SavedWorkspace>;
  if (saved.version !== 1 || !Array.isArray(saved.tabs) || typeof saved.activeTabId !== "string")
    return null;
  const ids = new Set<string>();
  const tabs: SavedWorkspace["tabs"] = [];
  for (const tab of saved.tabs) {
    if (!tab || typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) continue;
    if (tab.path !== null && (typeof tab.path !== "string" || !tab.path.trim())) continue;
    ids.add(tab.id);
    const view = tab.view;
    tabs.push({
      id: tab.id,
      path: tab.path,
      ...(view &&
      Number.isSafeInteger(view.pageIndex) &&
      view.pageIndex >= 0 &&
      Number.isFinite(view.zoom) &&
      view.zoom >= 25 &&
      view.zoom <= 400 &&
      typeof view.sidebarOpen === "boolean"
        ? { view }
        : {}),
    });
  }
  return { version: 1, tabs, activeTabId: saved.activeTabId };
}
export async function readWorkspace() {
  if (!isDesktop()) return null;
  return parseWorkspace(await (await workspaceStore()).get<unknown>("workspace"));
}
export function writeWorkspace(workspace: SavedWorkspace) {
  if (!isDesktop()) return Promise.resolve();
  const write = writes
    .catch(() => {})
    .then(async () => {
      await (await workspaceStore()).set("workspace", workspace);
    });
  writes = write;
  return write;
}
export async function flushWorkspace() {
  await writes.catch(() => {});
  if (storePromise) await (await storePromise).save();
}
