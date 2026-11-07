for (const name of ["VITE_SUPABASE_URL", "VITE_SUPABASE_PUBLISHABLE_KEY", "VITE_API_BASE_URL"]) {
  if (!process.env[name] || /REPLACE_ME|your-project/.test(process.env[name]))
    throw new Error(`Set the ${name} repository variable before building an installer.`);
}
const project = new URL(process.env.VITE_SUPABASE_URL);
const api = new URL(process.env.VITE_API_BASE_URL);
if (
  project.protocol !== "https:" ||
  project.pathname !== "/" ||
  api.protocol !== "https:" ||
  [project, api].some((url) => url.username || url.password || url.search || url.hash)
)
  throw new Error(
    "Production authentication URLs must use HTTPS without credentials or query parameters.",
  );
const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!key.startsWith("sb_publishable_")) {
  let anon = false;
  try {
    anon = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role === "anon";
  } catch {}
  if (!anon) throw new Error("Use a publishable or anon key for the desktop installer.");
}
console.log("Production login configuration is valid.");
