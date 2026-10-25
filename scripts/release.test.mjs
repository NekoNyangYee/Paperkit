import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const commit = "a".repeat(40);
const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]);
const primaryShell =
  process.env.PAPERKIT_TEST_POWERSHELL ??
  (process.platform === "win32" && probe.error?.code === "ENOENT" ? "powershell.exe" : "pwsh");
const shells = [
  ...new Set([primaryShell, ...(process.platform === "win32" ? ["powershell.exe"] : [])]),
];
const harness = String.raw`
param([string]$Script, [string]$Root, [string]$Scenario, [string]$Log)
$ErrorActionPreference = 'Stop'
$env:GH_REPO = 'example/paperkit'
function global:gh {
    $call = @($args)
    Add-Content -LiteralPath $Log -Value (ConvertTo-Json -InputObject $call -Compress)
    $global:LASTEXITCODE = 0
    if ($call[0] -eq 'api') {
        if ($Scenario -eq 'api-error') {
            $global:LASTEXITCODE = 1
            return '{"status":403}'
        }
        if ($call[1] -like '*/releases/tags/*') {
            if ($Scenario -eq 'published') { return '{"draft":false}' }
            if ($Scenario -eq 'draft') { return '{"draft":true}' }
        } elseif ($call[1] -like '*/git/ref/tags/*') {
            if ($Scenario -in @('tag-conflict', 'existing-tag')) {
                return '{"ref":"refs/tags/v0.7.0"}'
            }
        } elseif ($call[1] -like '*/commits/*') {
            if ($Scenario -eq 'tag-conflict') {
                return '{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
            }
            if ($Scenario -eq 'existing-tag') {
                return '{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
            }
            $global:LASTEXITCODE = 1
            return '{"status":"422","message":"No commit found for SHA: v0.7.0"}'
        }
        $global:LASTEXITCODE = 1
        return '{"status":404}'
    }
}
& $Script -Commit 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' -Root $Root -AssetsPath (Join-Path $Root 'assets')
`;

for (const shell of shells)
  test(`main releases use the built commit and preserve existing releases (${basename(shell)})`, async () => {
    await mkdir(resolve(root, ".cache"), { recursive: true });
    const fixture = await mkdtemp(resolve(root, ".cache/release-test-"));
    try {
      await mkdir(resolve(fixture, ".github/releases"), { recursive: true });
      await mkdir(resolve(fixture, "assets"));
      await writeFile(resolve(fixture, "package.json"), JSON.stringify({ version: "0.7.0" }));
      await writeFile(resolve(fixture, ".github/releases/v0.7.0.md"), "Release notes");
      await writeFile(resolve(fixture, "harness.ps1"), harness);
      const installer = Buffer.from("verified installer fixture");
      const checksum = `${createHash("sha256").update(installer).digest("hex")}  Paperkit_0.7.0_x64-setup.exe`;
      await writeFile(resolve(fixture, "assets/Paperkit_0.7.0_x64-setup.exe"), installer);
      await writeFile(resolve(fixture, "assets/SHA256SUMS.txt"), checksum);
      const run = async (scenario) => {
        const log = resolve(fixture, `${scenario}.jsonl`);
        const env = { ...process.env };
        // Windows PowerShell 5.1 cannot load PowerShell 7's Utility module. A child
        // launched through Node inherits PSModulePath, so let 5.1 rebuild its own.
        if (basename(shell).toLowerCase() === "powershell.exe") {
          for (const key of Object.keys(env))
            if (key.toLowerCase() === "psmodulepath") delete env[key];
        }
        const result = spawnSync(
          shell,
          [
            "-NoProfile",
            "-File",
            resolve(fixture, "harness.ps1"),
            resolve(root, ".github/scripts/publish-release.ps1"),
            fixture,
            scenario,
            log,
          ],
          { encoding: "utf8", env, timeout: 30_000 },
        );
        assert.ifError(result.error);
        const calls = (await readFile(log, "utf8").catch(() => ""))
          .replace(/^\uFEFF/, "")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        return { result, calls };
      };
      const fresh = await run("new");
      assert.equal(fresh.result.status, 0, fresh.result.stderr);
      const create = fresh.calls.find((call) => call[0] === "release" && call[1] === "create");
      assert.equal(create[2], "v0.7.0");
      assert.equal(create[create.indexOf("--target") + 1], commit);
      assert(fresh.calls.some((call) => call[1] === "edit" && call.includes("--draft=false")));
      assert(
        fresh.calls.some((call) => call[1].endsWith("/git/ref/tags/v0.7.0")),
        "check whether the tag exists before resolving its commit",
      );
      assert(!fresh.calls.some((call) => call[1].includes("/commits/")));
      const existingTag = await run("existing-tag");
      assert.equal(existingTag.result.status, 0, existingTag.result.stderr);
      assert(existingTag.calls.some((call) => call[1] === "create"));
      for (const scenario of ["published", "draft", "tag-conflict", "api-error"]) {
        const { result, calls } = await run(scenario);
        assert.equal(result.status === 0, scenario === "published", result.stderr);
        assert(
          !calls.some((call) => call[0] === "release"),
          `${scenario} must not create or overwrite a release`,
        );
      }
      await writeFile(resolve(fixture, "assets/SHA256SUMS.txt"), "incorrect checksum");
      const corrupt = await run("bad-checksum");
      assert.notEqual(corrupt.result.status, 0);
      assert(!corrupt.calls.some((call) => call[0] === "release"));
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
