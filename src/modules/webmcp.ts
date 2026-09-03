import type { AppearanceChoice, AppearanceController } from "./appearance";
import {
  PROTOCOL_VERSION,
  type DomainError,
  type Result,
  type ToolEnvelope,
} from "./shared";
import { validateSchema, type ToolContract } from "./evaluations";
import { evaluationView } from "./workspace/view";
import type { EvaluationRecord, WorkspaceBundle } from "./workspace/types";
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
export type MockRegistrationStatus = "registered" | "unavailable" | "completed";

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
    workspaceId: string,
    evaluationId: string,
    contractName: string,
  ) => Promise<string>;
  unregisterMockForRun?: (evaluationId: string) => void;
  onMockRegistrationChange?: (
    evaluationId: string,
    status: MockRegistrationStatus,
  ) => void;
};

function normalizeWebMcpInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  if (input.trim() === "") return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function guardTool(
  tool: WebMcpTool,
  selection: WorkspaceSelection,
  workspaceId?: string,
): WebMcpTool {
  return {
    ...tool,
    execute: async (input, options) => {
      const normalized = normalizeWebMcpInput(input);
      try {
        if (tool.inputSchema) {
          const issues = validateSchema(normalized, tool.inputSchema);
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
        return await tool.execute(normalized, options);
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
      description:
        "Appends a full SKILL.md replacement from a base revision. baseRevision must equal the current tip revision; a stale value returns revision_conflict and never overwrites.",
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
        'Validates a visiting-agent instruction map pinned to the current revision. The map object requires: status "proposed"; revision equal to the current tip; scopes[] as {id, label, parentId?}; requirements[] as {id, sourceSpan: {start, end}, statement, kind ("action"|"constraint"|"condition"|"prohibition"|"preference"), scopeId (an existing scope id), dependencies[] (other requirement ids), verifiability ("deterministic"|"semantic-judgment"|"unverified")}. Every sourceSpan must select non-empty text within the current SKILL.md. Submit with accept:false to store it as a proposal; acceptance is an explicit human action.',
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
        'Prepares a triggering evaluation or mocked test run for the current revision. kind "triggering" takes no extra fields and returns one prompt case; kind "test-run" requires contract: {name, description, inputSchema (JSON Schema), outputSchema (JSON Schema — required by the workbench validator), mockOutput?}. The tool\'s optional responseSchema property is ignored; put output expectations in contract.outputSchema. A test-run also registers a run-scoped mock tool named mock_<contract>_<id> for deterministic invocation.',
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
        const prepared = result.ok ? evaluationView(result.value) : null;
        if (prepared?.kind === "test-run" && runtime.registerMockForRun) {
          try {
            const mockToolName = await runtime.registerMockForRun(
              bundle.value.workspace.id,
              prepared.record.id,
              prepared.data.contract.name,
            );
            return bundleEnvelope(
              {
                ok: true,
                value: { evaluation: prepared.record, mockToolName },
              },
              bundle.value,
            );
          } catch {
            return bundleEnvelope(
              {
                ok: true,
                value: {
                  evaluation: prepared.record,
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
        'Records one visiting-agent judgment or final test-run output and grades deterministic properties. Triggering: submit ONE case at a time as {kind: "triggering", caseId, selectedChoiceId (a choice id from that case), rationale} — batched case arrays are refused; each envelope returns the next case; the run completes after the last case. Test-run: {kind: "test-run", finalOutput} must match contract.outputSchema.',
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
      name: "workspace_snapshot_export",
      title: "Export Workspace Snapshot",
      description:
        "Downloads the evidence-free workspace as JSON; evaluations and comparisons must be regenerated locally after import.",
      execute: async () => {
        const bundle = await current();
        if (!bundle.ok) return bundleEnvelope(bundle);
        const result = await runtime.service.exportSnapshot(
          bundle.value.workspace.id,
        );
        if (result.ok)
          runtime.download?.(
            `${bundle.value.workspace.name}.workbench.json`,
            result.value,
            "application/json",
          );
        return bundleEnvelope(
          result.ok
            ? {
                ok: true,
                value: {
                  filename: `${bundle.value.workspace.name}.workbench.json`,
                  bytes: new TextEncoder().encode(result.value).byteLength,
                  includesDeterministicEvidence: false,
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
        "Imports a bounded evidence-free workbench snapshot; evaluation and comparison evidence is rejected and must be regenerated locally.",
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
      description:
        'Sets the visible browser appearance preference. Optionally pass a short rationale for the choice — it is shown in the UI as a visible collaboration note ("your agent set this theme because …"). Appearance is a browser preference only: it never changes Skill content, revisions, hashes, evidence, or snapshots.',
      inputSchema: {
        type: "object",
        required: ["choice"],
        properties: {
          choice: {
            type: "string",
            enum: ["system", "light", "dark", "tuxedo", "cardigan", "terminal"],
          },
          agentRationale: { type: "string", maxLength: 280 },
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
              {
                agentRationale:
                  typeof input.agentRationale === "string"
                    ? input.agentRationale
                    : undefined,
              },
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
  registerMock(
    workspaceId: string,
    evaluationId: string,
    contractName: string,
  ): Promise<string>;
  reconcileMockRegistrations(
    workspaceId: string | null,
    evaluations: readonly EvaluationRecord[],
  ): void;
  unregisterMockForRun(evaluationId: string): void;
}> {
  const controller = new AbortController();
  const mockControllers = new Map<
    string,
    { controller: AbortController; workspaceId: string }
  >();
  const registerMock = async (
    workspaceId: string,
    evaluationId: string,
    contractName: string,
  ): Promise<string> => {
    if (!context) {
      runtime.onMockRegistrationChange?.(evaluationId, "unavailable");
      throw new Error("WebMCP is unavailable.");
    }
    mockControllers.get(evaluationId)?.controller.abort();
    mockControllers.delete(evaluationId);
    const name = `mock_${contractName.replace(/[^A-Za-z0-9_.-]/g, "_")}_${evaluationId.replace(/[^A-Za-z0-9]/g, "").slice(-12)}`;
    const registration = new AbortController();
    mockControllers.set(evaluationId, {
      controller: registration,
      workspaceId,
    });
    try {
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
              if (!result.ok)
                return {
                  protocolVersion: PROTOCOL_VERSION,
                  ok: false,
                  workspaceId,
                  revision: null,
                  contentHash: null,
                  error: result.error,
                };
              const refreshed = await runtime.service.open(workspaceId);
              if (refreshed.ok) runtime.onWorkspaceChange?.(refreshed.value);
              const invoked = evaluationView(result.value.evaluation);
              return {
                protocolVersion: PROTOCOL_VERSION,
                ok: true,
                workspaceId,
                revision: result.value.evaluation.revision,
                contentHash: result.value.evaluation.contentHash,
                data: {
                  output: result.value.output,
                  transcript:
                    invoked?.kind === "test-run" ? invoked.data.transcript : [],
                },
              };
            },
          },
          runtime.selection,
          workspaceId,
        ),
        { signal: registration.signal },
      );
    } catch (error) {
      if (mockControllers.get(evaluationId)?.controller === registration) {
        mockControllers.delete(evaluationId);
        registration.abort();
        runtime.onMockRegistrationChange?.(evaluationId, "unavailable");
      }
      throw error;
    }
    if (
      registration.signal.aborted ||
      mockControllers.get(evaluationId)?.controller !== registration
    )
      throw new Error("Mock registration was superseded or evicted.");
    runtime.onMockRegistrationChange?.(evaluationId, "registered");
    return name;
  };
  const removeMock = (
    evaluationId: string,
    status: Exclude<MockRegistrationStatus, "registered">,
  ) => {
    mockControllers.get(evaluationId)?.controller.abort();
    mockControllers.delete(evaluationId);
    runtime.onMockRegistrationChange?.(evaluationId, status);
  };
  const unregisterMock = (evaluationId: string) =>
    removeMock(evaluationId, "completed");
  const reconcileMockRegistrations = (
    workspaceId: string | null,
    evaluations: readonly EvaluationRecord[],
  ) => {
    const loadedById = new Map(
      evaluations.map((evaluation) => [evaluation.id, evaluation]),
    );
    for (const [evaluationId, registration] of mockControllers)
      if (registration.workspaceId !== workspaceId)
        removeMock(evaluationId, "unavailable");
      else {
        const loaded = loadedById.get(evaluationId);
        if (!loaded) removeMock(evaluationId, "unavailable");
        else if (loaded.status === "complete")
          removeMock(evaluationId, "completed");
      }
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
      reconcileMockRegistrations,
      unregisterMockForRun: unregisterMock,
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
      mockControllers.forEach((item) => item.controller.abort());
    },
    registerMock,
    reconcileMockRegistrations,
    unregisterMockForRun: unregisterMock,
  };
}

declare global {
  interface Document {
    modelContext?: ModelContextAdapter;
  }
}
