import { describe, it, expect, vi, afterEach } from "vitest";
import { compareVersions, latestRelease, parseRepository } from "./releases";
afterEach(() => vi.unstubAllGlobals());
describe("GitHub releases", () => {
  it("compares numerical versions and prereleases", () => {
    expect(compareVersions("v1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("v0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("release-main", "0.1.0")).toBe(null);
  });
  it("restricts repositories to owner/repo", () => {
    expect(parseRepository("https://github.com/example/paperkit/")).toBe("example/paperkit");
    expect(() => parseRepository("https://evil.test/a/b")).toThrow();
    expect(() => parseRepository("example/repo?token=secret")).toThrow();
  });
  it("reports absent releases instead of claiming up to date", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(latestRelease("example/paperkit", new AbortController().signal)).rejects.toThrow(
      "업데이트",
    );
  });
  it("loads release notes as text and forwards cancellation", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0", body: "<script>bad</script>" }),
    });
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await latestRelease("example/paperkit", signal)).toMatchObject({
      tag: "v0.2.0",
      notes: "<script>bad</script>",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/example/paperkit/releases/latest",
      expect.objectContaining({ signal }),
    );
  });
});
