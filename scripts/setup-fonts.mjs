import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(new URL("fonts-manifest.json", import.meta.url), "utf8"),
);
const output = path.join(root, "apps/desktop/src-tauri/resources/fonts");
const cache = path.join(root, ".cache/fonts");
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
for (const font of manifest) {
  for (const [file, url, expected] of [
    [font.file, font.url, font.sha256],
    [`${font.id}-LICENSE.txt`, font.licenseUrl, font.licenseSha256],
  ]) {
    let bytes;
    try {
      bytes = await readFile(path.join(cache, file));
    } catch {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Font download failed: ${response.status} ${file}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw new Error(`Font SHA-256 mismatch: ${file}`);
    await writeFile(path.join(cache, file), bytes);
    await writeFile(path.join(output, file), bytes);
  }
  console.log(`${font.name}: font and license verified`);
}
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
