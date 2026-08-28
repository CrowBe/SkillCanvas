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
      const skillMd = input.skillMd === undefined ? EMPTY_SKILL : input.skillMd;
      const referenceFiles =
        input.referenceFiles === undefined ? [] : input.referenceFiles;
      const valid = validateInput(skillMd, referenceFiles);
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
      const referenceFiles =
        input.referenceFiles === undefined ? [] : input.referenceFiles;
      const valid = validateInput(input.skillMd, referenceFiles);
      if (!valid.ok) return valid;
      const result = await store.appendRevision({
        ...input,
        ...(input.referenceFiles !== undefined
          ? { referenceFiles: valid.value }
          : {}),
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
  skillMd: unknown,
  files: unknown,
): Result<readonly { path: string; content: string }[]> {
  if (typeof skillMd !== "string")
    return err("invalid_submission", "SKILL.md content must be a string.");
  if (!Array.isArray(files))
    return err("invalid_submission", "Reference files must be an array.");
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
    if (
      !isSchemaObject(file) ||
      typeof (file as Record<string, unknown>).path !== "string" ||
      typeof (file as Record<string, unknown>).content !== "string"
    )
      return err(
        "invalid_submission",
        "Each reference file requires string path and content fields.",
      );
    const shaped = file as { path: string; content: string };
    const path = normalizeReferencePath(shaped.path);
    if (!path.ok) return path;
    if (seen.has(path.value.toLowerCase()))
      return err("duplicate_path", `Duplicate normalized path: ${path.value}`);
    if (byteLength(shaped.content) > REFERENCE_MAX_BYTES)
      return err("size_limit", `Reference file ${path.value} is too large.`);
    seen.add(path.value.toLowerCase());
    normalized.push({ path: path.value, content: shaped.content });
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
  const common = longestCommonSubsequence(left, right, {
    remaining: 8_000_000,
  });
  if (common === null) return boundedLineChanges(left, right);
  const changedLines = new Set<number>();
  let additions = 0;
  let deletions = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  for (const [nextLeft, nextRight] of [
    ...common,
    [left.length, right.length] as const,
  ]) {
    deletions += nextLeft - leftIndex;
    additions += nextRight - rightIndex;
    for (let index = rightIndex; index < nextRight; index += 1)
      changedLines.add(index + 1);
    if (nextLeft > leftIndex && nextRight === rightIndex)
      changedLines.add(Math.min(rightIndex + 1, Math.max(right.length, 1)));
    leftIndex = nextLeft + 1;
    rightIndex = nextRight + 1;
  }
  return {
    additions,
    deletions,
    changedLines: [...changedLines].sort((a, b) => a - b),
  };
}

function longestCommonSubsequence(
  left: readonly string[],
  right: readonly string[],
  budget: { remaining: number },
  leftOffset = 0,
  rightOffset = 0,
): readonly (readonly [number, number])[] | null {
  if (left.length === 0 || right.length === 0) return [];
  if (left.length === 1) {
    const match = right.indexOf(left[0]!);
    return match < 0 ? [] : [[leftOffset, rightOffset + match]];
  }
  const middle = Math.floor(left.length / 2);
  const prefix = lcsLengths(left.slice(0, middle), right, budget);
  if (prefix === null) return null;
  const suffix = lcsLengths(
    left.slice(middle).reverse(),
    [...right].reverse(),
    budget,
  );
  if (suffix === null) return null;
  let split = 0;
  for (let index = 1; index <= right.length; index += 1)
    if (
      prefix[index]! + suffix[right.length - index]! >
      prefix[split]! + suffix[right.length - split]!
    )
      split = index;
  const leftMatches = longestCommonSubsequence(
    left.slice(0, middle),
    right.slice(0, split),
    budget,
    leftOffset,
    rightOffset,
  );
  if (leftMatches === null) return null;
  const rightMatches = longestCommonSubsequence(
    left.slice(middle),
    right.slice(split),
    budget,
    leftOffset + middle,
    rightOffset + split,
  );
  return rightMatches === null ? null : [...leftMatches, ...rightMatches];
}

function lcsLengths(
  left: readonly string[],
  right: readonly string[],
  budget: { remaining: number },
): number[] | null {
  const comparisons = left.length * right.length;
  if (comparisons > budget.remaining) return null;
  budget.remaining -= comparisons;
  let previous = Array<number>(right.length + 1).fill(0);
  for (const line of left) {
    const current = Array<number>(right.length + 1).fill(0);
    for (let index = 0; index < right.length; index += 1)
      current[index + 1] =
        line === right[index]
          ? previous[index]! + 1
          : Math.max(current[index]!, previous[index + 1]!);
    previous = current;
  }
  return previous;
}

function boundedLineChanges(left: readonly string[], right: readonly string[]) {
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix += 1;
  const deletions = left.length - prefix - suffix;
  const additions = right.length - prefix - suffix;
  const changedLines = Array.from(
    { length: additions },
    (_, index) => prefix + index + 1,
  );
  if (deletions > 0 && additions === 0)
    changedLines.push(Math.min(prefix + 1, Math.max(right.length, 1)));
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
    const evaluationIssue = evaluationRecordError(evaluation);
    if (evaluationIssue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid evaluation record: ${evaluationIssue}`,
      );
    const dataIssue = evaluationDataError(evaluation.kind, evaluation.data);
    if (dataIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} has invalid data: ${dataIssue}`,
      );
  }
  for (const artifact of snapshot.artifacts) {
    const issue = artifactRecordError(artifact);
    if (issue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid artifact record: ${issue}`,
      );
  }
  for (const event of snapshot.auditEvents) {
    const issue = auditEventError(event);
    if (issue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid audit event: ${issue}`,
      );
  }
  return ok(snapshot as WorkspaceSnapshot);
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
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
          typeof (choice as Record<string, unknown>).id !== "string" ||
          typeof (choice as Record<string, unknown>).name !== "string" ||
          typeof (choice as Record<string, unknown>).description !== "string" ||
          typeof (choice as Record<string, unknown>).candidate !== "boolean"
        )
          return "a triggering choice requires id, name, description, and candidate fields.";
      const choices = (item as { choices: Array<Record<string, unknown>> })
        .choices;
      if (
        new Set(choices.map((choice) => choice.id)).size !== choices.length ||
        choices.filter((choice) => choice.candidate).length !== 1
      )
        return "a triggering case requires unique choice ids and exactly one candidate.";
    }
    if (record.observations.length > record.cases.length)
      return "a triggering evaluation has too many observations.";
    for (const [index, observation] of record.observations.entries())
      if (
        !isSchemaObject(observation) ||
        typeof observation.caseId !== "string" ||
        typeof observation.selectedChoiceId !== "string" ||
        typeof observation.rationale !== "string" ||
        typeof observation.passed !== "boolean" ||
        observation.suppliedBy !== "visiting browser agent" ||
        typeof observation.submittedAt !== "string"
      )
        return "a triggering observation is incomplete.";
      else {
        const testCase = record.cases[index] as Record<string, unknown>;
        const choices = testCase.choices as Array<Record<string, unknown>>;
        const choice = choices.find(
          (candidate) => candidate.id === observation.selectedChoiceId,
        );
        const expectedCandidate = testCase.expected === "fire";
        if (
          observation.caseId !== testCase.id ||
          !choice ||
          observation.passed !== (choice.candidate === expectedCandidate)
        )
          return "triggering observations must match case order and grading.";
      }
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
    for (const step of record.transcript) {
      if (!isSchemaObject(step)) return "a transcript step must be an object.";
      if (step.kind !== "tool-call" && step.kind !== "tool-result")
        return "a transcript step has an unsupported kind.";
      if (typeof step.tool !== "string" || typeof step.at !== "string")
        return "a transcript step requires tool and timestamp fields.";
      if (step.kind === "tool-call" ? !("input" in step) : !("output" in step))
        return `a ${step.kind} transcript step is incomplete.`;
    }
    if (record.checks !== undefined) {
      if (!Array.isArray(record.checks))
        return "test-run checks must be an array.";
      for (const check of record.checks)
        if (
          !isSchemaObject(check) ||
          typeof check.id !== "string" ||
          typeof check.passed !== "boolean" ||
          typeof check.message !== "string" ||
          check.deterministic !== true
        )
          return "a test-run check is incomplete.";
    }
    return null;
  }
  return "unsupported evaluation kind.";
}

function evaluationRecordError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "record must be an object.";
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !Number.isInteger(value.revision) ||
    typeof value.contentHash !== "string" ||
    typeof value.kind !== "string" ||
    !["prepared", "in-progress", "complete"].includes(value.status as string) ||
    !isSchemaObject(value.versions) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  )
    return "required metadata is missing.";
  return null;
}

function artifactRecordError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "record must be an object.";
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    !Number.isInteger(value.revision) ||
    ![
      "lint",
      "structure",
      "instruction-map",
      "instruction-load",
      "compare",
    ].includes(value.kind as string) ||
    typeof value.version !== "string" ||
    typeof value.createdAt !== "string" ||
    !("data" in value)
  )
    return "required metadata is missing.";
  return null;
}

function auditEventError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "record must be an object.";
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.at !== "string" ||
    !["human", "webmcp", "system"].includes(value.actor as string) ||
    typeof value.action !== "string" ||
    (value.revision !== undefined && !Number.isInteger(value.revision)) ||
    (value.details !== undefined && !isSchemaObject(value.details))
  )
    return "required metadata is missing.";
  return null;
}
