import type { AppearanceChoice, AppearanceController } from "./appearance";
import {
  PROTOCOL_VERSION,
  type DomainError,
  type Result,
  type ToolEnvelope,
} from "./shared";
import { validateSchema, type ToolContract } from "./evaluations";
import type { WorkspaceBundle } from "./workspace/types";
import type { WorkspaceService } from "./workspace/service";

export type WebMcpTool = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly untrustedContentHint?: boolean;
  };
  readonly execute: (
    input: any,
    options: { signal: AbortSignal },
  ) => Promise<unknown>;
};
export interface ModelContextAdapter {
  registerTool(
    tool: WebMcpTool,
    options?: { signal?: AbortSignal; exposedTo?: readonly string[] },
  ): Promise<undefined>;
}
export type WorkspaceSelection = {
  get(): string | null;
  set(workspaceId: string): void;
};

type Runtime = {
  service: WorkspaceService;
  appearance: AppearanceController;
  selection: WorkspaceSelection;
  onWorkspaceChange?: (bundle: WorkspaceBundle) => void;
  download?: (
    filename: string,
    bytes: Uint8Array | string,
    type: string,
  ) => void;
  registerMockForRun?: (
    evaluationId: string,
    contractName: string,
  ) => Promise<string>;
  unregisterMockForRun?: (evaluationId: string) => void;
};

function guardTool(
  tool: WebMcpTool,
  selection: WorkspaceSelection,
  workspaceId?: string,
): WebMcpTool {
  return {
    ...tool,
    execute: async (input, options) => {
      try {
        if (tool.inputSchema) {
          const issues = validateSchema(input, tool.inputSchema);
          if (issues.length > 0)
            return {
              protocolVersion: PROTOCOL_VERSION,
              ok: false,
              workspaceId: workspaceId ?? selection.get(),
              revision: null,
              contentHash: null,
              error: {
                code: "invalid_submission",
                message: issues.join(" "),
              },
            };
        }
        return await tool.execute(input, options);
      } catch (error) {
        return {
          protocolVersion: PROTOCOL_VERSION,
          ok: false,
          workspaceId: workspaceId ?? selection.get(),
          revision: null,
          contentHash: null,
          error: {
            code: "internal_error",
            message:
              error instanceof Error ? error.message : "Tool call failed.",
          },
        };
      }
    },
  };
}

export function createToolHandlers(runtime: Runtime): readonly WebMcpTool[] {
  const bundleEnvelope = <T>(
    result: Result<T>,
    bundle?: WorkspaceBundle,
  ): ToolEnvelope<T> =>
    result.ok
      ? {
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          workspaceId: bundle?.workspace.id ?? runtime.selection.get(),
          revision: bundle?.revision.revision ?? null,
          contentHash: bundle?.revision.contentHash ?? null,
          data: result.value,
        }
      : {
          protocolVersion: PROTOCOL_VERSION,
          ok: false,
          workspaceId: runtime.selection.get(),
          revision: null,
          contentHash: null,
          error: result.error,
        };
  const current = async (): Promise<Result<WorkspaceBundle>> => {
    const id = runtime.selection.get();
    return id
      ? runtime.service.open(id)
      : {
          ok: false,
          error: {
            code: "workspace_not_found",
            message: "Open a workspace first.",
          },
        };
  };
  const mutate = (bundle: WorkspaceBundle) => {
    runtime.selection.set(bundle.workspace.id);
    runtime.onWorkspaceChange?.(bundle);
  };
  const refresh = async (workspaceId: string) => {
    const result = await runtime.service.open(workspaceId);
    if (result.ok) mutate(result.value);
  };
  const handlers: readonly WebMcpTool[] = [
    {
      name: "skill_open",
      title: "Open Skill",
      description: "Creates or opens a Skill workspace.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          name: { type: "string" },
          skillMd: { type: "string" },
          referenceFiles: { type: "array" },
        },
      },
      execute: async (input) => {
        const result = input.workspaceId
          ? await runtime.service.open(input.workspaceId)
          : await runtime.service.create({
              name: input.name,
              skillMd: input.skillMd,
              referenceFiles: input.referenceFiles,
              actor: "webmcp",
            });
        if (result.ok) mutate(result.value);
        return bundleEnvelope(result, result.ok ? result.value : undefined);
      },
    },
    {
      name: "skill_read",
      title: "Read Skill",
      description: "Reads the current Skill revision and reference files.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: "object",
        properties: { revision: { type: "integer" } },
      },
      execute: async (input) => {
        const id = runtime.selection.get();
        const result = id
          ? await runtime.service.open(id, input.revision)
          : await current();
        return bundleEnvelope(result, result.ok ? result.value : undefined);
      },
    },
    {
      name: "skill_update",
      title: "Update Skill",
      description: "Appends a full SKILL.md replacement from a base revision.",
      inputSchema: {
        type: "object",
        required: ["baseRevision", "skillMd"],
        properties: {
          baseRevision: { type: "integer" },
          skillMd: { type: "string" },
          referenceFiles: { type: "array" },
        },
      },
      execute: async (input) => {
        const id = runtime.selection.get();
        const result = id
          ? await runtime.service.update({
              workspaceId: id,
              baseRevision: input.baseRevision,
              skillMd: input.skillMd,
              referenceFiles: input.referenceFiles,
              actor: "webmcp",
            })
          : await current();
        if (result.ok) mutate(result.value);
        return bundleEnvelope(result, result.ok ? result.value : undefined);
      },
    },
    {
      name: "skill_analyze",
      title: "Analyze Skill",
      description:
        "Computes and stores traceable lint and structure artifacts for the current revision.",
      inputSchema: {
        type: "object",
        required: ["capabilities"],
        properties: {
          capabilities: {
            type: "array",
            items: { type: "string", enum: ["lint", "structure"] },
          },
        },
      },
      execute: async (input) => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.analyze(
          bundle.value.workspace.id,
          input.capabilities ?? ["lint", "structure"],
        );
        if (result.ok) await refresh(bundle.value.workspace.id);
        return bundleEnvelope(result, bundle.value);
      },
    },
    {
      name: "instruction_map_submit",
      title: "Submit Instruction Map",
      description:
        "Validates a visiting-agent instruction map pinned to the current revision.",
      inputSchema: {
        type: "object",
        required: ["map"],
        properties: { map: { type: "object" }, accept: { type: "boolean" } },
      },
      execute: async (input) => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.submitInstructionMap(
          bundle.value.workspace.id,
          input.map,
          input.accept === true,
        );
        if (result.ok) await refresh(bundle.value.workspace.id);
        return bundleEnvelope(result, bundle.value);
      },
    },
    {
      name: "evaluation_prepare",
      title: "Prepare Evaluation",
      description:
        "Prepares a triggering evaluation or mocked test run for the current revision.",
      inputSchema: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["triggering", "test-run"] },
          contract: { type: "object" },
          responseSchema: { type: "object" },
        },
      },
      execute: async (input) => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.prepareEvaluation(
          bundle.value.workspace.id,
          input.kind,
          {
            contract: input.contract as ToolContract,
            responseSchema: input.responseSchema,
          },
        );
        if (result.ok) await refresh(bundle.value.workspace.id);
        if (
          result.ok &&
          result.value.kind === "test-run" &&
          runtime.registerMockForRun
        ) {
          try {
            const mockToolName = await runtime.registerMockForRun(
              result.value.id,
              (result.value.data as any).contract.name,
            );
            return bundleEnvelope(
              { ok: true, value: { evaluation: result.value, mockToolName } },
              bundle.value,
            );
          } catch {
            return bundleEnvelope(
              {
                ok: true,
                value: {
                  evaluation: result.value,
                  mockToolName: null,
                  manualFallback: true,
                },
              },
              bundle.value,
            );
          }
        }
        return bundleEnvelope(result, bundle.value);
      },
    },
    {
      name: "evaluation_submit",
      title: "Submit Evaluation Evidence",
      description:
        "Records one visiting-agent judgment or final test-run output and grades deterministic properties.",
      inputSchema: {
        type: "object",
        required: ["evaluationId", "submission"],
        properties: { evaluationId: { type: "string" }, submission: {} },
      },
      execute: async (input) => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.submitEvaluation(
          bundle.value.workspace.id,
          input.evaluationId,
          input.submission,
        );
        if (result.ok) {
          if (
            result.value.kind === "test-run" &&
            result.value.status === "complete"
          )
            runtime.unregisterMockForRun?.(result.value.id);
          await refresh(bundle.value.workspace.id);
        }
        return bundleEnvelope(result, bundle.value);
      },
    },
    {
      name: "skill_compare",
      title: "Compare Skill",
      description:
        "Compares revisions and stores the traceable comparison artifact.",
      inputSchema: {
        type: "object",
        required: ["beforeRevision", "afterRevision"],
        properties: {
          beforeRevision: { type: "integer" },
          afterRevision: { type: "integer" },
        },
      },
      execute: async (input) => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.compare(
          bundle.value.workspace.id,
          input.beforeRevision,
          input.afterRevision,
        );
        if (result.ok) await refresh(bundle.value.workspace.id);
        return bundleEnvelope(result, bundle.value);
      },
    },
    {
      name: "skill_export",
      title: "Export Skill",
      description:
        "Downloads a standard-native Skill zip containing only SKILL.md and reference files.",
      execute: async () => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.exportSkill(
          bundle.value.workspace.id,
        );
        if (result.ok)
          runtime.download?.(
            `${bundle.value.workspace.name}.zip`,
            result.value,
            "application/zip",
          );
        return bundleEnvelope(
          result.ok
            ? {
                ok: true,
                value: {
                  filename: `${bundle.value.workspace.name}.zip`,
                  bytes: result.value.byteLength,
                  includesWorkbenchMetadata: false,
                },
              }
            : result,
          bundle.value,
        );
      },
    },
    {
      name: "workspace_snapshot_import",
      title: "Import Workspace Snapshot",
      description:
        "Imports a bounded workbench snapshot with revisions and evidence.",
      inputSchema: {
        type: "object",
        required: ["json"],
        properties: { json: { type: "string" } },
      },
      execute: async (input) => {
        const result = await runtime.service.importSnapshot(input.json);
        if (result.ok) mutate(result.value);
        return bundleEnvelope(result, result.ok ? result.value : undefined);
      },
    },
    {
      name: "appearance_read",
      title: "Read Appearance",
      description:
        "Reads available appearance choices and the resolved browser theme.",
      annotations: { readOnlyHint: true },
      execute: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        ok: true,
        workspaceId: runtime.selection.get(),
        revision: null,
        contentHash: null,
        data: runtime.appearance.readState(),
      }),
    },
    {
      name: "appearance_set",
      title: "Set Appearance",
      description: "Sets the visible browser appearance preference.",
      inputSchema: {
        type: "object",
        required: ["choice"],
        properties: {
          choice: {
            type: "string",
            enum: ["system", "light", "dark", "tuxedo", "cardigan", "terminal"],
          },
        },
      },
      execute: async (input) => {
        try {
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: true,
            workspaceId: runtime.selection.get(),
            revision: null,
            contentHash: null,
            data: runtime.appearance.setChoice(
              input.choice as AppearanceChoice,
            ),
          };
        } catch (error) {
          const domain: DomainError = {
            code: "invalid_appearance",
            message:
              error instanceof Error
                ? error.message
                : "Invalid appearance choice.",
          };
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: false,
            workspaceId: runtime.selection.get(),
            revision: null,
            contentHash: null,
            error: domain,
          };
        }
      },
    },
  ];
  return handlers.map((tool) => guardTool(tool, runtime.selection));
}

export async function registerWebMcpTools(
  context: ModelContextAdapter | undefined,
  runtime: Runtime,
): Promise<{
  available: boolean;
  tools: readonly WebMcpTool[];
  dispose(): void;
  registerMock(evaluationId: string, contractName: string): Promise<string>;
}> {
  const controller = new AbortController();
  const mockControllers = new Map<string, AbortController>();
  const registerMock = async (
    evaluationId: string,
    contractName: string,
  ): Promise<string> => {
    if (!context) throw new Error("WebMCP is unavailable.");
    const workspaceId = runtime.selection.get();
    if (!workspaceId) throw new Error("Open a workspace first.");
    const name = `mock_${contractName.replace(/[^A-Za-z0-9_.-]/g, "_")}_${evaluationId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`;
    const registration = new AbortController();
    mockControllers.set(evaluationId, registration);
    await context.registerTool(
      guardTool(
        {
          name,
          title: `Mock ${contractName}`,
          description: `Invokes the deterministic mock for test run ${evaluationId}.`,
          inputSchema: { type: "object" },
          annotations: { untrustedContentHint: true },
          execute: async (input) => {
            const result = await runtime.service.invokeMock(
              workspaceId,
              evaluationId,
              input,
            );
            if (result.ok) {
              const refreshed = await runtime.service.open(workspaceId);
              if (refreshed.ok) runtime.onWorkspaceChange?.(refreshed.value);
            }
            return result.ok
              ? {
                  protocolVersion: PROTOCOL_VERSION,
                  ok: true,
                  workspaceId,
                  revision: result.value.evaluation.revision,
                  contentHash: result.value.evaluation.contentHash,
                  data: {
                    output: result.value.output,
                    transcript: (result.value.evaluation.data as any)
                      .transcript,
                  },
                }
              : {
                  protocolVersion: PROTOCOL_VERSION,
                  ok: false,
                  workspaceId,
                  revision: null,
                  contentHash: null,
                  error: result.error,
                };
          },
        },
        runtime.selection,
        workspaceId,
      ),
      { signal: registration.signal },
    );
    return name;
  };
  const unregisterMock = (evaluationId: string) => {
    mockControllers.get(evaluationId)?.abort();
    mockControllers.delete(evaluationId);
  };
  const tools = createToolHandlers({
    ...runtime,
    registerMockForRun: registerMock,
    unregisterMockForRun: unregisterMock,
  });
  if (!context)
    return {
      available: false,
      tools,
      dispose: () => controller.abort(),
      registerMock,
    };
  try {
    await Promise.all(
      tools.map((tool) =>
        context.registerTool(tool, { signal: controller.signal }),
      ),
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
  return {
    available: true,
    tools,
    dispose() {
      controller.abort();
      mockControllers.forEach((item) => item.abort());
    },
    registerMock,
  };
}

declare global {
  interface Document {
    modelContext?: ModelContextAdapter;
  }
}
