import { spawnSync } from "node:child_process";
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
