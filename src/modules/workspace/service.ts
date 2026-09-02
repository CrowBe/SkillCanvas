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
  DomainMutationError,
  err,
  isJsonObject,
  ok,
  RULESET_VERSION,
  type DomainError,
  type Result,
} from "../shared";
import { EMPTY_SKILL, parseSkillMd, validateSkillInput } from "../skill";
import type {
  ArtifactRecord,
  AuditEvent,
  EvaluationKind,
  EvaluationRecord,
  WorkspaceBundle,
  WorkspaceRecord,
  WorkspaceReplacementTarget,
  WorkspaceStore,
} from "./types";
import {
  admitSnapshot,
  PortableSnapshotSizeError,
  portableSnapshotJson,
} from "./snapshot-admission";
import {
  canonicalArtifactId,
  type ArtifactDataByKind,
  type ArtifactKind,
  type CompareArtifact,
} from "./artifacts";

export type { CompareArtifact } from "./artifacts";

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
  exportSnapshot(workspaceId: string): Promise<Result<string>>;
  inspectSnapshotImport(json: string): Promise<
    Result<{
      incomingWorkspace: WorkspaceRecord;
      existingWorkspace?: WorkspaceRecord;
      replacementTarget?: WorkspaceReplacementTarget;
      collision: boolean;
    }>
  >;
  importSnapshot(json: string): Promise<Result<WorkspaceBundle>>;
  replaceSnapshot(
    json: string,
    replacementTarget: WorkspaceReplacementTarget,
  ): Promise<Result<WorkspaceBundle>>;
}

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
      const valid = validateSkillInput(skillMd, referenceFiles);
      if (!valid.ok) return valid;
      try {
        return ok(
          await store.createWorkspace({
            name: input.name ?? parsedName(skillMd),
            skillMd,
            referenceFiles: valid.value,
            ephemeral: input.ephemeral,
            actor: input.actor,
          }),
        );
      } catch (error) {
        return snapshotMutationFailure(error);
      }
    },
    list: () => store.listWorkspaces(),
    open,
    async update(input) {
      const referenceFiles =
        input.referenceFiles === undefined ? [] : input.referenceFiles;
      const valid = validateSkillInput(input.skillMd, referenceFiles);
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
      const artifacts: ArtifactRecord[] = [];
      if (capabilities.includes("lint")) {
        result.lint = analyzeLint(
          bundle.value.skillMd,
          bundle.value.referenceFiles.map((file) => file.path),
        );
        artifacts.push(artifact(bundle.value, "lint", result.lint));
      }
      if (capabilities.includes("structure")) {
        result.structure = analyzeStructure(bundle.value.skillMd);
        artifacts.push(artifact(bundle.value, "structure", result.structure));
      }
      try {
        await store.updateArtifacts({
          workspaceId,
          revision: bundle.value.revision.revision,
          expectedContentHash: bundle.value.revision.contentHash,
          expectedGeneration: bundle.value.evidenceGeneration,
          artifacts,
        });
      } catch (error) {
        return snapshotMutationFailure(error);
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
      const mapArtifact = artifact(
        bundle.value,
        "instruction-map",
        acceptedMap,
      );
      const vector = accept ? instructionLoadVector(acceptedMap) : undefined;
      try {
        await store.updateArtifacts({
          workspaceId,
          revision: bundle.value.revision.revision,
          expectedContentHash: bundle.value.revision.contentHash,
          expectedGeneration: bundle.value.evidenceGeneration,
          artifacts: vector
            ? [mapArtifact, artifact(bundle.value, "instruction-load", vector)]
            : [mapArtifact],
          deleteIds: vector
            ? []
            : [artifactId(bundle.value, "instruction-load")],
        });
      } catch (error) {
        return snapshotMutationFailure(error);
      }
      return ok({ map: acceptedMap, ...(vector ? { vector } : {}) });
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
      const createdAt = nextComparisonTimestamp(after.value.artifacts);
      const comparisonInstance = crypto.randomUUID();
      const comparisonId = `${artifactId(after.value, "compare")}:${comparisonInstance}`;
      const evaluationReferences = after.value.evaluations
        .filter(
          (evaluation) =>
            evaluation.revision === beforeRevision ||
            evaluation.revision === afterRevision,
        )
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(evaluationReference);
      const data: CompareArtifact = {
        kind: "compare",
        beforeRevision,
        afterRevision,
        source,
        lint: { before: summary(beforeLint), after: summary(afterLint) },
        evaluationReferences,
      };
      try {
        await store.updateArtifacts({
          workspaceId,
          revision: after.value.revision.revision,
          expectedContentHash: after.value.revision.contentHash,
          expectedGeneration: after.value.evidenceGeneration,
          artifacts: [
            artifact(after.value, "compare", data, createdAt, comparisonId),
          ],
        });
      } catch (error) {
        return snapshotMutationFailure(error);
      }
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
        evaluation = await prepareTestRun(
          bundle.value,
          options.contract,
          options.responseSchema,
        );
      } else
        return err(
          "invalid_submission",
          "Capacity probes require an accepted instruction map and are deferred in this proof.",
        );
      try {
        await store.recordEvaluationEvidence(evaluation);
      } catch (error) {
        return snapshotMutationFailure(error);
      }
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
                isJsonObject(input) && "finalOutput" in input
                  ? input.finalOutput
                  : input,
              )
            : err("invalid_submission", "Unsupported evaluation kind.");
      if (!result.ok) return result;
      const next = result.value;
      try {
        await store.recordEvaluationEvidence(next, evaluation);
      } catch (error) {
        return snapshotMutationFailure(error);
      }
      return ok(next);
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
      const next = result.value.record;
      try {
        await store.recordEvaluationEvidence(next, evaluation);
      } catch (error) {
        return snapshotMutationFailure(error);
      }
      return ok({
        evaluation: next,
        output: result.value.output,
      });
    },
    async exportSnapshot(workspaceId) {
      const snapshot = await store.exportSnapshot(workspaceId);
      return "code" in snapshot
        ? { ok: false, error: snapshot }
        : ok(
            portableSnapshotJson({
              ...snapshot,
              artifacts: snapshot.artifacts.filter(
                (artifact) => artifact.kind !== "compare",
              ),
              evaluations: [],
            }),
          );
    },
    async inspectSnapshotImport(json) {
      const admitted = await admitSnapshot(json);
      if (!admitted.ok) return admitted;
      const target = await store.getReplacementTarget(
        admitted.value.workspace.id,
      );
      const replacementTarget = "code" in target ? undefined : target;
      const existingWorkspace = replacementTarget?.workspace;
      return ok({
        incomingWorkspace: admitted.value.workspace,
        ...(existingWorkspace ? { existingWorkspace } : {}),
        ...(replacementTarget ? { replacementTarget } : {}),
        collision: existingWorkspace !== undefined,
      });
    },
    async importSnapshot(json) {
      const admitted = await admitSnapshot(json);
      if (!admitted.ok) return admitted;
      return fromStore(await store.importSnapshot(admitted.value));
    },
    async replaceSnapshot(json, replacementTarget) {
      const admitted = await admitSnapshot(json);
      if (!admitted.ok) return admitted;
      return fromStore(
        await store.importSnapshot(admitted.value, replacementTarget),
      );
    },
  };
}

function fromStore<T>(value: T | DomainError): Result<T> {
  return typeof value === "object" && value !== null && "code" in value
    ? { ok: false, error: value as DomainError }
    : ok(value as T);
}
function artifact<K extends ArtifactKind>(
  bundle: WorkspaceBundle,
  kind: K,
  data: ArtifactDataByKind[K],
  createdAt = new Date().toISOString(),
  id = artifactId(bundle, kind),
): ArtifactRecord {
  return {
    id,
    workspaceId: bundle.workspace.id,
    revision: bundle.revision.revision,
    kind,
    version: RULESET_VERSION,
    createdAt,
    data,
  };
}
function artifactId(bundle: WorkspaceBundle, kind: ArtifactKind): string {
  return canonicalArtifactId(
    bundle.workspace.id,
    bundle.revision.revision,
    kind,
  );
}
function nextComparisonTimestamp(artifacts: readonly ArtifactRecord[]): string {
  const latest = artifacts
    .filter((artifact) => artifact.kind === "compare")
    .reduce(
      (maximum, artifact) => Math.max(maximum, Date.parse(artifact.createdAt)),
      Number.NEGATIVE_INFINITY,
    );
  return new Date(Math.max(Date.now(), latest + 1)).toISOString();
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
  return common === null
    ? patienceLineChanges(left, right)
    : changesFromCommon(left, right, common);
}

function changesFromCommon(
  left: readonly string[],
  right: readonly string[],
  common: readonly (readonly [number, number])[],
) {
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
    approximate: false,
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
  return { additions, deletions, changedLines, approximate: true };
}

function patienceLineChanges(
  left: readonly string[],
  right: readonly string[],
) {
  const anchors = patienceAnchors(left, right);
  let leftStart = 0;
  let rightStart = 0;
  let additions = 0;
  let deletions = 0;
  let approximate = false;
  const changedLines = new Set<number>();
  for (const [leftAnchor, rightAnchor] of [
    ...anchors,
    [left.length, right.length] as const,
  ]) {
    const leftSegment = left.slice(leftStart, leftAnchor);
    const rightSegment = right.slice(rightStart, rightAnchor);
    const common = longestCommonSubsequence(leftSegment, rightSegment, {
      remaining: 1_000_000,
    });
    const changes =
      common === null
        ? boundedLineChanges(leftSegment, rightSegment)
        : changesFromCommon(leftSegment, rightSegment, common);
    additions += changes.additions;
    deletions += changes.deletions;
    approximate ||= changes.approximate;
    for (const line of changes.changedLines)
      changedLines.add(rightStart + line);
    leftStart = leftAnchor + 1;
    rightStart = rightAnchor + 1;
  }
  return {
    additions,
    deletions,
    changedLines: [...changedLines].sort((a, b) => a - b),
    approximate,
  };
}

function patienceAnchors(
  left: readonly string[],
  right: readonly string[],
): readonly (readonly [number, number])[] {
  const leftPositions = uniqueLinePositions(left);
  const rightPositions = uniqueLinePositions(right);
  const pairs = [...leftPositions]
    .flatMap(([line, leftIndex]) => {
      const rightIndex = rightPositions.get(line);
      return rightIndex === undefined
        ? []
        : ([[leftIndex, rightIndex]] as const);
    })
    .sort((a, b) => a[0] - b[0]);
  const tails: number[] = [];
  const previous = Array<number>(pairs.length).fill(-1);
  for (let index = 0; index < pairs.length; index += 1) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (pairs[tails[middle]!]![1] < pairs[index]![1]) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const anchors: (readonly [number, number])[] = [];
  let current = tails.at(-1) ?? -1;
  while (current >= 0) {
    anchors.push(pairs[current]!);
    current = previous[current]!;
  }
  return anchors.reverse();
}

function uniqueLinePositions(lines: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  const duplicates = new Set<string>();
  lines.forEach((line, index) => {
    if (positions.has(line)) duplicates.add(line);
    else positions.set(line, index);
  });
  for (const line of duplicates) positions.delete(line);
  return positions;
}
function evaluationReference(
  evaluation: EvaluationRecord,
): CompareArtifact["evaluationReferences"][number] {
  const { id, kind, revision, status, updatedAt } = evaluation;
  return { id, kind, revision, status, updatedAt };
}

function snapshotMutationFailure(error: unknown): Result<never> {
  if (error instanceof DomainMutationError)
    return { ok: false, error: error.domainError };
  if (error instanceof PortableSnapshotSizeError)
    return { ok: false, error: error.domainError };
  throw error;
}

function toolContractError(contract: unknown): string | null {
  if (!isJsonObject(contract)) return "The Tool contract must be an object.";
  const candidate = contract as Record<string, unknown>;
  if (typeof candidate.name !== "string" || candidate.name.trim() === "")
    return "The Tool contract requires a name.";
  if (
    candidate.description !== undefined &&
    typeof candidate.description !== "string"
  )
    return "The Tool contract description must be a string.";
  if (!isJsonObject(candidate.inputSchema))
    return "The Tool contract requires an inputSchema object.";
  if (!isJsonObject(candidate.outputSchema))
    return "The Tool contract requires an outputSchema object.";
  return (
    schemaSubsetError(candidate.inputSchema, "inputSchema") ??
    schemaSubsetError(candidate.outputSchema, "outputSchema")
  );
}
