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
          deleteIds: after.value.artifacts
            .filter((item) => item.kind === "compare")
            .map((item) => item.id),
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
                isSchemaObject(input) && "finalOutput" in input
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
  if (
    snapshot.evaluations.length > 0 ||
    snapshot.artifacts.some(
      (artifact) => isSchemaObject(artifact) && artifact.kind === "compare",
    )
  )
    return err(
      "invalid_snapshot",
      "Snapshot imports cannot admit evaluation or comparison evidence. Import Skill and reference content without that evidence, then regenerate evaluations and comparisons locally.",
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
      revisionsByNumber,
      blobs,
    );
    if (deterministicIssue)
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} does not match canonical analysis: ${deterministicIssue}`,
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
  const skillMd = blobs.get(revision.contentHash)!;
  let expected: unknown;
  if (artifact.kind === "lint")
    expected = analyzeLint(
      skillMd,
      revision.references.map((reference) => reference.path),
    );
  else if (artifact.kind === "structure") expected = analyzeStructure(skillMd);
  else return "comparison evidence cannot be imported";
  return sameJsonValue(artifact.data, expected)
    ? null
    : "artifact data differs";
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

function hasCanonicalArtifactId(artifact: ArtifactRecord): boolean {
  const base = `${artifact.workspaceId}:${artifact.revision}:${artifact.kind}`;
  if (artifact.kind !== "compare") return artifact.id === base;
  if (!artifact.id.startsWith(`${base}:`)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    artifact.id.slice(base.length + 1),
  );
}

function workspaceRecordError(value: unknown): string | null {
  if (!isSchemaObject(value)) return "workspace must be an object.";
  if (
    !hasCanonicalPrefixedId(value.id, "workspace") ||
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
    !Array.isArray(data.evaluationReferences)
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
    !hasCanonicalPrefixedId(value.id, "audit") ||
    !hasCanonicalPrefixedId(value.workspaceId, "workspace") ||
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

function hasCanonicalPrefixedId(value: unknown, prefix: string): boolean {
  return (
    typeof value === "string" &&
    new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "i",
    ).test(value)
  );
}
