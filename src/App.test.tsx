import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : Uint8Array.from(content);
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
    const live = new Map<string, AbortSignal>();
    const context: ModelContextAdapter = {
      async registerTool(tool: WebMcpTool, options) {
        if (live.has(tool.name)) {
          const error = new Error("Duplicate tool name");
          error.name = "InvalidStateError";
          throw error;
        }
        const signal = options?.signal;
        if (signal?.aborted) {
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          throw error;
        }
        live.set(tool.name, signal ?? new AbortController().signal);
        signal?.addEventListener(
          "abort",
          () => {
            queueMicrotask(() => {
              if (live.get(tool.name) === signal) live.delete(tool.name);
            });
          },
          { once: true },
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
    expect(await screen.findByText("WebMCP tools live")).toBeInTheDocument();
    expect(
      screen.queryByText(/WebMCP registration failed: Duplicate tool name/),
    ).not.toBeInTheDocument();
    expect(live.size).toBeGreaterThan(0);
    expect([...live.keys()]).toEqual(
      expect.arrayContaining(["skill_open", "skill_analyze"]),
    );
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

  it("renders content immediately following a heading", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({
      skillMd: `${EMPTY_SKILL}\n## Constraint\nDo not delete files.`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /untitled-skill Revision 1/ }),
    );

    expect(await screen.findByText("Constraint")).toBeInTheDocument();
    expect(screen.getByText("Do not delete files.")).toBeInTheDocument();
  });

  it("restores and visualizes persisted instruction dependencies", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const skillMd = `${EMPTY_SKILL}\nRead the request.\nThen answer carefully.`;
    const created = await workspaceService.create({
      name: "Mapped instructions",
      skillMd,
    });
    if (!created.ok) throw new Error(created.error.message);
    const readStart = skillMd.indexOf("Read the request.");
    const answerStart = skillMd.indexOf("Then answer carefully.");
    const submitted = await workspaceService.submitInstructionMap(
      created.value.workspace.id,
      {
        revision: 1,
        suppliedBy: "visiting-agent proposal",
        status: "proposed",
        scopes: [{ id: "root", label: "Whole Skill" }],
        requirements: [
          {
            id: "read",
            sourceSpan: {
              start: readStart,
              end: readStart + "Read the request.".length,
            },
            statement: "Read the request.",
            kind: "action",
            scopeId: "root",
            dependencies: [],
            verifiability: "semantic-judgment",
          },
          {
            id: "answer",
            sourceSpan: {
              start: answerStart,
              end: answerStart + "Then answer carefully.".length,
            },
            statement: "Then answer carefully.",
            kind: "constraint",
            scopeId: "root",
            dependencies: ["read"],
            verifiability: "semantic-judgment",
          },
        ],
      },
      true,
    );
    if (!submitted.ok) throw new Error(submitted.error.message);

    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: /Mapped instructions Revision 1/,
      }),
    );
    await screen.findByTestId("skill-hero");
    fireEvent.click(screen.getByRole("button", { name: /Map/ }));

    const dependencyRegion = await screen.findByRole("region", {
      name: "Instruction requirements and dependencies",
    });
    expect(dependencyRegion).toBeInTheDocument();
    expect(
      within(dependencyRegion).getByText("Then answer carefully."),
    ).toBeInTheDocument();
    expect(
      within(dependencyRegion).getByText(/Depends on:\s*Read the request\./),
    ).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Instruction map JSON") as HTMLTextAreaElement)
        .value,
    ).toContain('"status": "accepted"');
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
