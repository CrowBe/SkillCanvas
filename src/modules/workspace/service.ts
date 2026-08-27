import JSZip from "jszip";
import {
  analyzeLint,
  analyzeStructure,
  type LintArtifact,
  type StructureArtifact,
} from "../analysis";
import {
  instructionLoadVector,
  validateInstructionMap,
  type InstructionMap,
} from "../instruction-map";
import {
  invokeMockTool,
  schemaSubsetError,
  prepareTestRun,
  prepareTriggering,
  submitTestRun,
  submitTriggering,
  type JsonSchema,
  type ToolContract,
} from "../evaluations";
import {
  byteLength,
  err,
  normalizeReferencePath,
  ok,
  REFERENCE_MAX_BYTES,
  REFERENCES_MAX,
  RULESET_VERSION,
  SNAPSHOT_MAX_BYTES,
  type DomainError,
  type Result,
} from "../shared";
import { EMPTY_SKILL, parseSkillMd } from "../skill";
import type {
  ArtifactRecord,
  AuditEvent,
  EvaluationKind,
  EvaluationRecord,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceStore,
} from "./types";

export interface WorkspaceService {
  create(input?: {
    name?: string;
    skillMd?: string;
    referenceFiles?: readonly { path: string; content: string }[];
    ephemeral?: boolean;
    actor?: AuditEvent["actor"];
  }): Promise<Result<WorkspaceBundle>>;
  list(): ReturnType<WorkspaceStore["listWorkspaces"]>;
  open(
    workspaceId: string,
    revision?: number,
  ): Promise<Result<WorkspaceBundle>>;
  update(input: {
    workspaceId: string;
    baseRevision: number;
    skillMd: string;
    referenceFiles?: readonly { path: string; content: string }[];
    actor: AuditEvent["actor"];
  }): Promise<Result<WorkspaceBundle>>;
  analyze(
    workspaceId: string,
    capabilities: readonly ("lint" | "structure")[],
  ): Promise<Result<{ lint?: LintArtifact; structure?: StructureArtifact }>>;
  submitInstructionMap(
    workspaceId: string,
    map: unknown,
    accept: boolean,
  ): Promise<
    Result<{
      map: InstructionMap;
      vector?: ReturnType<typeof instructionLoadVector>;
    }>
  >;
  compare(
    workspaceId: string,
    beforeRevision: number,
    afterRevision: number,
  ): Promise<Result<CompareArtifact>>;
  prepareEvaluation(
    workspaceId: string,
    kind: EvaluationKind,
    options?: { contract?: ToolContract; responseSchema?: JsonSchema },
  ): Promise<Result<EvaluationRecord>>;
  submitEvaluation(
    workspaceId: string,
    evaluationId: string,
    input: unknown,
  ): Promise<Result<EvaluationRecord>>;
  invokeMock(
    workspaceId: string,
    evaluationId: string,
    input: unknown,
  ): Promise<Result<{ evaluation: EvaluationRecord; output: unknown }>>;
  exportSkill(workspaceId: string): Promise<Result<Uint8Array>>;
  exportSnapshot(workspaceId: string): Promise<Result<string>>;
  importSnapshot(json: string): Promise<Result<WorkspaceBundle>>;
}

export type CompareArtifact = {
  readonly kind: "compare";
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly source: {
    readonly additions: number;
    readonly deletions: number;
    readonly changedLines: readonly number[];
  };
  readonly lint: {
    readonly before: Pick<LintArtifact, "score" | "grade" | "counts">;
    readonly after: Pick<LintArtifact, "score" | "grade" | "counts">;
  };
  readonly evaluationReferences: readonly {
    readonly id: string;
    readonly kind: EvaluationKind;
    readonly revision: number;
    readonly status: EvaluationRecord["status"];
  }[];
};

export function createWorkspaceService(
  store: WorkspaceStore,
): WorkspaceService {
  const open = async (
    workspaceId: string,
    revision?: number,
  ): Promise<Result<WorkspaceBundle>> =>
    fromStore(await store.openWorkspace(workspaceId, revision));
  return {
    async create(input = {}) {
      const skillMd = input.skillMd ?? EMPTY_SKILL;
      const valid = validateInput(skillMd, input.referenceFiles ?? []);
      if (!valid.ok) return valid;
      return ok(
        await store.createWorkspace({
          name: input.name ?? parsedName(skillMd),
          skillMd,
          referenceFiles: valid.value,
          ephemeral: input.ephemeral,
          actor: input.actor,
        }),
      );
    },
    list: () => store.listWorkspaces(),
    open,
    async update(input) {
      const valid = validateInput(input.skillMd, input.referenceFiles ?? []);
      if (!valid.ok) return valid;
      const result = await store.appendRevision({
        ...input,
        ...(input.referenceFiles ? { referenceFiles: valid.value } : {}),
      });
      return fromStore(result);
    },
    async analyze(workspaceId, capabilities) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      const result: { lint?: LintArtifact; structure?: StructureArtifact } = {};
      if (capabilities.includes("lint")) {
        result.lint = analyzeLint(
          bundle.value.skillMd,
          bundle.value.referenceFiles.map((file) => file.path),
        );
        await store.putArtifact(artifact(bundle.value, "lint", result.lint));
      }
      if (capabilities.includes("structure")) {
        result.structure = analyzeStructure(bundle.value.skillMd);
        await store.putArtifact(
          artifact(bundle.value, "structure", result.structure),
        );
      }
      return ok(result);
    },
    async submitInstructionMap(workspaceId, map, accept) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      const checked = validateInstructionMap(
        map,
        bundle.value.skillMd,
        bundle.value.revision.revision,
      );
      if (!checked.ok) return checked;
      const acceptedMap: InstructionMap = {
        ...checked.value,
        status: accept ? "accepted" : "proposed",
        suppliedBy: "visiting-agent proposal",
      };
      await store.putArtifact(
        artifact(bundle.value, "instruction-map", acceptedMap),
      );
      if (!accept) return ok({ map: acceptedMap });
      const vector = instructionLoadVector(acceptedMap);
      await store.putArtifact(
        artifact(bundle.value, "instruction-load", vector),
      );
      return ok({ map: acceptedMap, vector });
    },
    async compare(workspaceId, beforeRevision, afterRevision) {
      const before = await open(workspaceId, beforeRevision);
      if (!before.ok) return before;
      const after = await open(workspaceId, afterRevision);
      if (!after.ok) return after;
      const beforeLint = analyzeLint(
        before.value.skillMd,
        before.value.referenceFiles.map((file) => file.path),
      );
      const afterLint = analyzeLint(
        after.value.skillMd,
        after.value.referenceFiles.map((file) => file.path),
      );
      const source = lineDiff(before.value.skillMd, after.value.skillMd);
      const evaluationReferences = after.value.evaluations
        .filter(
          (evaluation) =>
            evaluation.revision === beforeRevision ||
            evaluation.revision === afterRevision,
        )
        .map(({ id, kind, revision, status }) => ({
          id,
          kind,
          revision,
          status,
        }));
      const data: CompareArtifact = {
        kind: "compare",
        beforeRevision,
        afterRevision,
        source,
        lint: { before: summary(beforeLint), after: summary(afterLint) },
        evaluationReferences,
      };
      await store.putArtifact(artifact(after.value, "compare", data));
      return ok(data);
    },
    async prepareEvaluation(workspaceId, kind, options) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      let evaluation: EvaluationRecord;
      if (kind === "triggering")
        evaluation = await prepareTriggering(bundle.value);
      else if (kind === "test-run") {
        if (!options?.contract)
          return err(
            "invalid_submission",
            "A Tool contract is required for a test run.",
          );
        const contractError = toolContractError(options.contract);
        if (contractError) return err("invalid_submission", contractError);
        if (options.responseSchema !== undefined) {
          const schemaError = schemaSubsetError(
            options.responseSchema,
            "responseSchema",
          );
          if (schemaError) return err("invalid_submission", schemaError);
        }
        evaluation = prepareTestRun(
          bundle.value,
          options.contract,
          options.responseSchema,
        );
      } else
        return err(
          "invalid_submission",
          "Capacity probes require an accepted instruction map and are deferred in this proof.",
        );
      await store.recordEvaluationEvidence(evaluation);
      return ok(evaluation);
    },
    async submitEvaluation(workspaceId, evaluationId, input) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      const evaluation = bundle.value.evaluations.find(
        (item) => item.id === evaluationId,
      );
      if (!evaluation)
        return err("evaluation_not_found", "Evaluation was not found.");
      const result =
        evaluation.kind === "triggering"
          ? submitTriggering(
              evaluation,
              input as {
                caseId: string;
                selectedChoiceId: string;
                rationale: string;
              },
            )
          : evaluation.kind === "test-run"
            ? submitTestRun(
                evaluation,
                (input as { finalOutput?: unknown })?.finalOutput ?? input,
              )
            : err("invalid_submission", "Unsupported evaluation kind.");
      if (!result.ok) return result;
      await store.recordEvaluationEvidence(result.value);
      return result;
    },
    async invokeMock(workspaceId, evaluationId, input) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      const evaluation = bundle.value.evaluations.find(
        (item) => item.id === evaluationId,
      );
      if (!evaluation)
        return err("evaluation_not_found", "Evaluation was not found.");
      const result = invokeMockTool(evaluation, input);
      if (!result.ok) return result;
      await store.recordEvaluationEvidence(result.value.record);
      return ok({
        evaluation: result.value.record,
        output: result.value.output,
      });
    },
    async exportSkill(workspaceId) {
      const bundle = await open(workspaceId);
      if (!bundle.ok) return bundle;
      const zip = new JSZip();
      zip.file("SKILL.md", bundle.value.skillMd);
      for (const file of bundle.value.referenceFiles)
        zip.file(file.path, file.content);
      return ok(
        await zip.generateAsync({
          type: "uint8array",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        }),
      );
    },
    async exportSnapshot(workspaceId) {
      const snapshot = await store.exportSnapshot(workspaceId);
      return "code" in snapshot
        ? { ok: false, error: snapshot }
        : ok(JSON.stringify(snapshot, null, 2));
    },
    async importSnapshot(json) {
      if (byteLength(json) > SNAPSHOT_MAX_BYTES)
        return err(
          "size_limit",
          `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`,
        );
      let snapshot: WorkspaceSnapshot;
      try {
        snapshot = JSON.parse(json) as WorkspaceSnapshot;
      } catch {
        return err("invalid_snapshot", "Snapshot is not valid JSON.");
      }
      const shape = validateSnapshotShape(snapshot);
      if (!shape.ok) return shape;
      const result = await store.importSnapshot(snapshot);
      return fromStore(result);
    },
  };
}

function validateInput(
  skillMd: string,
  files: readonly { path: string; content: string }[],
): Result<readonly { path: string; content: string }[]> {
  const parsed = parseSkillMd(skillMd);
  if (!parsed.ok) return parsed;
  if (files.length > REFERENCES_MAX)
    return err(
      "size_limit",
      `A Skill may include at most ${REFERENCES_MAX} reference files.`,
    );
  const normalized: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = normalizeReferencePath(file.path);
    if (!path.ok) return path;
    if (seen.has(path.value.toLowerCase()))
      return err("duplicate_path", `Duplicate normalized path: ${path.value}`);
    if (byteLength(file.content) > REFERENCE_MAX_BYTES)
      return err("size_limit", `Reference file ${path.value} is too large.`);
    seen.add(path.value.toLowerCase());
    normalized.push({ path: path.value, content: file.content });
  }
  return ok(normalized);
}
function fromStore<T>(value: T | DomainError): Result<T> {
  return typeof value === "object" && value !== null && "code" in value
    ? { ok: false, error: value as DomainError }
    : ok(value as T);
}
function artifact(
  bundle: WorkspaceBundle,
  kind: ArtifactRecord["kind"],
  data: unknown,
): ArtifactRecord {
  return {
    id: `${bundle.workspace.id}:${bundle.revision.revision}:${kind}`,
    workspaceId: bundle.workspace.id,
    revision: bundle.revision.revision,
    kind,
    version: RULESET_VERSION,
    createdAt: new Date().toISOString(),
    data,
  };
}
function parsedName(raw: string): string {
  const parsed = parseSkillMd(raw);
  return parsed.ok ? parsed.value.frontmatter.name : "Untitled Skill";
}
function summary(lint: LintArtifact) {
  return { score: lint.score, grade: lint.grade, counts: lint.counts };
}
function lineDiff(before: string, after: string) {
  const left = before.split("\n");
  const right = after.split("\n");
  const max = Math.max(left.length, right.length);
  const changedLines: number[] = [];
  let additions = 0;
  let deletions = 0;
  for (let index = 0; index < max; index += 1)
    if (left[index] !== right[index]) {
      changedLines.push(index + 1);
      if (right[index] !== undefined) additions += 1;
      if (left[index] !== undefined) deletions += 1;
    }
  return { additions, deletions, changedLines };
}
function validateSnapshotShape(value: unknown): Result<WorkspaceSnapshot> {
  if (!value || typeof value !== "object")
    return err("invalid_snapshot", "Snapshot must be an object.");
  const snapshot = value as Partial<WorkspaceSnapshot>;
  if (
    snapshot.snapshotVersion !== 1 ||
    !snapshot.workspace ||
    typeof snapshot.workspace.id !== "string" ||
    !Array.isArray(snapshot.revisions) ||
    !Array.isArray(snapshot.blobs) ||
    !Array.isArray(snapshot.artifacts) ||
    !Array.isArray(snapshot.evaluations) ||
    !Array.isArray(snapshot.auditEvents)
  )
    return err("invalid_snapshot", "Snapshot shape or version is invalid.");
  if (
    snapshot.revisions.length > 1000 ||
    snapshot.blobs.length > 1025 ||
    snapshot.artifacts.length > 5000 ||
    snapshot.evaluations.length > 1000 ||
    snapshot.auditEvents.length > 10000
  )
    return err(
      "size_limit",
      "Snapshot record count exceeds the workbench bounds.",
    );
  const blobs = new Map<string, string>();
  for (const blob of snapshot.blobs) {
    if (
      !blob ||
      typeof blob.hash !== "string" ||
      typeof blob.content !== "string" ||
      typeof blob.bytes !== "number"
    )
      return err(
        "invalid_snapshot",
        "Snapshot contains an invalid blob record.",
      );
    blobs.set(blob.hash, blob.content);
  }
  for (const revision of snapshot.revisions) {
    if (
      !revision ||
      typeof revision.contentHash !== "string" ||
      !Number.isInteger(revision.revision) ||
      !Array.isArray(revision.references)
    )
      return err(
        "invalid_snapshot",
        "Snapshot contains an invalid revision record.",
      );
    const skillMd = blobs.get(revision.contentHash);
    if (skillMd === undefined)
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} points to a missing Skill blob.`,
      );
    const references: { path: string; content: string }[] = [];
    for (const reference of revision.references) {
      const content =
        reference && typeof reference === "object"
          ? blobs.get(reference.contentHash)
          : undefined;
      if (
        !reference ||
        typeof reference !== "object" ||
        typeof reference.path !== "string" ||
        content === undefined
      )
        return err(
          "invalid_snapshot",
          `Revision ${revision.revision} has an invalid reference pointer.`,
        );
      references.push({ path: reference.path, content });
    }
    const validated = validateInput(skillMd, references);
    if (!validated.ok) return validated;
  }
  for (const evaluation of snapshot.evaluations) {
    if (!evaluation || typeof evaluation !== "object")
      return err(
        "invalid_snapshot",
        "Snapshot contains an invalid evaluation record.",
      );
    const dataIssue = evaluationDataError(evaluation.kind, evaluation.data);
    if (dataIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} has invalid data: ${dataIssue}`,
      );
  }
  return ok(snapshot as WorkspaceSnapshot);
}

function isSchemaObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolContractError(contract: unknown): string | null {
  if (!isSchemaObject(contract)) return "The Tool contract must be an object.";
  const candidate = contract as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "")
    return "The Tool contract requires a name.";
  if (
    candidate.description !== undefined &&
    typeof candidate.description !== "string"
  )
    return "The Tool contract description must be a string.";
  if (!isSchemaObject(candidate.inputSchema))
    return "The Tool contract requires an inputSchema object.";
  if (!isSchemaObject(candidate.outputSchema))
    return "The Tool contract requires an outputSchema object.";
  return (
    schemaSubsetError(candidate.inputSchema, "inputSchema") ??
    schemaSubsetError(candidate.outputSchema, "outputSchema")
  );
}

function evaluationDataError(kind: unknown, data: unknown): string | null {
  if (!isSchemaObject(data)) return "evaluation data must be an object.";
  const record = data as Record<string, unknown>;
  if (kind === "triggering") {
    if (!Array.isArray(record.cases) || !Array.isArray(record.observations))
      return "a triggering evaluation requires cases and observations arrays.";
    for (const item of record.cases) {
      if (
        !isSchemaObject(item) ||
        typeof (item as Record<string, unknown>).id !== "string" ||
        typeof (item as Record<string, unknown>).prompt !== "string" ||
        !Array.isArray((item as Record<string, unknown>).choices)
      )
        return "a triggering case requires an id, a prompt, and a choices array.";
      const expected = (item as Record<string, unknown>).expected;
      if (expected !== "fire" && expected !== "silent")
        return 'a triggering case expects exactly "fire" or "silent".';
      for (const choice of (item as { choices: unknown[] }).choices)
        if (
          !isSchemaObject(choice) ||
          typeof (choice as Record<string, unknown>).id !== "string"
        )
          return "a triggering choice requires an id.";
    }
    for (const observation of record.observations)
      if (
        !isSchemaObject(observation) ||
        typeof (observation as Record<string, unknown>).caseId !== "string"
      )
        return "a triggering observation requires a caseId.";
    return null;
  }
  if (kind === "test-run") {
    const contractIssue = toolContractError(record.contract);
    if (contractIssue) return contractIssue;
    if (record.responseSchema !== undefined) {
      const schemaIssue = schemaSubsetError(
        record.responseSchema,
        "responseSchema",
      );
      if (schemaIssue) return schemaIssue;
    }
    if (
      !isSchemaObject(record.scenario) ||
      typeof (record.scenario as Record<string, unknown>).prompt !== "string"
    )
      return "a test run requires a scenario with a prompt.";
    if (!Array.isArray(record.transcript))
      return "a test run requires a transcript array.";
    for (const step of record.transcript)
      if (
        !isSchemaObject(step) ||
        typeof (step as Record<string, unknown>).kind !== "string"
      )
        return "a transcript step requires a kind.";
    if (record.checks !== undefined && !Array.isArray(record.checks))
      return "test-run checks must be an array.";
    return null;
  }
  return null;
}
