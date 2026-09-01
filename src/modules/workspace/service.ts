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
  type InstructionLoadVector,
  type InstructionMap,
} from "../instruction-map";
import {
  deterministicContractChecks,
  DISTRACTOR_LIBRARY_VERSION,
  invokeMockTool,
  PROMPT_BATTERY_VERSION,
  schemaSubsetError,
  prepareTestRun,
  prepareTriggering,
  testRunFixture,
  testRunFixtureHash,
  triggeringFixture,
  submitTestRun,
  submitTriggering,
  TEST_RUN_VERSION,
  type ContractCheck,
  type JsonSchema,
  type TestRunData,
  type ToolContract,
  type TriggeringRunData,
} from "../evaluations";
import {
  byteLength,
  DomainMutationError,
  err,
  normalizeReferencePath,
  ok,
  REFERENCE_MAX_BYTES,
  REFERENCES_MAX,
  RULESET_VERSION,
  sha256,
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
  EvaluationStateRecord,
  WorkspaceBundle,
  WorkspaceRecord,
  WorkspaceReplacementTarget,
  WorkspaceSnapshot,
  WorkspaceStore,
} from "./types";
import {
  PortableSnapshotSizeError,
  portableSnapshotJson,
  portableSnapshotSizeError,
} from "./snapshot-budget";

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

export type CompareArtifact = {
  readonly kind: "compare";
  readonly beforeRevision: number;
  readonly afterRevision: number;
  readonly source: {
    readonly additions: number;
    readonly deletions: number;
    readonly changedLines: readonly number[];
    readonly approximate: boolean;
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
    readonly updatedAt: string;
  }[];
  readonly evaluationStateId: string;
  readonly evaluationSnapshotHash: string;
};

type ComparisonEvaluationStateArtifact = {
  readonly kind: "comparison-evaluation-state";
  readonly comparisonId: string;
  readonly evaluations: readonly EvaluationStateRecord[];
  readonly transitionIds: readonly string[];
};

type EvaluationTransitionArtifact = {
  readonly kind: "evaluation-transition";
  readonly evaluationId: string;
  readonly sequence: number;
  readonly previousTransitionId: string | null;
  readonly state: EvaluationStateRecord;
  readonly stateHash: string;
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
      const evaluationStateId = `${artifactId(after.value, "comparison-evaluation-state")}:${comparisonInstance}`;
      const consumedTransitions = [
        ...before.value.artifacts,
        ...after.value.artifacts,
      ]
        .filter((item) => item.kind === "evaluation-transition")
        .map((item) => ({
          artifact: item,
          data: item.data as EvaluationTransitionArtifact,
        }))
        .filter(
          ({ data }) =>
            Date.parse(data.state.createdAt) <= Date.parse(createdAt) &&
            Date.parse(data.state.updatedAt) <= Date.parse(createdAt),
        )
        .sort(
          (left, right) =>
            left.data.evaluationId.localeCompare(right.data.evaluationId) ||
            left.data.sequence - right.data.sequence,
        )
        .filter(
          (candidate, index, all) =>
            all[index + 1]?.data.evaluationId !== candidate.data.evaluationId,
        );
      const evaluationStates = consumedTransitions.map(
        ({ data }) => data.state,
      );
      const evaluationReferences = evaluationStates.map(evaluationReference);
      const data: CompareArtifact = {
        kind: "compare",
        beforeRevision,
        afterRevision,
        source,
        lint: { before: summary(beforeLint), after: summary(afterLint) },
        evaluationReferences,
        evaluationStateId,
        evaluationSnapshotHash:
          await comparisonEvaluationSnapshotHash(evaluationStates),
      };
      const evaluationState: ComparisonEvaluationStateArtifact = {
        kind: "comparison-evaluation-state",
        comparisonId,
        evaluations: evaluationStates,
        transitionIds: consumedTransitions.map(({ artifact }) => artifact.id),
      };
      try {
        await store.updateArtifacts({
          workspaceId,
          revision: after.value.revision.revision,
          expectedContentHash: after.value.revision.contentHash,
          expectedGeneration: after.value.evidenceGeneration,
          artifacts: [
            artifact(after.value, "compare", data, createdAt, comparisonId),
            artifact(
              after.value,
              "comparison-evaluation-state",
              evaluationState,
              createdAt,
              evaluationStateId,
            ),
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
        await store.recordEvaluationEvidence(
          evaluation,
          undefined,
          await evaluationTransitionArtifact(evaluation, 0),
        );
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
                isSchemaObject(input) && "finalOutput" in input
                  ? input.finalOutput
                  : input,
              )
            : err("invalid_submission", "Unsupported evaluation kind.");
      if (!result.ok) return result;
      const next = result.value;
      try {
        await store.recordEvaluationEvidence(
          next,
          evaluation,
          await evaluationTransitionArtifact(
            next,
            evaluationTransitionSequence(next),
          ),
        );
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
        await store.recordEvaluationEvidence(
          next,
          evaluation,
          await evaluationTransitionArtifact(
            next,
            evaluationTransitionSequence(next),
          ),
        );
      } catch (error) {
        return snapshotMutationFailure(error);
      }
      return ok({
        evaluation: next,
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
        : ok(portableSnapshotJson(snapshot));
    },
    async inspectSnapshotImport(json) {
      const decoded = await decodeSnapshot(json);
      if (!decoded.ok) return decoded;
      const target = await store.getReplacementTarget(
        decoded.value.workspace.id,
      );
      const replacementTarget = "code" in target ? undefined : target;
      const existingWorkspace = replacementTarget?.workspace;
      return ok({
        incomingWorkspace: decoded.value.workspace,
        ...(existingWorkspace ? { existingWorkspace } : {}),
        ...(replacementTarget ? { replacementTarget } : {}),
        collision: existingWorkspace !== undefined,
      });
    },
    async importSnapshot(json) {
      const decoded = await decodeSnapshot(json);
      if (!decoded.ok) return decoded;
      return fromStore(await store.importSnapshot(decoded.value));
    },
    async replaceSnapshot(json, replacementTarget) {
      const decoded = await decodeSnapshot(json);
      if (!decoded.ok) return decoded;
      return fromStore(
        await store.importSnapshot(decoded.value, {
          replaceExisting: true,
          replacementTarget,
        }),
      );
    },
  };
}

const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 100_000;

async function decodeSnapshot(
  json: string,
): Promise<Result<WorkspaceSnapshot>> {
  if (byteLength(json) > SNAPSHOT_MAX_BYTES)
    return err("size_limit", `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`);
  let snapshot: WorkspaceSnapshot;
  try {
    snapshot = JSON.parse(json) as WorkspaceSnapshot;
  } catch {
    return err("invalid_snapshot", "Snapshot is not valid JSON.");
  }
  const complexityIssue = snapshotComplexityError(snapshot);
  if (complexityIssue) return err("invalid_snapshot", complexityIssue);
  const shape = await validateSnapshotShape(snapshot);
  if (!shape.ok) return shape;
  return ok(snapshot);
}

function snapshotComplexityError(value: unknown): string | null {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.value === null || typeof current.value !== "object") continue;
    nodes += 1;
    if (nodes > SNAPSHOT_MAX_NODES)
      return `Snapshot exceeds ${SNAPSHOT_MAX_NODES} structured values.`;
    if (current.depth >= SNAPSHOT_MAX_DEPTH)
      return `Snapshot nesting exceeds ${SNAPSHOT_MAX_DEPTH} levels.`;
    for (const child of Object.values(current.value))
      pending.push({ value: child, depth: current.depth + 1 });
  }
  return null;
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
function artifactId(
  bundle: WorkspaceBundle,
  kind: ArtifactRecord["kind"],
): string {
  return `${bundle.workspace.id}:${bundle.revision.revision}:${kind}`;
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
async function validateSnapshotShape(
  value: unknown,
): Promise<Result<WorkspaceSnapshot>> {
  if (!value || typeof value !== "object")
    return err("invalid_snapshot", "Snapshot must be an object.");
  const snapshot = value as Partial<WorkspaceSnapshot>;
  if (
    snapshot.snapshotVersion !== 1 ||
    !isCanonicalUtcTimestamp(snapshot.exportedAt) ||
    workspaceRecordError(snapshot.workspace) !== null ||
    !Array.isArray(snapshot.revisions) ||
    !Array.isArray(snapshot.blobs) ||
    !Array.isArray(snapshot.artifacts) ||
    !Array.isArray(snapshot.evaluations) ||
    !Array.isArray(snapshot.auditEvents)
  )
    return err("invalid_snapshot", "Snapshot shape or version is invalid.");
  const workspace = snapshot.workspace as WorkspaceRecord;
  const sizeIssue = portableSnapshotSizeError(snapshot as WorkspaceSnapshot);
  if (sizeIssue) return { ok: false, error: sizeIssue };
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
      typeof blob !== "object" ||
      typeof blob.hash !== "string" ||
      typeof blob.content !== "string" ||
      typeof blob.bytes !== "number" ||
      !Number.isInteger(blob.bytes) ||
      blob.bytes < 0 ||
      byteLength(blob.content) !== blob.bytes ||
      blobs.has(blob.hash)
    )
      return err(
        "invalid_snapshot",
        "Snapshot contains an invalid blob record.",
      );
    blobs.set(blob.hash, blob.content);
  }
  for (const revision of snapshot.revisions) {
    if (revisionRecordError(revision))
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
      const content = blobs.get(reference.contentHash);
      if (content === undefined || byteLength(content) !== reference.bytes)
        return err(
          "invalid_snapshot",
          `Revision ${revision.revision} has an invalid reference pointer.`,
        );
      references.push({ path: reference.path, content });
    }
    const validated = validateInput(skillMd, references);
    if (!validated.ok)
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} contains invalid Skill content: ${validated.error.message}`,
      );
    if (
      references.some(
        (reference, index) => reference.path !== validated.value[index]?.path,
      )
    )
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} contains a noncanonical reference path.`,
      );
  }
  const revisionsByNumber = new Map(
    snapshot.revisions.map((revision) => [revision.revision, revision]),
  );
  for (const evaluation of snapshot.evaluations) {
    const evaluationIssue = evaluationRecordError(evaluation);
    if (evaluationIssue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid evaluation record: ${evaluationIssue}`,
      );
    const revision = revisionsByNumber.get(evaluation.revision);
    if (
      evaluation.workspaceId !== workspace.id ||
      !revision ||
      evaluation.contentHash !== revision.contentHash
    )
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} is not linked to its claimed revision.`,
      );
    const dataIssue = evaluationDataError(evaluation.kind, evaluation.data);
    if (dataIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} has invalid data: ${dataIssue}`,
      );
    const statusIssue = evaluationStatusError(
      evaluation.status,
      evaluation.kind,
      evaluation.data as Record<string, unknown>,
    );
    if (statusIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} has inconsistent status: ${statusIssue}`,
      );
    const fixtureIssue = await canonicalEvaluationFixtureError(
      evaluation,
      blobs.get(revision.contentHash)!,
    );
    if (fixtureIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} does not match its canonical fixture: ${fixtureIssue}`,
      );
  }
  for (const artifact of snapshot.artifacts) {
    const issue = artifactRecordError(artifact);
    if (issue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid artifact record: ${issue}`,
      );
    if (
      artifact.workspaceId !== workspace.id ||
      !revisionsByNumber.has(artifact.revision)
    )
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} is not linked to an imported revision.`,
      );
    if (
      artifact.kind === "evaluation-transition" &&
      !snapshot.evaluations.some(
        (evaluation) =>
          evaluation.id ===
          (artifact.data as EvaluationTransitionArtifact).evaluationId,
      )
    )
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} is not linked to an imported evaluation.`,
      );
    if (!hasCanonicalArtifactId(artifact))
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} does not use its canonical id.`,
      );
    const artifactIssue = artifactDataError(
      artifact.kind,
      artifact.data,
      blobs.get(revisionsByNumber.get(artifact.revision)!.contentHash)!,
      artifact.revision,
    );
    if (artifactIssue)
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} has invalid data: ${artifactIssue}`,
      );
    const deterministicIssue = await deterministicArtifactError(
      artifact,
      snapshot as WorkspaceSnapshot,
      revisionsByNumber,
      blobs,
    );
    if (deterministicIssue)
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} does not match canonical analysis: ${deterministicIssue}`,
      );
  }
  for (const evaluation of snapshot.evaluations) {
    const transitionIssue = await evaluationTransitionsError(
      evaluation,
      snapshot.artifacts.filter(
        (artifact) =>
          artifact.kind === "evaluation-transition" &&
          (artifact.data as EvaluationTransitionArtifact).evaluationId ===
            evaluation.id,
      ),
      blobs.get(revisionsByNumber.get(evaluation.revision)!.contentHash)!,
    );
    if (transitionIssue)
      return err(
        "invalid_snapshot",
        `Evaluation ${evaluation.id} has invalid transition history: ${transitionIssue}`,
      );
  }
  for (const revision of snapshot.revisions) {
    const maps = snapshot.artifacts.filter(
      (artifact) =>
        artifact.revision === revision.revision &&
        artifact.kind === "instruction-map",
    );
    const loads = snapshot.artifacts.filter(
      (artifact) =>
        artifact.revision === revision.revision &&
        artifact.kind === "instruction-load",
    );
    if (maps.length > 1 || loads.length > 1)
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} contains duplicate instruction artifacts.`,
      );
    const map = maps[0]?.data as InstructionMap | undefined;
    if (map?.status !== "accepted") {
      if (loads.length > 0)
        return err(
          "invalid_snapshot",
          `Revision ${revision.revision} contains instruction-load metrics without an accepted map.`,
        );
      continue;
    }
    if (loads.length !== 1)
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} is missing instruction-load metrics for its accepted map.`,
      );
    const expected = instructionLoadVector(map);
    const received = loads[0].data as Record<string, unknown>;
    if (
      Object.entries(expected).some(([key, value]) => received[key] !== value)
    )
      return err(
        "invalid_snapshot",
        `Revision ${revision.revision} contains instruction-load metrics that do not match its accepted map.`,
      );
  }
  for (const event of snapshot.auditEvents) {
    const issue = auditEventError(event);
    if (issue)
      return err(
        "invalid_snapshot",
        `Snapshot contains an invalid audit event: ${issue}`,
      );
    if (
      event.workspaceId !== workspace.id ||
      (event.revision !== undefined && !revisionsByNumber.has(event.revision))
    )
      return err(
        "invalid_snapshot",
        `Audit event ${event.id} is not linked to an imported revision.`,
      );
  }
  return ok(snapshot as WorkspaceSnapshot);
}

async function deterministicArtifactError(
  artifact: ArtifactRecord,
  snapshot: WorkspaceSnapshot,
  revisionsByNumber: ReadonlyMap<
    number,
    WorkspaceSnapshot["revisions"][number]
  >,
  blobs: ReadonlyMap<string, string>,
): Promise<string | null> {
  if (
    artifact.kind === "instruction-map" ||
    artifact.kind === "instruction-load"
  )
    return null;
  if (artifact.version !== RULESET_VERSION) return "ruleset version differs";
  const revision = revisionsByNumber.get(artifact.revision)!;
  if (artifact.kind === "evaluation-transition") {
    const transition = artifact.data as EvaluationTransitionArtifact;
    return (await sha256(JSON.stringify(transition.state))) ===
      transition.stateHash
      ? null
      : "evaluation transition hash differs";
  }
  const skillMd = blobs.get(revision.contentHash)!;
  let expected: unknown;
  if (artifact.kind === "comparison-evaluation-state") {
    const state = artifact.data as ComparisonEvaluationStateArtifact;
    const comparison = snapshot.artifacts.find(
      (candidate) => candidate.id === state.comparisonId,
    );
    return comparison?.kind === "compare"
      ? comparisonEvaluationStateError(
          comparison,
          artifact,
          snapshot,
          revisionsByNumber,
          blobs,
        )
      : "comparison evaluation state is orphaned";
  }
  if (artifact.kind === "lint")
    expected = analyzeLint(
      skillMd,
      revision.references.map((reference) => reference.path),
    );
  else if (artifact.kind === "structure") expected = analyzeStructure(skillMd);
  else {
    const received = artifact.data as CompareArtifact;
    const before = revisionsByNumber.get(received.beforeRevision);
    const after = revisionsByNumber.get(received.afterRevision);
    if (!before || !after || received.afterRevision !== artifact.revision)
      return "comparison revisions differ";
    const beforeSkill = blobs.get(before.contentHash)!;
    const afterSkill = blobs.get(after.contentHash)!;
    const stateArtifact = snapshot.artifacts.find(
      (candidate) => candidate.id === received.evaluationStateId,
    );
    if (stateArtifact?.kind !== "comparison-evaluation-state")
      return "comparison evaluation state is missing";
    const stateIssue = await comparisonEvaluationStateError(
      artifact,
      stateArtifact,
      snapshot,
      revisionsByNumber,
      blobs,
    );
    if (stateIssue) return stateIssue;
    const evaluationStates = (
      stateArtifact.data as ComparisonEvaluationStateArtifact
    ).evaluations;
    const evaluationReferences = evaluationStates.map(evaluationReference);
    expected = {
      kind: "compare",
      beforeRevision: received.beforeRevision,
      afterRevision: received.afterRevision,
      source: lineDiff(beforeSkill, afterSkill),
      lint: {
        before: summary(
          analyzeLint(
            beforeSkill,
            before.references.map((reference) => reference.path),
          ),
        ),
        after: summary(
          analyzeLint(
            afterSkill,
            after.references.map((reference) => reference.path),
          ),
        ),
      },
      evaluationReferences,
      evaluationStateId: stateArtifact.id,
      evaluationSnapshotHash:
        await comparisonEvaluationSnapshotHash(evaluationStates),
    } satisfies CompareArtifact;
  }
  return sameJsonValue(artifact.data, expected)
    ? null
    : "artifact data differs";
}

async function comparisonEvaluationStateError(
  comparisonArtifact: ArtifactRecord,
  stateArtifact: ArtifactRecord,
  snapshot: WorkspaceSnapshot,
  revisionsByNumber: ReadonlyMap<
    number,
    WorkspaceSnapshot["revisions"][number]
  >,
  blobs: ReadonlyMap<string, string>,
): Promise<string | null> {
  const comparison = comparisonArtifact.data as CompareArtifact;
  const state = stateArtifact.data as ComparisonEvaluationStateArtifact;
  const comparisonSuffix = comparisonArtifact.id.slice(
    `${comparisonArtifact.workspaceId}:${comparisonArtifact.revision}:compare:`
      .length,
  );
  const stateSuffix = stateArtifact.id.slice(
    `${stateArtifact.workspaceId}:${stateArtifact.revision}:comparison-evaluation-state:`
      .length,
  );
  if (
    state.comparisonId !== comparisonArtifact.id ||
    comparison.evaluationStateId !== stateArtifact.id ||
    stateArtifact.revision !== comparisonArtifact.revision ||
    stateArtifact.createdAt !== comparisonArtifact.createdAt ||
    stateArtifact.version !== comparisonArtifact.version ||
    comparisonSuffix !== stateSuffix
  )
    return "comparison evaluation state linkage differs";
  const eligibleTransitions = snapshot.artifacts
    .filter((artifact) => artifact.kind === "evaluation-transition")
    .map((artifact) => ({
      artifact,
      data: artifact.data as EvaluationTransitionArtifact,
    }))
    .filter(
      ({ data }) =>
        (data.state.revision === comparison.beforeRevision ||
          data.state.revision === comparison.afterRevision) &&
        Date.parse(data.state.createdAt) <=
          Date.parse(comparisonArtifact.createdAt) &&
        Date.parse(data.state.updatedAt) <=
          Date.parse(comparisonArtifact.createdAt),
    )
    .sort(
      (left, right) =>
        left.data.evaluationId.localeCompare(right.data.evaluationId) ||
        left.data.sequence - right.data.sequence,
    )
    .filter(
      (candidate, index, all) =>
        all[index + 1]?.data.evaluationId !== candidate.data.evaluationId,
    );
  const eligible = eligibleTransitions.map(({ data }) => data.state);
  if (
    state.evaluations.length !== eligible.length ||
    state.transitionIds.length !== eligibleTransitions.length ||
    state.evaluations.some(
      (evaluation, index) => !sameJsonValue(evaluation, eligible[index]),
    ) ||
    state.transitionIds.some(
      (id, index) => id !== eligibleTransitions[index]?.artifact.id,
    )
  )
    return "comparison consumed evaluation set differs";
  const seen = new Set<string>();
  for (const [index, historical] of state.evaluations.entries()) {
    if (evaluationRecordError(historical) !== null)
      return "comparison consumed evaluation state differs";
    const previous = state.evaluations[index - 1];
    const current = eligible[index];
    const revision = revisionsByNumber.get(historical.revision);
    const dataIssue = evaluationDataError(historical.kind, historical.data);
    const statusIssue = dataIssue
      ? null
      : evaluationStatusError(
          historical.status,
          historical.kind,
          historical.data as Record<string, unknown>,
        );
    const fixtureIssue =
      revision && !dataIssue && !statusIssue
        ? await canonicalEvaluationFixtureError(
            historical,
            blobs.get(revision.contentHash)!,
          )
        : null;
    if (
      seen.has(historical.id) ||
      (previous !== undefined &&
        previous.id.localeCompare(historical.id) >= 0) ||
      !current ||
      historical.workspaceId !== snapshot.workspace.id ||
      !revision ||
      historical.contentHash !== revision.contentHash ||
      historical.createdAt !== current.createdAt ||
      Date.parse(historical.updatedAt) >
        Date.parse(comparisonArtifact.createdAt) ||
      dataIssue !== null ||
      statusIssue !== null ||
      fixtureIssue !== null ||
      !sameJsonValue(historical, current)
    )
      return "comparison consumed evaluation state differs";
    seen.add(historical.id);
  }
  return null;
}

function comparisonEvaluationSnapshotHash(
  evaluations: readonly EvaluationStateRecord[],
): Promise<string> {
  return sha256(JSON.stringify(evaluations));
}

function evaluationReference(
  evaluation: EvaluationStateRecord,
): CompareArtifact["evaluationReferences"][number] {
  const { id, kind, revision, status, updatedAt } = evaluation;
  return { id, kind, revision, status, updatedAt };
}

function evaluationTransitionSequence(evaluation: EvaluationRecord): number {
  if (evaluation.kind === "triggering")
    return (evaluation.data as TriggeringRunData).observations.length;
  const transcriptSteps = (evaluation.data as TestRunData).transcript.length;
  return transcriptSteps / 2 + (evaluation.status === "complete" ? 1 : 0);
}

async function evaluationTransitionArtifact(
  evaluation: EvaluationRecord,
  sequence: number,
): Promise<ArtifactRecord> {
  const base = `${evaluation.workspaceId}:${evaluation.revision}:evaluation-transition:${evaluation.id}`;
  const state = structuredClone(evaluation);
  const data: EvaluationTransitionArtifact = {
    kind: "evaluation-transition",
    evaluationId: evaluation.id,
    sequence,
    previousTransitionId: sequence === 0 ? null : `${base}:${sequence - 1}`,
    state,
    stateHash: await sha256(JSON.stringify(state)),
  };
  return {
    id: `${base}:${sequence}`,
    workspaceId: evaluation.workspaceId,
    revision: evaluation.revision,
    kind: "evaluation-transition",
    version: RULESET_VERSION,
    createdAt: evaluation.updatedAt,
    data,
  };
}

async function canonicalEvaluationFixtureError(
  evaluation: EvaluationStateRecord,
  skillMd: string,
): Promise<string | null> {
  if (evaluation.kind === "triggering") {
    if (
      !sameJsonValue(evaluation.versions, {
        promptBattery: PROMPT_BATTERY_VERSION,
        distractorLibrary: DISTRACTOR_LIBRARY_VERSION,
        ruleset: RULESET_VERSION,
      })
    )
      return "triggering versions differ";
    const fixture = await triggeringFixture(skillMd);
    const data = evaluation.data as TriggeringRunData;
    return sameJsonValue(data.cases, fixture.cases)
      ? null
      : "triggering cases differ";
  }
  if (evaluation.kind !== "test-run") return "unsupported evaluation kind";
  const data = evaluation.data as TestRunData;
  const fixture = testRunFixture(data.contract, data.responseSchema);
  if (
    !sameJsonValue(evaluation.versions, {
      testRun: TEST_RUN_VERSION,
      ruleset: RULESET_VERSION,
      fixture: await testRunFixtureHash(fixture),
    })
  )
    return "test-run versions differ";
  if (!sameJsonValue(data.scenario, fixture.scenario))
    return "test-run scenario differs";
  for (let index = 0; index < data.transcript.length; index += 2) {
    const call = data.transcript[index];
    const result = data.transcript[index + 1];
    if (
      call?.kind !== "tool-call" ||
      result?.kind !== "tool-result" ||
      call.tool !== data.contract.name ||
      result.tool !== data.contract.name ||
      call.at !== result.at ||
      !sameJsonValue(result.output, fixture.scenario.seedData)
    )
      return "test-run transcript differs";
  }
  return null;
}

function snapshotMutationFailure(error: unknown): Result<never> {
  if (error instanceof DomainMutationError)
    return { ok: false, error: error.domainError };
  if (error instanceof PortableSnapshotSizeError)
    return { ok: false, error: error.domainError };
  throw error;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  if (!isSchemaObject(left) || !isSchemaObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    )
  );
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
        !isCanonicalUtcTimestamp(observation.submittedAt)
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
      typeof (record.scenario as Record<string, unknown>).prompt !== "string" ||
      !("seedData" in record.scenario)
    )
      return "a test run requires a scenario with a prompt and seed data.";
    if (!Array.isArray(record.transcript))
      return "a test run requires a transcript array.";
    for (const step of record.transcript) {
      if (!isSchemaObject(step)) return "a transcript step must be an object.";
      if (step.kind !== "tool-call" && step.kind !== "tool-result")
        return "a transcript step has an unsupported kind.";
      if (typeof step.tool !== "string" || !isCanonicalUtcTimestamp(step.at))
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
      if (!("finalOutput" in record))
        return "test-run checks require final output evidence.";
      const expected = deterministicContractChecks(
        record as unknown as TestRunData,
        record.finalOutput,
      );
      if (!contractChecksMatch(record.checks, expected))
        return "test-run checks do not match the deterministic evidence.";
    }
    return null;
  }
  return "unsupported evaluation kind.";
}

function evaluationStatusError(
  status: EvaluationRecord["status"],
  kind: EvaluationRecord["kind"],
  data: Record<string, unknown>,
): string | null {
  if (kind === "triggering") {
    const cases = data.cases as unknown[];
    const observations = data.observations as unknown[];
    if (cases.length === 0) return "triggering evaluations require cases.";
    if (status === "prepared" && observations.length !== 0)
      return "prepared triggering evaluations cannot contain observations.";
    if (
      status === "in-progress" &&
      (observations.length === 0 || observations.length >= cases.length)
    )
      return "in-progress triggering evaluations require partial observations.";
    if (status === "complete" && observations.length !== cases.length)
      return "complete triggering evaluations require all observations.";
    return null;
  }
  const transcript = data.transcript as unknown[];
  const hasFinalOutput = "finalOutput" in data;
  const hasChecks = "checks" in data;
  if (
    status === "prepared" &&
    (transcript.length !== 0 || hasFinalOutput || hasChecks)
  )
    return "prepared test runs cannot contain execution evidence.";
  if (
    status === "in-progress" &&
    (transcript.length === 0 || hasFinalOutput || hasChecks)
  )
    return "in-progress test runs require transcript evidence only.";
  if (status === "complete" && (!hasFinalOutput || !hasChecks))
    return "complete test runs require final output and checks.";
  return null;
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
    !isStringRecord(value.versions) ||
    !isCanonicalUtcTimestamp(value.createdAt) ||
    !isCanonicalUtcTimestamp(value.updatedAt)
  )
    return "required metadata is missing.";
  return null;
}

async function evaluationTransitionsError(
  evaluation: EvaluationRecord,
  artifacts: readonly ArtifactRecord[],
  skillMd: string,
): Promise<string | null> {
  const sortedArtifacts = [...artifacts].sort(
    (left, right) =>
      (left.data as EvaluationTransitionArtifact).sequence -
      (right.data as EvaluationTransitionArtifact).sequence,
  );
  const transitions = sortedArtifacts.map(
    (artifact) => (artifact.data as EvaluationTransitionArtifact).state,
  );
  if (transitions.length === 0) return "transition history is missing.";
  for (const [index, transition] of transitions.entries()) {
    const artifact = sortedArtifacts[index]!;
    const data = artifact.data as EvaluationTransitionArtifact;
    const expectedPreviousId =
      index === 0 ? null : sortedArtifacts[index - 1]!.id;
    if (
      data.sequence !== index ||
      data.previousTransitionId !== expectedPreviousId ||
      artifact.createdAt !== transition.updatedAt ||
      evaluationRecordError(transition) !== null ||
      transition.id !== evaluation.id ||
      transition.workspaceId !== evaluation.workspaceId ||
      transition.revision !== evaluation.revision ||
      transition.contentHash !== evaluation.contentHash ||
      transition.kind !== evaluation.kind ||
      transition.createdAt !== evaluation.createdAt ||
      !sameJsonValue(transition.versions, evaluation.versions)
    )
      return "transition metadata differs.";
    const dataIssue = evaluationDataError(transition.kind, transition.data);
    const statusIssue = dataIssue
      ? null
      : evaluationStatusError(
          transition.status,
          transition.kind,
          transition.data as Record<string, unknown>,
        );
    if (
      dataIssue ||
      statusIssue ||
      (await canonicalEvaluationFixtureError(transition, skillMd))
    )
      return "transition evidence is invalid.";
    const previous = transitions[index - 1];
    if (previous && !evaluationTransitionFollows(previous, transition))
      return "transitions are not an append-only lifecycle.";
  }
  if (transitions[0]?.status !== "prepared")
    return "history must begin prepared.";
  return sameJsonValue(transitions.at(-1), evaluation)
    ? null
    : "current evaluation does not match its latest transition.";
}

function evaluationTransitionFollows(
  previous: EvaluationStateRecord,
  next: EvaluationStateRecord,
): boolean {
  if (previous.status === "complete") return false;
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) return false;
  if (previous.kind === "triggering") {
    const before = previous.data as TriggeringRunData;
    const after = next.data as TriggeringRunData;
    return (
      sameJsonValue(before.cases, after.cases) &&
      after.observations.length === before.observations.length + 1 &&
      before.observations.every((value, index) =>
        sameJsonValue(value, after.observations[index]),
      )
    );
  }
  const before = previous.data as TestRunData;
  const after = next.data as TestRunData;
  if (
    !sameJsonValue(
      testRunFixture(before.contract, before.responseSchema),
      testRunFixture(after.contract, after.responseSchema),
    )
  )
    return false;
  if (next.status === "in-progress")
    return (
      after.transcript.length === before.transcript.length + 2 &&
      before.transcript.every((value, index) =>
        sameJsonValue(value, after.transcript[index]),
      )
    );
  return (
    next.status === "complete" &&
    sameJsonValue(before.transcript, after.transcript)
  );
}

function hasCanonicalArtifactId(artifact: ArtifactRecord): boolean {
  const base = `${artifact.workspaceId}:${artifact.revision}:${artifact.kind}`;
  if (artifact.kind === "evaluation-transition") {
    const data = artifact.data as Partial<EvaluationTransitionArtifact>;
    return (
      typeof data.evaluationId === "string" &&
      Number.isInteger(data.sequence) &&
      artifact.id === `${base}:${data.evaluationId}:${data.sequence}`
    );
  }
  if (
    artifact.kind !== "compare" &&
    artifact.kind !== "comparison-evaluation-state"
  )
    return artifact.id === base;
  if (!artifact.id.startsWith(`${base}:`)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    artifact.id.slice(base.length + 1),
  );
}

function workspaceRecordError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "workspace must be an object.";
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.currentRevision) ||
    !isCanonicalUtcTimestamp(value.createdAt) ||
    !isCanonicalUtcTimestamp(value.updatedAt) ||
    typeof value.ephemeral !== "boolean"
  )
    return "workspace metadata is incomplete.";
  return null;
}

function revisionRecordError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "revision must be an object.";
  if (
    typeof value.workspaceId !== "string" ||
    !Number.isInteger(value.revision) ||
    (value.parentRevision !== null &&
      !Number.isInteger(value.parentRevision)) ||
    typeof value.contentHash !== "string" ||
    !Array.isArray(value.references) ||
    !isCanonicalUtcTimestamp(value.timestamp) ||
    typeof value.rulesetVersion !== "string"
  )
    return "revision metadata is incomplete.";
  for (const reference of value.references)
    if (
      !isSchemaObject(reference) ||
      typeof reference.path !== "string" ||
      typeof reference.contentHash !== "string" ||
      typeof reference.bytes !== "number" ||
      !Number.isInteger(reference.bytes) ||
      reference.bytes < 0
    )
      return "revision reference metadata is incomplete.";
  return null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isSchemaObject(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function sourceSpanError(value: unknown): string | null {
  if (
    !isSchemaObject(value) ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    (value.start as number) < 0 ||
    (value.end as number) <= (value.start as number)
  )
    return "source span is invalid.";
  return null;
}

function lintSummaryError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "lint summary is invalid.";
  const counts = value.counts;
  if (
    typeof value.score !== "number" ||
    !["A", "B", "C", "D"].includes(value.grade as string) ||
    !isSchemaObject(counts) ||
    !["error", "warn", "info"].every(
      (severity) => typeof counts[severity] === "number",
    )
  )
    return "lint summary is invalid.";
  return null;
}

function artifactDataError(
  kind: ArtifactRecord["kind"],
  data: unknown,
  skillMd: string,
  revision: number,
): string | null {
  if (!isSchemaObject(data)) return "artifact data must be an object.";
  if (kind === "instruction-map") {
    if (data.suppliedBy !== "visiting-agent proposal")
      return "instruction map has an invalid supplier.";
    const checked = validateInstructionMap(data, skillMd, revision);
    return checked.ok ? null : checked.error.message;
  }
  if (kind === "instruction-load") {
    const keys: readonly (keyof InstructionLoadVector)[] = [
      "totalAtomicRequirements",
      "maximumSimultaneouslyActive",
      "longestDependencyChain",
      "maximumScopeDepth",
      "branchCount",
      "crossScopeReferences",
      "conflicts",
      "duplicates",
      "deterministicallyVerifiableFraction",
    ];
    return keys.every(
      (key) => typeof data[key] === "number" && Number.isFinite(data[key]),
    )
      ? null
      : "instruction-load metrics must be numeric.";
  }
  if (kind === "lint") {
    if (
      data.kind !== "lint" ||
      typeof data.rulesetVersion !== "string" ||
      lintSummaryError(data) !== null ||
      !Array.isArray(data.findings)
    )
      return "lint artifact fields are incomplete.";
    for (const finding of data.findings)
      if (
        !isSchemaObject(finding) ||
        typeof finding.rule !== "string" ||
        !["error", "warn", "info"].includes(finding.severity as string) ||
        typeof finding.message !== "string" ||
        (finding.sourceSpan !== undefined &&
          sourceSpanError(finding.sourceSpan) !== null)
      )
        return "lint finding is invalid.";
    return null;
  }
  if (kind === "structure") {
    if (
      data.kind !== "structure" ||
      typeof data.rulesetVersion !== "string" ||
      typeof data.title !== "string" ||
      typeof data.description !== "string" ||
      !Array.isArray(data.sections)
    )
      return "structure artifact fields are incomplete.";
    for (const section of data.sections)
      if (
        !isSchemaObject(section) ||
        !Number.isInteger(section.level) ||
        typeof section.title !== "string" ||
        sourceSpanError(section.sourceSpan) !== null
      )
        return "structure section is invalid.";
    return null;
  }
  if (kind === "comparison-evaluation-state") {
    if (
      data.kind !== "comparison-evaluation-state" ||
      typeof data.comparisonId !== "string" ||
      !Array.isArray(data.evaluations) ||
      !Array.isArray(data.transitionIds) ||
      data.transitionIds.some((id) => typeof id !== "string")
    )
      return "comparison evaluation state fields are incomplete.";
    return null;
  }
  if (kind === "evaluation-transition") {
    if (
      data.kind !== "evaluation-transition" ||
      typeof data.evaluationId !== "string" ||
      !Number.isInteger(data.sequence) ||
      (data.sequence as number) < 0 ||
      (data.previousTransitionId !== null &&
        typeof data.previousTransitionId !== "string") ||
      evaluationRecordError(data.state) !== null ||
      typeof data.stateHash !== "string"
    )
      return "evaluation transition fields are incomplete.";
    const state = data.state as EvaluationStateRecord;
    if (state.revision !== revision)
      return "evaluation transition revision differs.";
    return null;
  }
  if (
    data.kind !== "compare" ||
    !Number.isInteger(data.beforeRevision) ||
    !Number.isInteger(data.afterRevision) ||
    !isSchemaObject(data.source) ||
    typeof data.source.additions !== "number" ||
    typeof data.source.deletions !== "number" ||
    !Array.isArray(data.source.changedLines) ||
    data.source.changedLines.some((line) => !Number.isInteger(line)) ||
    typeof data.source.approximate !== "boolean" ||
    !isSchemaObject(data.lint) ||
    lintSummaryError(data.lint.before) !== null ||
    lintSummaryError(data.lint.after) !== null ||
    !Array.isArray(data.evaluationReferences) ||
    typeof data.evaluationStateId !== "string" ||
    typeof data.evaluationSnapshotHash !== "string"
  )
    return "compare artifact fields are incomplete.";
  for (const reference of data.evaluationReferences)
    if (
      !isSchemaObject(reference) ||
      typeof reference.id !== "string" ||
      !["triggering", "test-run", "capacity-probe"].includes(
        reference.kind as string,
      ) ||
      !Number.isInteger(reference.revision) ||
      !["prepared", "in-progress", "complete"].includes(
        reference.status as string,
      ) ||
      !isCanonicalUtcTimestamp(reference.updatedAt)
    )
      return "compare evaluation reference is invalid.";
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
      "comparison-evaluation-state",
      "evaluation-transition",
    ].includes(value.kind as string) ||
    typeof value.version !== "string" ||
    !isCanonicalUtcTimestamp(value.createdAt) ||
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
    !isCanonicalUtcTimestamp(value.at) ||
    !["human", "webmcp", "system"].includes(value.actor as string) ||
    typeof value.action !== "string" ||
    (value.revision !== undefined && !Number.isInteger(value.revision)) ||
    (value.details !== undefined && !isSchemaObject(value.details))
  )
    return "required metadata is missing.";
  return null;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

function contractChecksMatch(
  received: readonly unknown[],
  expected: readonly ContractCheck[],
): boolean {
  return (
    received.length === expected.length &&
    received.every((value, index) => {
      if (!isSchemaObject(value)) return false;
      const canonical = expected[index];
      return (
        canonical !== undefined &&
        Object.keys(value).length === 4 &&
        value.id === canonical.id &&
        value.passed === canonical.passed &&
        value.message === canonical.message &&
        value.deterministic === canonical.deterministic
      );
    })
  );
}
