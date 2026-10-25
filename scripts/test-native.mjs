// PDFium bindings have process-global initialization; isolate native test cases.
import { spawnSync } from "node:child_process";
const target = process.argv[2];
if (!["corpus_smoke", "fonts_smoke"].includes(target))
  throw new Error("Unknown native test target");
const args = ["test", "-p", "pdf-core", "--locked", "--test", target];
const listing = spawnSync("cargo", [...args, "--", "--ignored", "--list"], { encoding: "utf8" });
if (listing.error) throw listing.error;
if (listing.status !== 0) {
  process.stderr.write(listing.stderr ?? "");
  process.exit(listing.status ?? 1);
}
const names = listing.stdout
  .split(/\r?\n/)
  .filter((line) => line.endsWith(": test"))
  .map((line) => line.slice(0, -6));
if (!names.length) throw new Error("No native tests found");
for (const name of names) {
  const result = spawnSync("cargo", [...args, name, "--", "--ignored", "--exact", "--nocapture"], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
