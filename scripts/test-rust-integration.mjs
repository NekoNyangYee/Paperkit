import { spawnSync } from "node:child_process";

// Keep PDFium test executables in separate processes: its initialization is global.
const cargo = ["test", "-p", "pdf-core", "--locked"];
const ignored = ["--", "--ignored", "--nocapture"];
const cases = [
  [
    "cargo",
    [
      ...cargo,
      "--test",
      "fonts_smoke",
      "replacement_dialog_embeds_one_face_for_many_source_fragments",
      ...ignored,
    ],
  ],
  ["cargo", [...cargo, "--test", "pdfium_smoke", ...ignored]],
  [process.execPath, ["scripts/test-native.mjs", "corpus_smoke"]],
  ["cargo", [...cargo, "--test", "stamps_smoke", ...ignored]],
  ["cargo", [...cargo, "--test", "layout_smoke", ...ignored]],
  ["cargo", [...cargo, "--test", "ensemble_smoke", ...ignored]],
  ["cargo", [...cargo, "--lib", "qpdf_repairs_broken_xref", ...ignored]],
  [
    "cargo",
    [...cargo, "--lib", "recovers_embedded_cmap_and_edits_without_installed_original", ...ignored],
  ],
  [
    "cargo",
    [
      ...cargo,
      "--test",
      "fonts_smoke",
      "block_font_change_reflows_beyond_original_height_and_saves",
      ...ignored,
    ],
  ],
];
for (const [command, args] of cases) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
