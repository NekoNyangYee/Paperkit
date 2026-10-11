export function parseRepository(value: string): string {
  const repo = value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/$/, "");
  if (!/^[\w-]+\/[\w.-]+$/.test(repo))
    throw new Error("GitHub 저장소를 owner/repo 형식으로 입력해 주세요.");
  return repo;
}

export function compareVersions(a: string, b: string): number | null {
  const parse = (s: string) =>
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/.exec(s);
  const x = parse(a),
    y = parse(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const diff = BigInt(x[i]) - BigInt(y[i]);
    if (diff) return diff > 0n ? 1 : -1;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const ax = x[4].split("."),
    by = y[4].split(".");
  for (let i = 0; i < Math.max(ax.length, by.length); i++) {
    if (ax[i] === by[i]) continue;
    if (ax[i] === undefined) return -1;
    if (by[i] === undefined) return 1;
    const an = /^\d+$/.test(ax[i]),
      bn = /^\d+$/.test(by[i]);
    if (an && bn) return BigInt(ax[i]) > BigInt(by[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ax[i] > by[i] ? 1 : -1;
  }
  return 0;
}

export async function latestRelease(repository: string, signal: AbortSignal) {
  const repo = parseRepository(repository);
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    signal,
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (response.status === 404) throw new Error("아직 배포된 업데이트가 없습니다.");
  if (response.status === 403 || response.status === 429)
    throw new Error("GitHub 조회 한도에 도달했습니다. 잠시 후 다시 확인해 주세요.");
  if (!response.ok) throw new Error(`릴리즈 조회에 실패했습니다 (${response.status}).`);
  const data = await response.json();
  if (typeof data.tag_name !== "string" || data.draft || data.prerelease)
    throw new Error("정식 릴리즈 응답을 확인할 수 없습니다.");
  return {
    downloadUrl: installerUrl(data.assets, repo, data.tag_name),
    tag: data.tag_name as string,
    notes: typeof data.body === "string" ? data.body : "",
    published: typeof data.published_at === "string" ? data.published_at : null,
  };
}

function installerUrl(assets: unknown, repo: string, tag: string): string | null {
  if (!Array.isArray(assets)) return null;
  const name = `Paperkit_${tag.replace(/^v/, "")}_x64-setup.exe`;
  const expected = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
  return assets.some((asset) => asset?.name === name && asset?.browser_download_url === expected)
    ? expected
    : null;
}
