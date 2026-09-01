import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelContextAdapter, WebMcpTool } from "./modules/webmcp";
import { EMPTY_SKILL } from "./modules/skill";
import { MemoryWorkspaceStore } from "./modules/workspace/memory-store";
import { createWorkspaceService } from "./modules/workspace/service";

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  delete document.modelContext;
  sessionStorage.clear();
});

function exactFile(
  content: string | Uint8Array,
  name: string,
  type?: string,
): File {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  return Object.assign(new File([bytes], name, { type }), {
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  });
}

describe("App WebMCP registration lifecycle", () => {
  it("reflects WebMCP-prepared mock lifecycle transitions in the panel", async () => {
    const registered = new Map<
      string,
      { tool: WebMcpTool; signal?: AbortSignal }
    >();
    document.modelContext = {
      async registerTool(tool, options) {
        registered.set(tool.name, { tool, signal: options?.signal });
        return undefined;
      },
    };
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    await vi.waitFor(() => expect(registered.has("skill_open")).toBe(true));
    const execute = (name: string, input: unknown) =>
      registered.get(name)!.tool.execute(input, {
        signal: new AbortController().signal,
      }) as Promise<any>;
    await act(async () => {
      await execute("skill_open", { skillMd: EMPTY_SKILL });
    });
    let prepared: any;
    await act(async () => {
      prepared = await execute("evaluation_prepare", {
        kind: "test-run",
        contract: {
          name: "read_items",
          description: "Read items",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          mockOutput: {},
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: /Evals/ }));
    expect(
      await screen.findByText("A run-scoped WebMCP mock tool is registered."),
    ).toBeInTheDocument();
    const mock = registered.get(prepared.data.mockToolName)!;
    expect(mock.signal?.aborted).toBe(false);

    await act(async () => {
      await execute("evaluation_submit", {
        evaluationId: prepared.data.evaluation.id,
        submission: { finalOutput: {} },
      });
    });

    expect(mock.signal?.aborted).toBe(true);
    expect(
      await screen.findByText(
        "This run is complete; its run-scoped mock tool is unregistered.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves exactly one live registration per tool under StrictMode", async () => {
    const live = new Map<string, number>();
    const context: ModelContextAdapter = {
      async registerTool(tool: WebMcpTool, options) {
        live.set(tool.name, (live.get(tool.name) ?? 0) + 1);
        options?.signal?.addEventListener("abort", () =>
          live.set(tool.name, (live.get(tool.name) ?? 0) - 1),
        );
        return undefined;
      },
    };
    document.modelContext = context;
    const { App } = await import("./App");
    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    expect(live.size).toBeGreaterThan(0);
    expect([...live.values()].every((count) => count === 1)).toBe(true);
  });

  it("reopens a durable workspace without a session selection", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({
      name: "Recovered Skill",
      skillMd: EMPTY_SKILL,
    });
    if (!created.ok) throw new Error(created.error.message);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const reopen = await screen.findByRole("button", {
      name: /Recovered Skill Revision 1/,
    });
    fireEvent.click(reopen);
    expect(await screen.findByTestId("skill-hero")).toBeInTheDocument();
    expect(sessionStorage.getItem("skill-canvas:open-workspace")).toBe(
      created.value.workspace.id,
    );
  });

  it("imports an exported workbench snapshot from the welcome screen", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ name: "Imported Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await source.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const target = createWorkspaceService(new MemoryWorkspaceStore());
    const { App } = await import("./App");
    render(<App workspaceService={target} />);
    const file = exactFile(
      exported.value,
      "workspace.json",
      "application/json",
    );
    fireEvent.change(screen.getByLabelText("Import workbench snapshot"), {
      target: { files: [file] },
    });
    expect(await screen.findByTestId("skill-hero")).toBeInTheDocument();
    expect(sessionStorage.getItem("skill-canvas:open-workspace")).toBe(
      created.value.workspace.id,
    );
  });

  it("imports SKILL.md together with selected reference files", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const createSpy = vi.spyOn(workspaceService, "create");
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const skill = exactFile(EMPTY_SKILL, "SKILL.md");
    const reference = exactFile("Reference body", "guide.md");
    fireEvent.change(screen.getByLabelText("Import SKILL.md"), {
      target: { files: [skill, reference] },
    });

    expect(await screen.findByTestId("skill-hero")).toBeInTheDocument();
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        skillMd: EMPTY_SKILL,
        referenceFiles: [{ path: "guide.md", content: "Reference body" }],
      }),
    );
  });

  it("preflights selected file bounds before reading any bytes", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const read = vi.fn(async () => {
      throw new Error("must not read");
    });
    const oversized = {
      name: "SKILL.md",
      webkitRelativePath: "",
      size: 256 * 1024 + 1,
      arrayBuffer: read,
    } as unknown as File;

    fireEvent.change(screen.getByLabelText("Import SKILL.md"), {
      target: { files: [oversized] },
    });

    expect(await screen.findByText(/SKILL\.md exceeds/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects non-exact UTF-8 before creating a workspace", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const createSpy = vi.spyOn(workspaceService, "create");
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const malformed = exactFile(new Uint8Array([0xc3, 0x28]), "SKILL.md");

    fireEvent.change(screen.getByLabelText("Import SKILL.md"), {
      target: { files: [malformed] },
    });

    expect(await screen.findByText(/not valid UTF-8/)).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("preflights snapshot size before reading its bytes", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const read = vi.fn(async () => {
      throw new Error("must not read");
    });
    const oversized = {
      name: "workspace.json",
      size: 4 * 1024 * 1024 + 1,
      arrayBuffer: read,
    } as unknown as File;

    fireEvent.change(screen.getByLabelText("Import workbench snapshot"), {
      target: { files: [oversized] },
    });

    expect(await screen.findByText(/Snapshot exceeds/)).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("warns before replacing a saved workspace snapshot", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Saved Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await workspaceService.exportSnapshot(
      created.value.workspace.id,
    );
    if (!exported.ok) throw new Error(exported.error.message);
    const incoming = JSON.parse(exported.value);
    incoming.workspace.name = "Incoming Snapshot";
    const incomingJson = JSON.stringify(incoming);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const file = exactFile(incomingJson, "workspace.json", "application/json");
    fireEvent.change(screen.getByLabelText("Import workbench snapshot"), {
      target: { files: [file] },
    });
    expect(
      await screen.findByText(/Snapshot import cancelled/),
    ).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /Replace saved workspace “Saved Workspace” with incoming snapshot “Incoming Snapshot”.*permanently/,
      ),
    );
    expect(await workspaceService.list()).toHaveLength(1);
    confirm.mockRestore();
  });

  it("surfaces rejected browser persistence actions", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Saved Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const failingService = {
      ...workspaceService,
      update: vi.fn().mockRejectedValue(new Error("quota exhausted")),
    };
    const { App } = await import("./App");
    render(<App workspaceService={failingService} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Saved Workspace Revision 1/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Source" }));
    fireEvent.change(document.querySelector(".source-editor")!, {
      target: { value: `${EMPTY_SKILL}\nChanged` },
    });
    fireEvent.click(screen.getByTestId("save-revision"));
    expect(
      await screen.findByText(/Action failed: quota exhausted/),
    ).toBeInTheDocument();
  });

  it("surfaces persistence failures from the empty lint action", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Saved Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const failingService = {
      ...workspaceService,
      analyze: vi.fn().mockRejectedValue(new Error("analysis quota exhausted")),
    };
    const { App } = await import("./App");
    render(<App workspaceService={failingService} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Saved Workspace Revision 1/ }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Analyze current revision" }),
    );
    expect(
      await screen.findByText(/Action failed: analysis quota exhausted/),
    ).toBeInTheDocument();
  });

  it("selects the newest evaluation independently of storage order", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ name: "Evaluation order" });
    if (!created.ok) throw new Error(created.error.message);
    const triggering = await source.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    const testRun = await source.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "read_feedback",
          description: "mock",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          mockOutput: {},
        },
      },
    );
    if (!triggering.ok || !testRun.ok)
      throw new Error("evaluation preparation failed");
    const opened = await source.open(created.value.workspace.id);
    if (!opened.ok) throw new Error(opened.error.message);
    const older = {
      ...triggering.value,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const newer = {
      ...testRun.value,
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    const workspaceService = {
      ...source,
      open: vi.fn().mockResolvedValue({
        ok: true,
        value: { ...opened.value, evaluations: [newer, older] },
      }),
    };
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Evaluation order Revision 1/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Evals/ }));
    expect(
      await screen.findByRole("button", { name: "Manual mock invocation" }),
    ).toBeInTheDocument();
  });

  it("loads the latest comparison deterministically", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ name: "Comparison order" });
    if (!created.ok) throw new Error(created.error.message);
    const makeComparison = (id: string, createdAt: string, score: number) => ({
      id,
      workspaceId: created.value.workspace.id,
      revision: 1,
      kind: "compare" as const,
      version: "skill-canvas-rules/1",
      createdAt,
      data: {
        kind: "compare",
        beforeRevision: 1,
        afterRevision: 1,
        source: {
          additions: 0,
          deletions: 0,
          changedLines: [],
          approximate: false,
        },
        lint: {
          before: { score, grade: "A", counts: { error: 0, warn: 0, info: 0 } },
          after: { score, grade: "A", counts: { error: 0, warn: 0, info: 0 } },
        },
        evaluationReferences: [],
        evaluationStateId: `${id}:state`,
        evaluationSnapshotHash: "hash",
      },
    });
    const opened = await source.open(created.value.workspace.id);
    if (!opened.ok) throw new Error(opened.error.message);
    const workspaceService = {
      ...source,
      open: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          ...opened.value,
          artifacts: [
            makeComparison("newer", "2026-02-01T00:00:00.000Z", 92),
            makeComparison("older", "2026-01-01T00:00:00.000Z", 41),
          ],
        },
      }),
    };
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService as any} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Comparison order Revision 1/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Compare/ }));
    expect(await screen.findAllByText("92/100")).toHaveLength(2);
    expect(screen.queryByText("41/100")).not.toBeInTheDocument();
  });

  it("compares evaluation timestamps as instants", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ name: "Offset evaluation order" });
    if (!created.ok) throw new Error(created.error.message);
    const triggering = await source.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    const testRun = await source.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "read_feedback",
          description: "mock",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          mockOutput: {},
        },
      },
    );
    if (!triggering.ok || !testRun.ok)
      throw new Error("evaluation preparation failed");
    const opened = await source.open(created.value.workspace.id);
    if (!opened.ok) throw new Error(opened.error.message);
    const offsetBundle = {
      ...opened.value,
      evaluations: opened.value.evaluations.map((item) =>
        item.kind === "triggering"
          ? {
              ...item,
              createdAt: "2026-01-01T00:30:00-01:00",
              updatedAt: "2026-01-01T00:30:00-01:00",
            }
          : {
              ...item,
              createdAt: "2026-01-01T01:00:00.000Z",
              updatedAt: "2026-01-01T01:00:00.000Z",
            },
      ),
    };
    const workspaceService = {
      ...source,
      open: vi.fn().mockResolvedValue({ ok: true, value: offsetBundle }),
    };
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Offset evaluation order Revision 1/,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Evals/ }));
    expect(
      await screen.findByRole("group", {
        name: "Which Skill would you select?",
      }),
    ).toBeInTheDocument();
  });

  it("unregisters a run-scoped mock after UI completion", async () => {
    let mockSignal: AbortSignal | undefined;
    document.modelContext = {
      async registerTool(tool, options) {
        if (tool.name.startsWith("mock_")) mockSignal = options?.signal;
        return undefined;
      },
    };
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Mock lifecycle" });
    if (!created.ok) throw new Error(created.error.message);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Mock lifecycle Revision 1/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Evals/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare mocked test run" }),
    );
    await screen.findByText(/Mock tool registered as mock_read_feedback_/);
    expect(
      screen.getByText("A run-scoped WebMCP mock tool is registered."),
    ).toBeInTheDocument();
    expect(mockSignal?.aborted).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Submit final output" }),
    );
    await screen.findByText("Deterministic contract checks complete.");
    expect(mockSignal?.aborted).toBe(true);
    expect(
      screen.getByText(
        "This run is complete; its run-scoped mock tool is unregistered.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a rejected run-scoped mock as unavailable", async () => {
    document.modelContext = {
      async registerTool(tool) {
        if (tool.name.startsWith("mock_")) throw new Error("rejected");
        return undefined;
      },
    };
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Mock rejected" });
    if (!created.ok) throw new Error(created.error.message);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Mock rejected Revision 1/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Evals/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Prepare mocked test run" }),
    );
    expect(
      await screen.findByText(
        "No run-scoped WebMCP mock is registered. Use the manual inspector path below.",
      ),
    ).toBeInTheDocument();
  });
});
