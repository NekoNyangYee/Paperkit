// Keep the package, native binary, installer and release tag on one version.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const jsonPaths = [
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/tauri.conf.json",
];
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const files = new Map(
  await Promise.all(
    [...jsonPaths, "Cargo.toml", "Cargo.lock"].map(async (p) => [
      p,
      await readFile(resolve(root, p), "utf8"),
    ]),
  ),
);
const json = jsonPaths.map((p) => JSON.parse(files.get(p)));
const cargoVersion = /\[workspace\.package\]\s*version = "([^"]+)"/.exec(
  files.get("Cargo.toml"),
)?.[1];
const lockVersion = (name) =>
  new RegExp(`\\[\\[package\\]\\]\\s*name = "${name}"\\s*version = "([^"]+)"`).exec(
    files.get("Cargo.lock"),
  )?.[1];
const versions = [
  ...json.map((p) => p.version),
  cargoVersion,
  lockVersion("paperkit-desktop"),
  lockVersion("pdf-core"),
];
if (!versions.every((v) => typeof v === "string" && stable.test(v) && v === versions[0]))
  throw new Error(`Version mismatch: ${versions.join(", ")}`);
const requested = process.argv[2];
if (process.argv.length > 3 || (requested && !stable.test(requested)))
  throw new Error("Usage: node scripts/version.mjs [major.minor.patch]");
if (requested) {
  json.forEach((p) => {
    p.version = requested;
  });
  const { format, resolveConfig } = await import("prettier");
  for (const [i, p] of jsonPaths.entries()) {
    files.set(
      p,
      await format(JSON.stringify(json[i]), {
        ...(await resolveConfig(resolve(root, p))),
        parser: "json",
      }),
    );
  }
  files.set(
    "Cargo.toml",
    files
      .get("Cargo.toml")
      .replace(/(\[workspace\.package\]\s*version = ")[^"]+/, `$1${requested}`),
  );
  let lock = files.get("Cargo.lock");
  for (const name of ["paperkit-desktop", "pdf-core"])
    lock = lock.replace(
      new RegExp(`(\\[\\[package\\]\\]\\s*name = "${name}"\\s*version = ")[^"]+`),
      `$1${requested}`,
    );
  files.set("Cargo.lock", lock);
  for (const [p, content] of files) await writeFile(resolve(root, p), content);
  console.log(`Versions updated to ${requested}. Commit these changes before tagging.`);
} else {
  const tag = process.env.RELEASE_TAG;
  if (tag && tag !== `v${versions[0]}`)
    throw new Error(`Tag ${tag} does not match app v${versions[0]}`);
  console.log(`Version ${versions[0]} is consistent${tag ? ` with ${tag}` : ""}.`);
}
