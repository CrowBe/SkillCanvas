import { describe, expect, it, vi } from "vitest";
import { createBrowserAppearanceController } from "./appearance";
import { MemoryWorkspaceStore } from "./workspace/memory-store";
import { createWorkspaceService } from "./workspace/service";
import {
  createToolHandlers,
  registerWebMcpTools,
  type WebMcpTool,
} from "./webmcp";

function appearance() {
  const media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return createBrowserAppearanceController({
    storage: { getItem: () => null, setItem: vi.fn() },
    media,
    root: document.createElement("html"),
    eventTarget: new EventTarget(),
  });
}
const execute = (tool: WebMcpTool, input: unknown = {}) =>
  tool.execute(input, { signal: new AbortController().signal }) as Promise<any>;

describe("WebMCP adapter", () => {
  it("routes UI and WebMCP analysis through the same WorkspaceService artifact", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    let current: string | null = null;
    const handlers = createToolHandlers({
      service,
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    const opened = await execute(
      handlers.find((item) => item.name === "skill_open")!,
      {
        skillMd:
          "---\nname: demo-skill\ndescription: Use when a deterministic demo is requested.\n---\n\n# Demo\n\nFollow the workflow carefully.",
      },
    );
    expect(opened.ok).toBe(true);
    const direct = await service.analyze(current!, ["lint", "structure"]);
    const throughTool = await execute(
      handlers.find((item) => item.name === "skill_analyze")!,
      { capabilities: ["lint", "structure"] },
    );
    expect(throughTool.data).toEqual(direct.ok ? direct.value : null);
    expect(throughTool.protocolVersion).toBe("skill-canvas/1");
  });

  it("registers concise literal tools and aborts every registration on cleanup", async () => {
    const signals: AbortSignal[] = [];
    const names: string[] = [];
    const context = {
      registerTool: vi.fn(
        async (tool: WebMcpTool, options?: { signal?: AbortSignal }) => {
          names.push(tool.name);
          if (options?.signal) signals.push(options.signal);
          return undefined;
        },
      ),
    };
    const registration = await registerWebMcpTools(context, {
      service: createWorkspaceService(new MemoryWorkspaceStore()),
      appearance: appearance(),
      selection: { get: () => null, set: vi.fn() },
    });
    expect(names).toEqual(
      expect.arrayContaining([
        "skill_open",
        "skill_read",
        "skill_update",
        "skill_analyze",
        "evaluation_prepare",
        "appearance_set",
      ]),
    );
    expect(registration.available).toBe(true);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    registration.dispose();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("automatically registers and cleans up a run-scoped mock tool", async () => {
    const registered: { tool: WebMcpTool; signal?: AbortSignal }[] = [];
    const context = {
      registerTool: vi.fn(
        async (tool: WebMcpTool, options?: { signal?: AbortSignal }) => {
          registered.push({ tool, signal: options?.signal });
          return undefined;
        },
      ),
    };
    let current: string | null = null;
    const registration = await registerWebMcpTools(context, {
      service: createWorkspaceService(new MemoryWorkspaceStore()),
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    await execute(
      registration.tools.find((item) => item.name === "skill_open")!,
      {
        skillMd:
          "---\nname: demo-skill\ndescription: Use when a deterministic demo is requested.\n---\n\n# Demo\n\nFollow the workflow carefully.",
      },
    );
    const prepared = await execute(
      registration.tools.find((item) => item.name === "evaluation_prepare")!,
      {
        kind: "test-run",
        contract: {
          name: "read_demo",
          description: "Read demo data",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      },
    );
    expect(prepared.data.mockToolName).toMatch(/^mock_read_demo_/);
    const mock = registered.find(
      (item) => item.tool.name === prepared.data.mockToolName,
    )!;
    expect(mock.signal?.aborted).toBe(false);
    await execute(
      registration.tools.find((item) => item.name === "evaluation_submit")!,
      {
        evaluationId: prepared.data.evaluation.id,
        submission: { finalOutput: {} },
      },
    );
    expect(mock.signal?.aborted).toBe(true);
  });

  it("returns a prepared run with manual fallback when mock registration fails", async () => {
    let current: string | null = null;
    const handlers = createToolHandlers({
      service: createWorkspaceService(new MemoryWorkspaceStore()),
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
      registerMockForRun: async () => {
        throw new Error("native registration failed");
      },
    });
    await execute(
      handlers.find((item) => item.name === "skill_open")!,
      {
        skillMd:
          "---\nname: demo-skill\ndescription: Use when a deterministic demo is requested.\n---\n\n# Demo\n\nFollow the workflow carefully.",
      },
    );
    const prepared = await execute(
      handlers.find((item) => item.name === "evaluation_prepare")!,
      {
        kind: "test-run",
        contract: {
          name: "read_demo",
          description: "Read demo data",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      },
    );
    expect(prepared.ok).toBe(true);
    expect(prepared.data.manualFallback).toBe(true);
    expect(prepared.data.mockToolName).toBeNull();
    expect(prepared.data.evaluation.kind).toBe("test-run");
  });

  it("rejects malformed declared inputs as invalid submissions", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    let current: string | null = null;
    const handlers = createToolHandlers({
      service,
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    const badOpen = await execute(
      handlers.find((item) => item.name === "skill_open")!,
      {
        name: {},
        skillMd:
          "---\nname: demo-skill\ndescription: Use when a deterministic demo is requested.\n---\n\n# Demo\n\nFollow the workflow carefully.",
      },
    );
    expect(badOpen.error.code).toBe("invalid_submission");
    expect(await service.list()).toEqual([]);
    await execute(
      handlers.find((item) => item.name === "skill_open")!,
      {},
    );
    const badAnalyze = await execute(
      handlers.find((item) => item.name === "skill_analyze")!,
      { capabilities: 42 },
    );
    expect(badAnalyze.error.code).toBe("invalid_submission");
  });

  it("imports a workspace snapshot through the tool surface", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create();
    if (!created.ok) throw new Error(created.error.message);
    const exported = await source.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const target = createWorkspaceService(new MemoryWorkspaceStore());
    let current: string | null = null;
    const handlers = createToolHandlers({
      service: target,
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    const imported = await execute(
      handlers.find((item) => item.name === "workspace_snapshot_import")!,
      { json: exported.value },
    );
    expect(imported.ok).toBe(true);
    expect(current).toBe(created.value.workspace.id);

    const collision = await execute(
      handlers.find((item) => item.name === "workspace_snapshot_import")!,
      { json: exported.value },
    );
    expect(collision.ok).toBe(false);
    expect(collision.error.code).toBe("invalid_snapshot");
  });

  it("guards failures from run-scoped mock tools", async () => {
    const registered: WebMcpTool[] = [];
    const context = {
      async registerTool(tool: WebMcpTool) {
        registered.push(tool);
        return undefined;
      },
    };
    const baseService = createWorkspaceService(new MemoryWorkspaceStore());
    let current: string | null = null;
    const registration = await registerWebMcpTools(context, {
      service: {
        ...baseService,
        invokeMock: async () => {
          throw new Error("mock persistence failed");
        },
      },
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    await execute(
      registration.tools.find((item) => item.name === "skill_open")!,
      {},
    );
    const prepared = await execute(
      registration.tools.find((item) => item.name === "evaluation_prepare")!,
      {
        kind: "test-run",
        contract: {
          name: "read_demo",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      },
    );
    const mock = registered.find(
      (tool) => tool.name === prepared.data.mockToolName,
    )!;
    const result = await execute(mock, {});
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("internal_error");
    expect(result.error.message).toContain("mock persistence failed");
  });
});

describe("WebMCP registration failures", () => {
  it("aborts already-registered tools when one registration rejects", async () => {
    const live = new Map<string, number>();
    let calls = 0;
    const context = {
      async registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }) {
        calls += 1;
        if (calls === 2) throw new Error("registration refused");
        live.set(tool.name, (live.get(tool.name) ?? 0) + 1);
        options?.signal?.addEventListener("abort", () =>
          live.set(tool.name, (live.get(tool.name) ?? 0) - 1),
        );
        return undefined;
      },
    };
    let current: string | null = null;
    await expect(
      registerWebMcpTools(context, {
        service: createWorkspaceService(new MemoryWorkspaceStore()),
        appearance: appearance(),
        selection: {
          get: () => current,
          set: (id) => {
            current = id;
          },
        },
      }),
    ).rejects.toThrow("registration refused");
    expect([...live.values()].every((count) => count === 0)).toBe(true);
  });
});

describe("WebMCP envelope guarantees", () => {
  it("returns the ok:false envelope when a tool handler throws", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    let current: string | null = null;
    const handlers = createToolHandlers({
      service: {
        ...service,
        open: () => {
          throw new Error("store exploded");
        },
      },
      appearance: appearance(),
      selection: {
        get: () => current,
        set: (id) => {
          current = id;
        },
      },
    });
    current = "workspace-1";
    const submit = handlers.find((tool) => tool.name === "evaluation_submit")!;
    const envelope = await execute(submit, {
      evaluationId: "eval-1",
      submission: {},
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.message).toContain("store exploded");
  });
});
