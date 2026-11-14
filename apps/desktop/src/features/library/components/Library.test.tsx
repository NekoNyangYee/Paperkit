import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  documents: vi.fn(),
  tools: vi.fn(),
  receive: vi.fn(),
  image: vi.fn(),
}));
vi.mock("../lib/api", () => ({
  libraryRequest: mocks.request,
  getDocuments: mocks.documents,
  getTools: mocks.tools,
}));
vi.mock("@/features/auth/lib/client", () => ({ authConfig: null, supabase: null }));
vi.mock("../lib/tool-image", () => ({ readToolImage: mocks.image }));
vi.mock("@/features/pdf-editor/components/stamps/SignatureDialog", () => ({
  SignatureDialog: ({
    onApply,
    onClose,
  }: {
    onApply: (png: number[]) => Promise<boolean>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="전자서명">
      <button
        onClick={async () => {
          if (await onApply([1, 2, 3])) onClose();
        }}
      >
        서명 선택
      </button>
    </div>
  ),
}));
vi.mock("@/shared/desktop/files", async (original) => ({
  ...(await original<object>()),
  isDesktop: () => true,
}));
import { useAuthStore } from "@/features/auth/model/auth-store";
import { useFileStore } from "@/features/file-input/model/file-store";
import { useToolStore } from "../model/tool-store";
import { DocumentLibrary } from "./DocumentLibrary";
import { ToolboxDialog, ToolShelf } from "./Toolbox";
import { LibrarySync } from "./LibrarySync";
import { useDocumentStatus } from "../model/document-status";

const document = {
  id: "document-1",
  sourcePath: "C:\\문서\\견적서.pdf",
  displayName: "견적서.pdf",
  sizeBytes: 1024,
  lastOpenedAt: 1_800_000_000_000,
  favorite: false,
};
const tool = {
  id: "tool-1",
  name: "안내 문구",
  kind: "text" as const,
  content: "검토 부탁드립니다.",
  createdAt: 1,
};

it("edits from the button beside delete, updates the same card and never applies it to a document", async () => {
  const onUse = vi.fn();
  const updated = { ...tool, name: "수정한 문구", content: "바꾼 내용" };
  mocks.request.mockResolvedValueOnce(updated);
  render(<ToolboxDialog onClose={vi.fn()} onUse={onUse} />);
  fireEvent.click(await screen.findByRole("button", { name: `${tool.name} 수정` }));
  const editor = within(await screen.findByRole("dialog", { name: "도구 수정" }));
  expect((editor.getByLabelText("이름") as HTMLInputElement).value).toBe(tool.name);
  expect((editor.getByLabelText("내용") as HTMLTextAreaElement).value).toBe(tool.content);
  expect(editor.queryByRole("group", { name: "도구 종류" })).toBeNull();
  expect((editor.getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(editor.getByLabelText("이름"), { target: { value: updated.name } });
  fireEvent.change(editor.getByLabelText("내용"), { target: { value: updated.content } });
  fireEvent.click(editor.getByRole("button", { name: "저장" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      `/library/tools/${tool.id}`,
      {
        method: "PUT",
        body: JSON.stringify({ name: updated.name, kind: tool.kind, content: updated.content }),
      },
      "owner-a",
    ),
  );
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "도구 수정" })).toBeNull());
  expect(screen.getByRole("button", { name: `${updated.name} 수정` })).toBeTruthy();
  expect(useToolStore.getState().tools).toEqual([updated]);
  expect(onUse).not.toHaveBeenCalled();
});

it("keeps the edit draft on save failure and discards changes on cancel", async () => {
  render(<ToolboxDialog onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `${tool.name} 수정` }));
  const editor = within(await screen.findByRole("dialog", { name: "도구 수정" }));
  fireEvent.change(editor.getByLabelText("내용"), { target: { value: "보관할 수정 내용" } });
  mocks.request.mockRejectedValueOnce(new Error("HTTP 500 private_database_path"));
  fireEvent.click(editor.getByRole("button", { name: "저장" }));
  const alert = await editor.findByRole("alert");
  expect(alert.textContent).not.toContain("private_database");
  expect((editor.getByLabelText("내용") as HTMLTextAreaElement).value).toBe("보관할 수정 내용");
  expect(useToolStore.getState().tools).toEqual([tool]);
  fireEvent.click(editor.getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "도구 수정" })).toBeNull());
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: `${tool.name} 수정` }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: `${tool.name} 수정` }));
  expect(
    (
      within(await screen.findByRole("dialog", { name: "도구 수정" })).getByLabelText(
        "내용",
      ) as HTMLTextAreaElement
    ).value,
  ).toBe(tool.content);
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it.each(["image", "signature"] as const)(
  "edits saved %s content with its existing input tool",
  async (kind) => {
    const original = { ...tool, kind, name: "내 이미지", content: "data:image/png;base64,AA==" };
    mocks.tools.mockResolvedValueOnce([original]);
    const next = "data:image/png;base64,AQID";
    mocks.image.mockResolvedValueOnce(next);
    mocks.request.mockResolvedValueOnce({ ...original, content: next });
    render(<ToolboxDialog onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: `${original.name} 수정` }));
    const editor = within(await screen.findByRole("dialog", { name: "도구 수정" }));
    expect(editor.getByAltText("수정할 도구 미리보기").getAttribute("src")).toBe(original.content);
    if (kind === "image") {
      const file = new File(["image"], "new.png", { type: "image/png" });
      fireEvent.change(editor.getByLabelText("바꿀 이미지"), { target: { files: [file] } });
      await waitFor(() => expect(mocks.image).toHaveBeenCalledWith(file));
    } else {
      fireEvent.click(editor.getByRole("button", { name: "서명 다시 그리기" }));
      fireEvent.click(
        within(await screen.findByRole("dialog", { name: "전자서명" })).getByRole("button", {
          name: "서명 선택",
        }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "전자서명" })).toBeNull());
    }
    await waitFor(() =>
      expect(editor.getByAltText("수정할 도구 미리보기").getAttribute("src")).toBe(next),
    );
    fireEvent.click(editor.getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        `/library/tools/${tool.id}`,
        {
          method: "PUT",
          body: JSON.stringify({ name: original.name, kind, content: next }),
        },
        "owner-a",
      ),
    );
  },
);

it("does not put a late update response into another account's toolbox", async () => {
  useToolStore.setState({ owner: "owner-a", tools: [tool] });
  let resolve!: (tool: typeof other) => void;
  const other = { ...tool, name: "다른 계정 문구" };
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const update = useToolStore
    .getState()
    .update(tool.id, { ...tool, name: "수정한 문구" }, "owner-a");
  login("owner-b");
  useToolStore.setState({ owner: "owner-b", tools: [other] });
  resolve({ ...other, name: "늦은 응답" });
  await update;
  expect(useToolStore.getState().tools).toEqual([other]);
  expect(useToolStore.getState().owner).toBe("owner-b");
});
function login(id = "owner-a") {
  useAuthStore.setState({ session: { user: { id } } as never, ready: true, busy: false });
}
beforeEach(() => {
  login();
  useFileStore.setState({
    scopeOwner: "owner-a",
    ready: true,
    phase: "idle",
    receive: mocks.receive,
    file: null,
    openedFileId: null,
    persistenceError: null,
  });
  useDocumentStatus.setState({ owner: null, error: null, revision: 0 });
  useToolStore.setState({ owner: null, tools: [], error: null, loading: false });
  mocks.documents.mockReset().mockResolvedValue([document]);
  mocks.tools.mockReset().mockResolvedValue([tool]);
  mocks.request.mockReset().mockResolvedValue(tool);
  mocks.image.mockReset();
  mocks.receive.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("opens a recorded local path and updates favorites through the server", async () => {
  render(<DocumentLibrary />);
  fireEvent.click(await screen.findByRole("button", { name: /견적서.pdf C:/ }));
  expect(mocks.receive).toHaveBeenCalledWith([document.sourcePath]);
  fireEvent.click(screen.getByRole("button", { name: "견적서.pdf 즐겨찾기" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "/documents/document-1/favorite",
      { method: "PUT", body: '{"favorite":true}' },
      "owner-a",
    ),
  );
  await waitFor(() => expect(mocks.documents).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByRole("searchbox", { name: "내 문서 검색" }), {
    target: { value: "견적" },
  });
  await waitFor(() => expect(mocks.documents.mock.calls.at(-1)?.[0].get("q")).toBe("견적"));
});

it("keeps the existing document list usable after refresh fails and recovers on retry", async () => {
  render(<DocumentLibrary />);
  await screen.findByText(document.displayName);
  mocks.documents.mockRejectedValueOnce(new Error("HTTP 503 sqlite_private_path"));
  fireEvent.click(screen.getByRole("button", { name: "문서함 새로고침" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("파일 선택으로 작업을 계속");
  expect(alert.textContent).not.toContain("sqlite");
  expect(screen.getByText(document.displayName)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText(document.displayName)).toBeTruthy();
});

it("automatically recovers both lists when the same account receives a renewed token", async () => {
  mocks.documents.mockRejectedValueOnce(new Error("expired request"));
  mocks.tools.mockRejectedValueOnce(new Error("expired request"));
  render(
    <>
      <DocumentLibrary />
      <ToolShelf />
    </>,
  );
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  act(() =>
    useAuthStore.setState({
      session: { user: { id: "owner-a" }, access_token: "renewed-test-token" } as never,
    }),
  );
  await waitFor(() => expect(screen.queryAllByRole("alert")).toHaveLength(0));
  expect(screen.getByText(document.displayName)).toBeTruthy();
  expect(screen.getByText(tool.name)).toBeTruthy();
  expect(mocks.documents).toHaveBeenCalledTimes(2);
  expect(mocks.tools).toHaveBeenCalledTimes(2);
});

it("keeps document removal behind confirmation and clears records on sign-out", async () => {
  render(<DocumentLibrary />);
  fireEvent.click(await screen.findByRole("button", { name: "견적서.pdf 문서함에서 제거" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(mocks.request).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
  expect(mocks.request).not.toHaveBeenCalled();
  act(() => useAuthStore.setState({ session: null }));
  expect(screen.queryByText("견적서.pdf")).toBeNull();
  expect(screen.queryByRole("heading", { name: "내 문서함" })).toBeNull();
  expect(screen.queryByRole("button", { name: "로그인" })).toBeNull();
});

it("opens tool choices directly from the shelf plus without a list or back step", async () => {
  useToolStore.setState({ owner: "owner-a", tools: [tool] });
  render(<ToolShelf />);
  fireEvent.click(screen.getByRole("button", { name: "도구 추가" }));
  const dialog = await screen.findByRole("dialog", { name: "도구 추가" });
  for (const name of ["이미지", "문구", "워터마크", "전자서명"])
    expect(within(dialog).getByRole("button", { name })).toBeTruthy();
  expect(within(dialog).queryByText("목록으로")).toBeNull();
  expect(within(dialog).getByRole("button", { name: "이미지" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(within(dialog).getByLabelText("이름")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "로고·도장 이미지 선택" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "문구" }));
  expect(within(dialog).getByLabelText("내용")).toBeTruthy();
  expect(within(dialog).queryByText("이 도구는 내 계정에 저장됩니다.")).toBeNull();
});

it("keeps failed document registration in the library instead of interrupting PDF editing", async () => {
  const file = {
    id: "local-1",
    path: document.sourcePath,
    name: document.displayName,
    sizeBytes: 1024,
  };
  mocks.request.mockRejectedValueOnce(new Error("문서를 기록하지 못했습니다."));
  useFileStore.setState({ file, openedFileId: file.id });
  render(<LibrarySync />);
  await waitFor(() =>
    expect(useDocumentStatus.getState().error).toBe(
      "문서함을 잠시 불러올 수 없어요. 파일 선택으로 작업을 계속할 수 있습니다.",
    ),
  );
  expect(useFileStore.getState().persistenceError).toBeNull();
  expect(useFileStore.getState().openedFileId).toBe(file.id);
  expect(mocks.request).toHaveBeenCalledWith(
    "/library/documents",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        sourcePath: file.path,
        displayName: file.name,
        sizeBytes: file.sizeBytes,
      }),
    }),
    "owner-a",
  );
});

it("saves a reusable text tool and applies an existing image only through the editor callback", async () => {
  const onUse = vi.fn().mockResolvedValue(true);
  const onClose = vi.fn();
  render(<ToolboxDialog onClose={onClose} onUse={onUse} />);
  await screen.findByText(tool.name);
  mocks.request.mockResolvedValueOnce({ ...tool, id: "tool-2", name: "납품 안내" });
  fireEvent.click(screen.getByRole("button", { name: "도구 추가" }));
  fireEvent.click(screen.getByRole("button", { name: "문구" }));
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "납품 안내" } });
  fireEvent.change(screen.getByLabelText("내용"), {
    target: { value: "첨부 자료를 확인해 주세요." },
  });
  fireEvent.click(screen.getByRole("button", { name: "보관하기" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "/library/tools",
      {
        method: "POST",
        body: JSON.stringify({
          name: "납품 안내",
          kind: "text",
          content: "첨부 자료를 확인해 주세요.",
        }),
      },
      "owner-a",
    ),
  );
  await waitFor(() => expect(screen.queryByLabelText("이름")).toBeNull());
  const image = {
    ...tool,
    id: "image-1",
    name: "회사 로고",
    kind: "image" as const,
    content: "data:image/png;base64,AQID",
  };
  act(() => useToolStore.setState({ owner: "owner-a", tools: [image] }));
  fireEvent.click(screen.getByRole("button", { name: "회사 로고 문서에 넣기" }));
  await waitFor(() => expect(onUse).toHaveBeenCalledWith(image));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("filters cards by kind and copies text from the card without triggering actions on delete", async () => {
  const image = {
    ...tool,
    id: "image",
    name: "로고",
    kind: "image" as const,
    content: "data:image/png;base64,AQID",
  };
  const signature = { ...image, id: "sign", name: "내 서명", kind: "signature" as const };
  mocks.tools.mockResolvedValueOnce([tool, image, signature]);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ToolboxDialog onClose={() => {}} />);
  await screen.findByText(tool.name);
  const filters = screen.getByRole("group", { name: "도구 필터" });
  fireEvent.click(within(filters).getByRole("button", { name: "이미지" }));
  expect(screen.getByText("로고")).toBeTruthy();
  expect(screen.queryByText(tool.name)).toBeNull();
  expect(screen.queryByText("내 서명")).toBeNull();
  fireEvent.click(within(filters).getByRole("button", { name: "전자서명" }));
  expect(screen.getByText("내 서명")).toBeTruthy();
  expect(screen.queryByText("로고")).toBeNull();
  fireEvent.click(within(filters).getByRole("button", { name: "워터마크" }));
  expect(screen.getByRole("status").textContent).toContain("보관한 워터마크 도구가 없습니다.");
  fireEvent.click(within(filters).getByRole("button", { name: "문구" }));
  fireEvent.click(screen.getByRole("button", { name: `${tool.name} 삭제` }));
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", { name: "취소" }),
  );
  fireEvent.click(screen.getByRole("button", { name: `${tool.name} 문구 복사` }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(tool.content));
  expect(await screen.findByText("복사됨")).toBeTruthy();
  expect(screen.queryByText("문구 복사")).toBeNull();
  fireEvent.click(within(filters).getByRole("button", { name: "전체" }));
  expect(screen.getByText("로고")).toBeTruthy();
  expect(screen.getByText("내 서명")).toBeTruthy();
});

it("saves a drawn signature as a distinct reusable tool", async () => {
  const onClose = vi.fn();
  render(<ToolboxDialog initialAdding onClose={onClose} />);
  const kinds = screen.getByRole("group", { name: "도구 종류" });
  fireEvent.click(within(kinds).getByRole("button", { name: "전자서명" }));
  fireEvent.change(screen.getByLabelText("이름"), { target: { value: "내 서명" } });
  expect((screen.getByRole("button", { name: "보관하기" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "서명 그리기" }));
  fireEvent.click(
    within(await screen.findByRole("dialog", { name: "전자서명" })).getByRole("button", {
      name: "서명 선택",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "전자서명" })).toBeNull());
  expect(screen.getByAltText("보관할 서명 미리보기")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "보관하기" }));
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith(
      "/library/tools",
      {
        method: "POST",
        body: JSON.stringify({
          name: "내 서명",
          kind: "signature",
          content: "data:image/png;base64,AQID",
        }),
      },
      "owner-a",
    ),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("does not show a previous account's tools when a late request completes", async () => {
  let resolve!: (value: (typeof tool)[]) => void;
  mocks.tools.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<ToolboxDialog onClose={() => {}} />);
  act(() => login("owner-b"));
  await act(async () => {
    resolve([{ ...tool, name: "이전 계정의 문구" }]);
  });
  await waitFor(() => expect(mocks.tools).toHaveBeenCalledWith("owner-b"));
  expect(screen.queryByText("이전 계정의 문구")).toBeNull();
});

it("registers an opened document once across StrictMode, tab switches and token rotations", async () => {
  const file = { id: "dedup-open", path: "C:/dedup.pdf", name: "dedup.pdf", sizeBytes: 100 };
  useFileStore.setState({ file, openedFileId: file.id });
  const view = render(
    <StrictMode>
      <LibrarySync />
    </StrictMode>,
  );
  await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
  act(() => useFileStore.setState({ file: null, openedFileId: null }));
  act(() => useFileStore.setState({ file, openedFileId: file.id }));
  act(() =>
    useAuthStore.setState({
      session: { user: { id: "owner-a" }, access_token: "renewed" } as never,
    }),
  );
  view.unmount();
  render(<LibrarySync />);
  await act(async () => {});
  expect(mocks.request).toHaveBeenCalledOnce();
});

it("does not register a guest or another account's open file after login", async () => {
  const file = { id: "guest-open", path: "C:/guest.pdf", name: "guest.pdf", sizeBytes: 100 };
  act(() => useAuthStore.setState({ session: null }));
  useFileStore.setState({ scopeOwner: null, file, openedFileId: file.id });
  render(<LibrarySync />);
  act(() => login("owner-b"));
  await act(async () => {});
  expect(mocks.request).not.toHaveBeenCalled();
});

it("does not apply a late document registration after an A to B to A account change", async () => {
  let finish!: (value: unknown) => void;
  mocks.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const file = { id: "late-open", path: "C:/late.pdf", name: "late.pdf", sizeBytes: 100 };
  useFileStore.setState({ file, openedFileId: file.id });
  const view = render(<LibrarySync />);
  view.unmount();
  act(() => {
    login("owner-b");
    login("owner-a");
  });
  const revision = useDocumentStatus.getState().revision;
  await act(async () => {
    finish({});
  });
  expect(useDocumentStatus.getState().revision).toBe(revision);
});

it("does not reload a healthy document list just because its access token rotates", async () => {
  render(<DocumentLibrary />);
  await screen.findByText(document.displayName);
  act(() =>
    useAuthStore.setState({
      session: { user: { id: "owner-a" }, access_token: "rotated" } as never,
    }),
  );
  await act(async () => {});
  expect(mocks.documents).toHaveBeenCalledOnce();
});

it("does not accept a stale tool update after returning to the original account", async () => {
  let finish!: (value: typeof tool) => void;
  mocks.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  useToolStore.setState({ owner: "owner-a", tools: [tool] });
  const pending = useToolStore.getState().update(tool.id, { ...tool, name: "late" }, "owner-a");
  login("owner-b");
  login("owner-a");
  useToolStore.setState({ owner: "owner-a", tools: [tool] });
  finish({ ...tool, name: "late" });
  await pending;
  expect(useToolStore.getState().tools).toEqual([tool]);
});
