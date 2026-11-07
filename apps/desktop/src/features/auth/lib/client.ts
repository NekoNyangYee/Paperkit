import { createClient } from "@supabase/supabase-js";
import { isDesktop } from "@/shared/desktop/files";

export function publicAuthConfig(url: unknown, key: unknown, api: unknown) {
  if (typeof url !== "string" || typeof key !== "string" || typeof api !== "string") return null;
  try {
    const project = new URL(url);
    const backend = new URL(api);
    if (
      project.protocol !== "https:" ||
      project.username ||
      project.password ||
      project.pathname !== "/" ||
      project.search ||
      project.hash
    )
      return null;
    if (
      !(
        backend.protocol === "https:" ||
        (backend.protocol === "http:" && ["127.0.0.1", "localhost"].includes(backend.hostname))
      ) ||
      backend.username ||
      backend.password ||
      backend.search ||
      backend.hash
    )
      return null;
    let legacyAnon = false;
    try {
      legacyAnon =
        JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role === "anon";
    } catch {
      /* Publishable keys are not JWTs. */
    }
    if (key.includes("REPLACE_ME") || !(key.startsWith("sb_publishable_") || legacyAnon))
      return null;
    return { project: project.origin, key, api: backend.toString().replace(/\/$/, "") };
  } catch {
    return null;
  }
}

export const authConfig = publicAuthConfig(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  import.meta.env.VITE_API_BASE_URL,
);

let exchangeSignal: AbortSignal | undefined;
export function setExchangeSignal(signal?: AbortSignal) {
  exchangeSignal = signal;
}

export const supabase = authConfig
  ? createClient(authConfig.project, authConfig.key, {
      global: {
        fetch: (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          const signals = [init?.signal, AbortSignal.timeout(15000)];
          if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "pkce")
            signals.push(exchangeSignal);
          return fetch(input, {
            ...init,
            redirect: "error",
            signal: AbortSignal.any(signals.filter((signal): signal is AbortSignal => !!signal)),
          });
        },
      },
      auth: {
        flowType: "pkce",
        persistSession: !isDesktop(),
        detectSessionInUrl: !isDesktop(),
        ...(typeof window !== "undefined" && !isDesktop()
          ? { storage: window.sessionStorage }
          : {}),
      },
    })
  : null;
