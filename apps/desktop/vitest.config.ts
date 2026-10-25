import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const integrationTests = [
  "src/**/*.test.tsx",
  "src/shared/desktop/**/*.test.ts",
  "src/features/file-input/model/**/*.test.ts",
  "src/features/pdf-editor/lib/fonts/editor-font.test.ts",
  "src/features/pdf-editor/lib/text/inline-layout.test.ts",
];

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: {
    clearMocks: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: integrationTests,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "jsdom",
          include: integrationTests,
          setupFiles: ["src/test/setup.ts"],
        },
      },
    ],
  },
});
