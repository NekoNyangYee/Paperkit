import { afterEach, expect, it, vi } from "vitest";
import { openBrowserPopup } from "./browser-popup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function loginWindow() {
  const popup = { closed: false, location: { replace: vi.fn() }, close: vi.fn() };
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:1420" },
    open: () => popup,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  return popup;
}

it("receives a code on the attempt's channel without navigating the application", async () => {
  const popup = loginWindow();
  const login = openBrowserPopup();
  const id = new URL(login.redirectUrl).searchParams.get("paperkit_login");
  const callback = new BroadcastChannel("paperkit-login-" + id);
  try {
    const result = login.authorize("https://example.org/auth/v1/authorize");
    expect(popup.location.replace).toHaveBeenCalledWith("https://example.org/auth/v1/authorize");
    callback.postMessage({ code: "example-code" });
    await expect(result).resolves.toBe("example-code");
  } finally {
    login.close();
    callback.close();
  }
  expect(popup.close).toHaveBeenCalledOnce();
});

it.each(["app", "window"])("ends a pending login when cancelled from the %s", async (source) => {
  vi.useFakeTimers();
  const popup = loginWindow();
  const login = openBrowserPopup();
  const checked = expect(login.authorize("https://example.org/auth/v1/authorize")).rejects.toBe(
    "login_cancelled",
  );
  if (source === "app") login.close();
  else {
    popup.closed = true;
    vi.advanceTimersByTime(500);
  }
  await checked;
  login.close();
  expect(popup.close).toHaveBeenCalledOnce();
});
