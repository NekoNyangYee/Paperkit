import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const settings = {};
for (const name of [".env", ".env.local"]) {
  let content;
  try {
    content = readFileSync(join(root, name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const line of content.split(/\r?\n/)) {
    const match =
      /^(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY|VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/.exec(
        line,
      );
    if (match) settings[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
const project = process.env.SUPABASE_URL || settings.SUPABASE_URL || settings.VITE_SUPABASE_URL;
const key =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  settings.SUPABASE_PUBLISHABLE_KEY ||
  settings.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!project || !key) {
  console.error("로컬 서버 실행에 필요한 Supabase 공개 설정을 .env에 입력해 주세요.");
  process.exit(1);
}
const directory = join(root, ".cache", "dev-backend");
mkdirSync(directory, { recursive: true });
const child = spawn("cargo", ["run", "-p", "paperkit-api", "--locked"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    BIND_ADDRESS: "127.0.0.1:18081",
    DATABASE_PATH: join(directory, "paperkit.sqlite3"),
    SUPABASE_URL: project,
    SUPABASE_PUBLISHABLE_KEY: key,
    CORS_ALLOWED_ORIGINS: "http://127.0.0.1:1420,http://tauri.localhost,https://tauri.localhost",
    REQUESTS_PER_MINUTE: "600",
  },
});
child.on("error", () => {
  console.error("로컬 서버를 시작하지 못했습니다. Rust 설치를 확인해 주세요.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
