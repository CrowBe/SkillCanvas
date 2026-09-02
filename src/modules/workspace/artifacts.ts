import {
  analyzeLint,
  analyzeStructure,
  type LintArtifact,
  type StructureArtifact,
} from "../analysis";
import {
  validateInstructionMap,
  type InstructionLoadVector,
  type InstructionMap,
} from "../instruction-map";
import {
  err,
  isCanonicalUtcTimestamp,
  isJsonObject,
  ok,
  RULESET_VERSION,
  sameJsonValue,
  type Result,
} from "../shared";
import type {
  ArtifactRecord,
  EvaluationKind,
  EvaluationRecord,
  SkillRevision,
  WorkspaceBundle,
} from "./types";

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

/**
 * The data shape stored under each artifact kind. Adding a kind here and to
 * ARTIFACT_KIND_MODULES is the only edit a new kind needs: every producer,
 * reader and admission check dispatches through this map.
 *
 * Kept in step with ArtifactRecord["kind"] by the dispatch call sites, which
 * stop compiling if a record kind has no module.
 */
export type ArtifactDataByKind = {
  readonly lint: LintArtifact;
  readonly structure: StructureArtifact;
  readonly "instruction-map": InstructionMap;
  readonly "instruction-load": InstructionLoadVector;
  readonly compare: CompareArtifact;
};
export type ArtifactKind = keyof ArtifactDataByKind;

/**
 * Where an artifact's data comes from, which decides whether an imported copy
 * can be trusted:
 * - `derived` recomputes from the revision, so an import must match exactly;
 * - `supplied` comes from a visiting agent and is checked for shape only;
 * - `evidence` records an observation that cannot be recomputed, so it never
 *   crosses an import.
 */
export type ArtifactProvenance = "derived" | "supplied" | "evidence";

/** Everything a kind needs to check or recompute its data. */
export type ArtifactContext = {
  readonly skillMd: string;
  readonly revision: number;
  readonly referencePaths: readonly string[];
};

type ArtifactKindModule<K extends ArtifactKind> = {
  readonly kind: K;
  readonly provenance: ArtifactProvenance;
  /** Bare issue text, or null when the data is a well-formed K. */
  dataIssue(
    data: Readonly<Record<string, unknown>>,
    context: ArtifactContext,
  ): string | null;
  /** The canonical value for this revision. Only `derived` kinds have one. */
  recompute?(context: ArtifactContext): ArtifactDataByKind[K];
};

const LINT_SEVERITIES: readonly string[] = ["error", "warn", "info"];
const EVALUATION_KINDS: readonly string[] = [
  "triggering",
  "test-run",
  "capacity-probe",
];
const EVALUATION_STATUSES: readonly string[] = [
  "prepared",
  "in-progress",
  "complete",
];

const lintModule: ArtifactKindModule<"lint"> = {
  kind: "lint",
  provenance: "derived",
  dataIssue(data) {
    if (
      data.kind !== "lint" ||
      typeof data.rulesetVersion !== "string" ||
      lintSummaryError(data) !== null ||
      !Array.isArray(data.findings)
    )
      return "lint artifact fields are incomplete.";
    for (const finding of data.findings)
      if (
        !isJsonObject(finding) ||
        typeof finding.rule !== "string" ||
        !LINT_SEVERITIES.includes(finding.severity as string) ||
        typeof finding.message !== "string" ||
        (finding.sourceSpan !== undefined &&
          sourceSpanError(finding.sourceSpan) !== null)
      )
        return "lint finding is invalid.";
    return null;
  },
  recompute: (context) => analyzeLint(context.skillMd, context.referencePaths),
};

const structureModule: ArtifactKindModule<"structure"> = {
  kind: "structure",
  provenance: "derived",
  dataIssue(data) {
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
        !isJsonObject(section) ||
        !Number.isInteger(section.level) ||
        typeof section.title !== "string" ||
        sourceSpanError(section.sourceSpan) !== null
      )
        return "structure section is invalid.";
    return null;
  },
  recompute: (context) => analyzeStructure(context.skillMd),
};

const instructionMapModule: ArtifactKindModule<"instruction-map"> = {
  kind: "instruction-map",
  provenance: "supplied",
  dataIssue(data, context) {
    if (data.suppliedBy !== "visiting-agent proposal")
      return "instruction map has an invalid supplier.";
    const checked = validateInstructionMap(
      data,
      context.skillMd,
      context.revision,
    );
    return checked.ok ? null : checked.error.message;
  },
};

const INSTRUCTION_LOAD_METRICS: readonly (keyof InstructionLoadVector)[] = [
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

const instructionLoadModule: ArtifactKindModule<"instruction-load"> = {
  kind: "instruction-load",
  provenance: "supplied",
  dataIssue(data) {
    return INSTRUCTION_LOAD_METRICS.every(
      (metric) =>
        typeof data[metric] === "number" && Number.isFinite(data[metric]),
    )
      ? null
      : "instruction-load metrics must be numeric.";
  },
};

const compareModule: ArtifactKindModule<"compare"> = {
  kind: "compare",
  provenance: "evidence",
  dataIssue(data) {
    if (
      data.kind !== "compare" ||
      !Number.isInteger(data.beforeRevision) ||
      !Number.isInteger(data.afterRevision) ||
      !isJsonObject(data.source) ||
      typeof data.source.additions !== "number" ||
      typeof data.source.deletions !== "number" ||
      !Array.isArray(data.source.changedLines) ||
      data.source.changedLines.some((line) => !Number.isInteger(line)) ||
      typeof data.source.approximate !== "boolean" ||
      !isJsonObject(data.lint) ||
      lintSummaryError(data.lint.before) !== null ||
      lintSummaryError(data.lint.after) !== null ||
      !Array.isArray(data.evaluationReferences)
    )
      return "compare artifact fields are incomplete.";
    for (const reference of data.evaluationReferences)
      if (
        !isJsonObject(reference) ||
        typeof reference.id !== "string" ||
        !EVALUATION_KINDS.includes(reference.kind as string) ||
        !Number.isInteger(reference.revision) ||
        !EVALUATION_STATUSES.includes(reference.status as string) ||
        !isCanonicalUtcTimestamp(reference.updatedAt)
      )
        return "compare evaluation reference is invalid.";
    return null;
  },
};

const ARTIFACT_KIND_MODULES: {
  readonly [K in ArtifactKind]: ArtifactKindModule<K>;
} = {
  lint: lintModule,
  structure: structureModule,
  "instruction-map": instructionMapModule,
  "instruction-load": instructionLoadModule,
  compare: compareModule,
};

export const ARTIFACT_KINDS = Object.keys(
  ARTIFACT_KIND_MODULES,
) as readonly ArtifactKind[];

export function artifactProvenance(kind: ArtifactKind): ArtifactProvenance {
  return ARTIFACT_KIND_MODULES[kind].provenance;
}

/** Everything a kind's checks need, read off the bundle the caller already holds. */
export function artifactContext(bundle: WorkspaceBundle): ArtifactContext {
  return revisionContext(bundle.revision, bundle.skillMd);
}

export function revisionContext(
  revision: SkillRevision,
  skillMd: string,
): ArtifactContext {
  return {
    skillMd,
    revision: revision.revision,
    referencePaths: revision.references.map((reference) => reference.path),
  };
}

/**
 * Parse untrusted data as the artifact kind it claims to be. This is the only
 * way data crosses into a typed artifact: readers and admission share it, so a
 * kind's shape is described once.
 */
export function parseArtifactData<K extends ArtifactKind>(
  kind: K,
  data: unknown,
  context: ArtifactContext,
): Result<ArtifactDataByKind[K]> {
  if (!isJsonObject(data))
    return err("invalid_snapshot", "artifact data must be an object.");
  const issue = ARTIFACT_KIND_MODULES[kind].dataIssue(data, context);
  return issue === null
    ? ok(data as unknown as ArtifactDataByKind[K])
    : err("invalid_snapshot", issue);
}

/**
 * Whether an artifact's data is consistent with where the kind says it came
 * from. Returns bare issue text so callers can frame their own message.
 */
export function artifactProvenanceIssue(
  artifact: ArtifactRecord,
  context: ArtifactContext,
): string | null {
  const module = ARTIFACT_KIND_MODULES[artifact.kind];
  if (module.provenance === "supplied") return null;
  if (artifact.version !== RULESET_VERSION) return "ruleset version differs";
  if (module.provenance === "evidence")
    return "comparison evidence cannot be imported";
  return sameJsonValue(artifact.data, module.recompute!(context))
    ? null
    : "artifact data differs";
}

/**
 * The record that currently stands for a kind. At most one artifact per kind
 * survives per revision, except comparisons, which are ordered by instant and
 * then id so the newest wins deterministically.
 */
export function currentArtifactRecord(
  artifacts: readonly ArtifactRecord[],
  kind: ArtifactKind,
): ArtifactRecord | undefined {
  return artifacts
    .filter((artifact) => artifact.kind === kind)
    .sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
}

/**
 * The current artifact of a kind, parsed. Null when the bundle has none, or
 * when the stored data no longer parses as that kind.
 */
export function readArtifact<K extends ArtifactKind>(
  bundle: WorkspaceBundle,
  kind: K,
): ArtifactDataByKind[K] | null {
  const record = currentArtifactRecord(bundle.artifacts, kind);
  if (record === undefined) return null;
  const parsed = parseArtifactData(kind, record.data, artifactContext(bundle));
  return parsed.ok ? parsed.value : null;
}

export function canonicalArtifactId(
  workspaceId: string,
  revision: number,
  kind: ArtifactKind,
): string {
  return `${workspaceId}:${revision}:${kind}`;
}

export function hasCanonicalArtifactId(artifact: ArtifactRecord): boolean {
  const base = canonicalArtifactId(
    artifact.workspaceId,
    artifact.revision,
    artifact.kind,
  );
  if (artifact.kind !== "compare") return artifact.id === base;
  if (!artifact.id.startsWith(`${base}:`)) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    artifact.id.slice(base.length + 1),
  );
}

function sourceSpanError(value: unknown): string | null {
  if (
    !isJsonObject(value) ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    (value.start as number) < 0 ||
    (value.end as number) <= (value.start as number)
  )
    return "source span is invalid.";
  return null;
}

function lintSummaryError(value: unknown): string | null {
  if (!isJsonObject(value)) return "lint summary is invalid.";
  const counts = value.counts;
  if (
    typeof value.score !== "number" ||
    !["A", "B", "C", "D"].includes(value.grade as string) ||
    !isJsonObject(counts) ||
    !LINT_SEVERITIES.every((severity) => typeof counts[severity] === "number")
  )
    return "lint summary is invalid.";
  return null;
}
