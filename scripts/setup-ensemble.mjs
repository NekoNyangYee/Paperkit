// All runtime assets are local. No PDF, image or OCR text is sent to a service.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, cp, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("ensemble-manifest.json", import.meta.url), "utf8"),
);
const cache = path.join(root, ".cache", "ensemble-downloads");
await mkdir(cache, { recursive: true });
async function verified(url, name, expected) {
  const destination = path.join(cache, name);
  let bytes;
  try {
    bytes = await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Engine download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`SHA-256 mismatch: ${name}`);
  await writeFile(destination, bytes);
  return destination;
}

if (
  !process.argv.includes("--ocr-only") &&
  process.platform === "win32" &&
  process.arch === "x64"
) {
  const archive = await verified(manifest.qpdf.url, "qpdf.zip", manifest.qpdf.sha256);
  const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split(/\r?\n/);
  if (
    entries.some(
      (entry) =>
        entry.startsWith("/") ||
        entry.includes("\\") ||
        entry.split("/").includes("..") ||
        !entry.startsWith(`${manifest.qpdf.directory}/`),
    )
  )
    throw new Error("Unexpected archive path");
  execFileSync("tar", ["-xf", archive, "-C", cache]);
  const source = path.join(cache, manifest.qpdf.directory);
  const output = path.join(root, "apps/desktop/src-tauri/resources/qpdf");
  await mkdir(output, { recursive: true });
  await cp(path.join(source, "bin"), path.join(output, "bin"), { recursive: true });
  // Keep the upstream redistribution notices alongside the binaries.
  await cp(path.join(source, "share/doc/qpdf"), path.join(output, "licenses"), {
    recursive: true,
    filter: (name) => !path.basename(name).startsWith("manual"),
  });
  await copyFile(
    path.join(source, "share/doc/qpdf/manual-html/_sources/license.rst.txt"),
    path.join(output, "licenses/license.rst.txt"),
  );
  await writeFile(
    path.join(output, "licenses/COPYRIGHT.txt"),
    execFileSync(path.join(output, "bin/qpdf.exe"), ["--copyright"], { windowsHide: true }),
  );
  await writeFile(path.join(output, "VERSION"), `${manifest.qpdf.version}\n`);
  console.log(`qpdf ${manifest.qpdf.version} ready (verified SHA-256).`);
}

if (process.argv.includes("--native-only")) process.exit(0);

const output = path.join(root, "apps/desktop/public/ocr");
await mkdir(output, { recursive: true });
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const engine = path.dirname(require.resolve("tesseract.js/package.json"));
const core = path.dirname(
  createRequire(path.join(engine, "package.json")).resolve("tesseract.js-core/package.json"),
);
await copyFile(path.join(engine, "dist/worker.min.js"), path.join(output, "worker.min.js"));
await copyFile(path.join(engine, "LICENSE.md"), path.join(output, "LICENSE-tesseract-js.md"));
for (const name of await readdir(core)) {
  if (name.endsWith(".wasm") || name.endsWith(".wasm.js") || name.startsWith("LICENSE"))
    await copyFile(path.join(core, name), path.join(output, name));
}
for (const language of ["eng", "kor"]) {
  const model = await verified(
    `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${manifest.models.revision}/${language}.traineddata`,
    `${language}.traineddata`,
    manifest.models[language],
  );
  await copyFile(model, path.join(output, `${language}.traineddata`));
}
await writeFile(
  path.join(output, "MODEL-SOURCE.txt"),
  `Tesseract tessdata_fast (Apache-2.0)\nhttps://github.com/tesseract-ocr/tessdata_fast/tree/${manifest.models.revision}\n`,
);
console.log("Local English/Korean OCR ready (verified SHA-256).");
