import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, copyFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("현재 PDFium 배포는 Windows x64만 지원합니다.");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("./pdfium-manifest.json", import.meta.url), "utf8"),
);
const cache = path.join(root, ".cache", "pdfium-7881");
const archive = path.join(root, ".cache", "pdfium-win-x64.tgz");
await mkdir(cache, { recursive: true });
let bytes;
try {
  bytes = await readFile(archive);
} catch {
  const response = await fetch(manifest.url);
  if (!response.ok) throw new Error(`PDFium download failed: ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
}
if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256) {
  throw new Error("PDFium archive SHA-256 mismatch; refusing to extract.");
}
await writeFile(archive, bytes);
execFileSync("tar", ["-xzf", archive, "-C", cache]);
const output = path.join(root, "apps", "desktop", "src-tauri", "resources", "pdfium");
await mkdir(output, { recursive: true });
// An already loaded Windows DLL cannot be overwritten. Skip an identical copy.
const sourceDll = await readFile(path.join(cache, "bin", "pdfium.dll"));
let installedDll;
try {
  installedDll = await readFile(path.join(output, "pdfium.dll"));
} catch {
  /* First setup. */
}
if (!installedDll?.equals(sourceDll)) {
  await copyFile(path.join(cache, "bin", "pdfium.dll"), path.join(output, "pdfium.dll"));
}
await copyFile(path.join(cache, "LICENSE"), path.join(output, "LICENSE"));
await copyFile(path.join(cache, "VERSION"), path.join(output, "VERSION"));
await cp(path.join(cache, "licenses"), path.join(output, "licenses"), { recursive: true });
console.log(`PDFium ${manifest.version} ready (verified SHA-256).`);
