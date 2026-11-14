import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = path.join(root, ".cache/ensemble-fixtures");
for (const target of [
  ["--lib", "qpdf_repairs_broken_xref"],
  ["--test", "ensemble_smoke"],
]) {
  const result = spawnSync(
    "cargo",
    ["test", "-p", "pdf-core", "--locked", ...target, "--", "--ignored", "--nocapture"],
    { cwd: root, env: { ...process.env, PAPERKIT_ENSEMBLE_FIXTURES: fixtures }, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const { createWorker, OEM, PSM } = require("tesseract.js");
const worker = await createWorker(["kor", "eng"], OEM.LSTM_ONLY, {
  langPath: path.join(root, "apps/desktop/public/ocr"),
  gzip: false,
  cacheMethod: "none",
  errorHandler: () => {},
});
async function recognize(image) {
  await worker.setParameters({ user_defined_dpi: "180", tessedit_pageseg_mode: PSM.AUTO });
  let { data } = await worker.recognize(image);
  if (!data.text.trim() || data.confidence < 65) {
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
    const alternate = await worker.recognize(image);
    if (
      alternate.data.text.trim() &&
      (!data.text.trim() || alternate.data.confidence > data.confidence)
    )
      data = alternate.data;
  }
  return data;
}
try {
  const data = await recognize(path.join(fixtures, "ocr.png"));
  if (!data.text.includes("PAPERKIT INVOICE 12345"))
    throw new Error(`OCR fixture mismatch: ${data.text}`);
  console.log(`Offline Korean/English OCR passed (confidence ${Math.round(data.confidence)}).`);
  const korean = await recognize(path.join(fixtures, "ocr-kor.png"));
  if (!korean.text.replace(/\s+/g, "").includes("한글문서확인"))
    throw new Error(`Korean OCR fixture mismatch: ${korean.text}`);
  console.log(`Korean OCR passed (confidence ${Math.round(korean.confidence)}).`);
} finally {
  await worker.terminate();
}
