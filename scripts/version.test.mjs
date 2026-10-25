import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
test("release versions stay synchronized and reject a mismatched tag", async () => {
  await mkdir(resolve(root, ".cache"), { recursive: true });
  const fixture = await mkdtemp(resolve(root, ".cache/version-test-"));
  try {
    for (const file of [
      "scripts/version.mjs",
      "package.json",
      "apps/desktop/package.json",
      "apps/desktop/src-tauri/tauri.conf.json",
      "Cargo.toml",
      "Cargo.lock",
    ]) {
      await mkdir(dirname(resolve(fixture, file)), { recursive: true });
      await copyFile(resolve(root, file), resolve(fixture, file));
    }
    const run = (args = [], tag = "") =>
      spawnSync(process.execPath, [resolve(fixture, "scripts/version.mjs"), ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, RELEASE_TAG: tag },
      });
    assert.equal(run().status, 0);
    assert.equal(run([], "v999.0.0").status, 1);
    const changed = run(["0.2.3"]);
    assert.equal(changed.status, 0, changed.stderr);
    const { check, resolveConfig } = await import("prettier");
    const manifestPath = resolve(fixture, "package.json");
    assert(
      await check(await readFile(manifestPath, "utf8"), {
        ...(await resolveConfig(manifestPath)),
        filepath: manifestPath,
      }),
      "version bumps must preserve package.json formatting for CI",
    );
    assert.equal(run([], "v0.2.3").status, 0);
    assert.equal(
      JSON.parse(await readFile(resolve(fixture, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"))
        .version,
      "0.2.3",
    );
    const before = await readFile(resolve(fixture, "Cargo.lock"), "utf8");
    assert.equal(run(["invalid"]).status, 1);
    assert.equal(await readFile(resolve(fixture, "Cargo.lock"), "utf8"), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
