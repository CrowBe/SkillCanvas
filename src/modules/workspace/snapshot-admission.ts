import {
  instructionLoadVector,
  type InstructionLoadVector,
} from "../instruction-map";
import {
  byteLength,
  err,
  hasCanonicalPrefixedId,
  isCanonicalUtcTimestamp,
  isJsonObject,
  ok,
  sha256,
  SNAPSHOT_MAX_BYTES,
  type DomainError,
  type Result,
} from "../shared";
import { validateSkillInput } from "../skill";
import {
  artifactProvenanceIssue,
  hasCanonicalArtifactId,
  parseArtifactData,
  revisionContext,
} from "./artifacts";
import type { WorkspaceRecord, WorkspaceSnapshot } from "./types";

/**
 * Admission decides whether untrusted JSON is an acceptable Workbench
 * snapshot. Every rule here is a property of the snapshot alone, so the answer
 * never depends on which store the snapshot is headed for. The store answers
 * the separate question of whether an admitted snapshot can land: id
 * collisions, and whether a confirmed replacement target is still current.
 */

const SNAPSHOT_MAX_DEPTH = 64;
const SNAPSHOT_MAX_NODES = 100_000;
const MAX_REVISIONS = 1000;
const MAX_BLOBS = 1025;
const MAX_ARTIFACTS = 5000;
const MAX_EVALUATIONS = 1000;
const MAX_AUDIT_EVENTS = 10000;

declare const admitted: unique symbol;

/**
 * A snapshot that has passed admission. The brand is unforgeable outside this
 * module, so a store cannot be reached with unchecked content: the only way to
 * obtain one is `admitSnapshot`.
 */
export type AdmittedSnapshot = WorkspaceSnapshot & {
  readonly [admitted]: true;
};

export function portableSnapshotJson(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function portableSnapshotSizeError(
  snapshot: WorkspaceSnapshot,
): DomainError | null {
  const bytes = byteLength(portableSnapshotJson(snapshot));
  return bytes > SNAPSHOT_MAX_BYTES
    ? {
        code: "size_limit",
        message: `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`,
        details: { bytes, maximumBytes: SNAPSHOT_MAX_BYTES },
      }
    : null;
}

/** Thrown when a mutation would push a workspace past the portable budget. */
export class PortableSnapshotSizeError extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message);
  }
}

/**
 * Admit untrusted JSON as a Workbench snapshot, or say why it cannot be one.
 *
 * Rejects, in this order: oversized or unparseable JSON; pathological nesting;
 * a malformed envelope or record counts beyond the workbench bounds; evidence
 * (evaluations and comparisons), which never crosses an import; blobs whose
 * bytes or digest disagree with their content; revisions that point at missing
 * blobs, carry invalid Skill content, or break the 1..N parent chain;
 * artifacts that are unlinked, noncanonically named, unparseable as their
 * kind, or inconsistent with the canonical analysis of their revision;
 * instruction-load metrics that disagree with their accepted map; and audit
 * events that are not linked to an imported revision.
 */
export async function admitSnapshot(
  json: string,
): Promise<Result<AdmittedSnapshot>> {
  if (byteLength(json) > SNAPSHOT_MAX_BYTES)
    return err("size_limit", `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return err("invalid_snapshot", "Snapshot is not valid JSON.");
  }
  const complexityIssue = snapshotComplexityError(parsed);
  if (complexityIssue) return err("invalid_snapshot", complexityIssue);
  return admitParsedSnapshot(parsed);
}

async function admitParsedSnapshot(
  value: unknown,
): Promise<Result<AdmittedSnapshot>> {
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
    snapshot.revisions.length > MAX_REVISIONS ||
    snapshot.blobs.length > MAX_BLOBS ||
    snapshot.artifacts.length > MAX_ARTIFACTS ||
    snapshot.evaluations.length > MAX_EVALUATIONS ||
    snapshot.auditEvents.length > MAX_AUDIT_EVENTS
  )
    return err(
      "size_limit",
      "Snapshot record count exceeds the workbench bounds.",
    );
  if (
    snapshot.evaluations.length > 0 ||
    snapshot.artifacts.some(
      (artifact) => isJsonObject(artifact) && artifact.kind === "compare",
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
    const validated = validateSkillInput(skillMd, references);
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
    const artifactRevision = revisionsByNumber.get(artifact.revision)!;
    const context = revisionContext(
      artifactRevision,
      blobs.get(artifactRevision.contentHash)!,
    );
    const parsed = parseArtifactData(artifact.kind, artifact.data, context);
    if (!parsed.ok)
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} has invalid data: ${parsed.error.message}`,
      );
    const provenanceIssue = artifactProvenanceIssue(artifact, context);
    if (provenanceIssue)
      return err(
        "invalid_snapshot",
        `Artifact ${artifact.id} does not match canonical analysis: ${provenanceIssue}`,
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
    const context = revisionContext(revision, blobs.get(revision.contentHash)!);
    const parsedMap = maps[0]
      ? parseArtifactData("instruction-map", maps[0].data, context)
      : undefined;
    const map = parsedMap?.ok === true ? parsedMap.value : undefined;
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
    const received = parseArtifactData(
      "instruction-load",
      loads[0].data,
      context,
    );
    if (
      !received.ok ||
      Object.entries(expected).some(
        ([key, value]) =>
          received.value[key as keyof InstructionLoadVector] !== value,
      )
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
  const complete = snapshot as WorkspaceSnapshot;
  const lineageIssue = await lineageError(complete);
  if (lineageIssue) return { ok: false, error: lineageIssue };
  const ownershipIssue =
    recordOwnershipError(
      complete.artifacts,
      complete.workspace.id,
      "artifact",
    ) ??
    recordOwnershipError(
      complete.evaluations,
      complete.workspace.id,
      "evaluation",
    ) ??
    recordOwnershipError(
      complete.auditEvents,
      complete.workspace.id,
      "audit event",
    );
  if (ownershipIssue) return { ok: false, error: ownershipIssue };
  return ok(complete as AdmittedSnapshot);
}

/**
 * Blob digests and the append-only revision chain: the snapshot must describe
 * one workspace whose revisions run 1..N and whose current revision is the tip.
 */
async function lineageError(
  snapshot: WorkspaceSnapshot,
): Promise<DomainError | null> {
  if (snapshot.revisions.length === 0)
    return snapshotError("Unsupported or empty workspace snapshot.");
  for (const blob of snapshot.blobs)
    if (
      (await sha256(blob.content)) !== blob.hash ||
      byteLength(blob.content) !== blob.bytes
    )
      return snapshotError(`Blob integrity check failed for ${blob.hash}.`);
  const revisions = [...snapshot.revisions].sort(
    (left, right) => left.revision - right.revision,
  );
  if (
    revisions.some(
      (revision, index) =>
        revision.revision !== index + 1 ||
        revision.parentRevision !== (index === 0 ? null : index),
    )
  )
    return snapshotError("Revision lineage is invalid.");
  if (snapshot.workspace.currentRevision !== revisions.at(-1)!.revision)
    return snapshotError(
      "The current workspace revision must be the lineage tip.",
    );
  if (
    revisions.some((revision) => revision.workspaceId !== snapshot.workspace.id)
  )
    return snapshotError("Snapshot revisions belong to another workspace.");
  return null;
}

/** Child records must name this workspace and must not repeat an id. */
function recordOwnershipError<T extends { id: string; workspaceId: string }>(
  records: readonly T[],
  workspaceId: string,
  label: string,
): DomainError | null {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.workspaceId !== workspaceId)
      return snapshotError(
        `Snapshot ${label} records belong to another workspace.`,
      );
    if (ids.has(record.id))
      return snapshotError(
        `Snapshot ${label} id ${record.id} appears more than once.`,
      );
    ids.add(record.id);
  }
  return null;
}

function snapshotError(message: string): DomainError {
  return { code: "invalid_snapshot", message };
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

function workspaceRecordError(value: unknown): string | null {
  if (!isJsonObject(value)) return "workspace must be an object.";
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
  if (!isJsonObject(value)) return "revision must be an object.";
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
      !isJsonObject(reference) ||
      typeof reference.path !== "string" ||
      typeof reference.contentHash !== "string" ||
      typeof reference.bytes !== "number" ||
      !Number.isInteger(reference.bytes) ||
      reference.bytes < 0
    )
      return "revision reference metadata is incomplete.";
  return null;
}

function artifactRecordError(value: unknown): string | null {
  if (!isJsonObject(value)) return "record must be an object.";
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
  if (!isJsonObject(value)) return "record must be an object.";
  if (
    !hasCanonicalPrefixedId(value.id, "audit") ||
    !hasCanonicalPrefixedId(value.workspaceId, "workspace") ||
    !isCanonicalUtcTimestamp(value.at) ||
    !["human", "webmcp", "system"].includes(value.actor as string) ||
    typeof value.action !== "string" ||
    (value.revision !== undefined && !Number.isInteger(value.revision)) ||
    (value.details !== undefined && !isJsonObject(value.details))
  )
    return "required metadata is missing.";
  return null;
}
