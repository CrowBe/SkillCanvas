import {
  RULESET_VERSION,
  byteLength,
  makeId,
  sha256,
  type DomainError,
} from "../shared";
import type {
  ArtifactRecord,
  AuditEvent,
  BlobRecord,
  EvaluationRecord,
  SkillRevision,
  WorkspaceBundle,
  WorkspaceRecord,
  WorkspaceReplacementTarget,
  WorkspaceSnapshot,
  WorkspaceStore,
} from "./types";
import {
  PortableSnapshotSizeError,
  portableSnapshotSizeError,
} from "./snapshot-budget";

type State = {
  workspaces: Map<string, WorkspaceRecord>;
  revisions: Map<string, SkillRevision[]>;
  blobs: Map<string, BlobRecord>;
  artifacts: Map<string, ArtifactRecord>;
  evaluations: Map<string, EvaluationRecord>;
  auditEvents: Map<string, AuditEvent>;
};

const domainError = (
  code: DomainError["code"],
  message: string,
  details?: Record<string, unknown>,
): DomainError => ({ code, message, ...(details ? { details } : {}) });

function snapshotRecordError<T extends { id: string; workspaceId: string }>(
  records: readonly T[],
  existing: ReadonlyMap<string, T>,
  workspaceId: string,
  label: string,
  replacedWorkspaceId?: string,
): DomainError | null {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.workspaceId !== workspaceId)
      return domainError(
        "invalid_snapshot",
        `Snapshot ${label} records belong to another workspace.`,
      );
    const existingRecord = existing.get(record.id);
    if (
      ids.has(record.id) ||
      (existingRecord?.workspaceId !== replacedWorkspaceId && existingRecord)
    )
      return domainError(
        "invalid_snapshot",
        `Snapshot ${label} id ${record.id} collides with existing data.`,
      );
    ids.add(record.id);
  }
  return null;
}

function deleteWorkspaceRecords<T extends { workspaceId: string }>(
  records: Map<string, T>,
  workspaceId: string,
): void {
  for (const [id, record] of records)
    if (record.workspaceId === workspaceId) records.delete(id);
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly generations = new Map<string, number>();
  protected readonly state: State = {
    workspaces: new Map(),
    revisions: new Map(),
    blobs: new Map(),
    artifacts: new Map(),
    evaluations: new Map(),
    auditEvents: new Map(),
  };

  async createWorkspace(input: {
    name: string;
    skillMd: string;
    referenceFiles: readonly { path: string; content: string }[];
    ephemeral?: boolean;
    actor?: AuditEvent["actor"];
  }): Promise<WorkspaceBundle> {
    const id = makeId("workspace");
    const now = new Date().toISOString();
    const contentHash = await this.putBlob(input.skillMd);
    const references = await Promise.all(
      input.referenceFiles.map(async (file) => ({
        path: file.path,
        contentHash: await this.putBlob(file.content),
        bytes: byteLength(file.content),
      })),
    );
    const workspace: WorkspaceRecord = {
      id,
      name: input.name,
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
      ephemeral: input.ephemeral ?? false,
    };
    const revision: SkillRevision = {
      workspaceId: id,
      revision: 1,
      parentRevision: null,
      contentHash,
      references,
      timestamp: now,
      rulesetVersion: RULESET_VERSION,
    };
    const audit: AuditEvent = {
      id: makeId("audit"),
      workspaceId: id,
      at: now,
      actor: input.actor ?? "human",
      action: "workspace.created",
      revision: 1,
    };
    this.state.workspaces.set(id, workspace);
    this.state.revisions.set(id, [revision]);
    this.state.auditEvents.set(audit.id, audit);
    this.bumpGeneration(id);
    const sizeIssue = this.enforcePortableBudget(id);
    if (sizeIssue) throw new PortableSnapshotSizeError(sizeIssue);
    return this.bundle(workspace, revision);
  }

  async listWorkspaces(): Promise<readonly WorkspaceRecord[]> {
    return [...this.state.workspaces.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async openWorkspace(
    workspaceId: string,
    revision?: number,
  ): Promise<WorkspaceBundle | DomainError> {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace)
      return domainError("workspace_not_found", "Workspace was not found.");
    const record = this.state.revisions
      .get(workspaceId)
      ?.find(
        (item) => item.revision === (revision ?? workspace.currentRevision),
      );
    if (!record)
      return domainError("revision_not_found", "Revision was not found.");
    return this.bundle(workspace, record);
  }

  async appendRevision(input: {
    workspaceId: string;
    baseRevision: number;
    skillMd: string;
    referenceFiles?: readonly { path: string; content: string }[];
    actor: AuditEvent["actor"];
  }): Promise<WorkspaceBundle | DomainError> {
    const workspace = this.state.workspaces.get(input.workspaceId);
    if (!workspace)
      return domainError("workspace_not_found", "Workspace was not found.");
    if (workspace.currentRevision !== input.baseRevision)
      return domainError(
        "revision_conflict",
        "The workspace changed after this edit began.",
        {
          expectedBaseRevision: workspace.currentRevision,
          receivedBaseRevision: input.baseRevision,
        },
      );
    const current = this.state.revisions
      .get(input.workspaceId)!
      .find((item) => item.revision === workspace.currentRevision)!;
    const previous = this.buildSnapshot(input.workspaceId);
    const previousGeneration = this.generations.get(input.workspaceId) ?? 0;
    const references = input.referenceFiles
      ? await Promise.all(
          input.referenceFiles.map(async (file) => ({
            path: file.path,
            contentHash: await this.putBlob(file.content),
            bytes: byteLength(file.content),
          })),
        )
      : current.references;
    const now = new Date().toISOString();
    const revisionNumber = workspace.currentRevision + 1;
    const revision: SkillRevision = {
      workspaceId: workspace.id,
      revision: revisionNumber,
      parentRevision: workspace.currentRevision,
      contentHash: await this.putBlob(input.skillMd),
      references,
      timestamp: now,
      rulesetVersion: RULESET_VERSION,
    };
    const nextWorkspace = {
      ...workspace,
      currentRevision: revisionNumber,
      updatedAt: now,
    };
    this.state.workspaces.set(workspace.id, nextWorkspace);
    this.state.revisions.get(workspace.id)!.push(revision);
    const audit: AuditEvent = {
      id: makeId("audit"),
      workspaceId: workspace.id,
      at: now,
      actor: input.actor,
      action: "skill.revision-appended",
      revision: revisionNumber,
      details: { baseRevision: input.baseRevision },
    };
    this.state.auditEvents.set(audit.id, audit);
    this.bumpGeneration(workspace.id);
    const sizeIssue = this.enforcePortableBudget(
      workspace.id,
      previous,
      previousGeneration,
    );
    if (sizeIssue) return sizeIssue;
    return this.bundle(nextWorkspace, revision);
  }

  async putArtifact(
    artifact: ArtifactRecord,
    expectedContentHash: string,
    expectedGeneration: number,
  ): Promise<void> {
    await this.updateArtifacts({
      workspaceId: artifact.workspaceId,
      revision: artifact.revision,
      expectedContentHash,
      expectedGeneration,
      artifacts: [artifact],
    });
  }
  async updateArtifacts(input: {
    workspaceId: string;
    revision: number;
    expectedContentHash: string;
    expectedGeneration: number;
    artifacts: readonly ArtifactRecord[];
    deleteIds?: readonly string[];
  }): Promise<void> {
    if (
      (this.generations.get(input.workspaceId) ?? 0) !==
      input.expectedGeneration
    )
      throw new Error("Workspace evidence changed before it was saved.");
    this.requireEvidenceRevision(
      input.workspaceId,
      input.revision,
      input.expectedContentHash,
    );
    for (const artifact of input.artifacts) {
      const existing = this.state.artifacts.get(artifact.id);
      if (
        artifact.workspaceId !== input.workspaceId ||
        artifact.revision !== input.revision ||
        (existing && existing.workspaceId !== input.workspaceId)
      )
        throw new Error("Artifact evidence ownership changed.");
    }
    for (const id of input.deleteIds ?? []) {
      const existing = this.state.artifacts.get(id);
      if (existing && existing.workspaceId !== input.workspaceId)
        throw new Error("Artifact evidence ownership changed.");
    }
    const previous = this.buildSnapshot(input.workspaceId);
    const previousGeneration = this.generations.get(input.workspaceId) ?? 0;
    for (const id of input.deleteIds ?? []) this.state.artifacts.delete(id);
    for (const artifact of input.artifacts)
      this.state.artifacts.set(artifact.id, structuredClone(artifact));
    this.bumpGeneration(input.workspaceId);
    const sizeIssue = this.enforcePortableBudget(
      input.workspaceId,
      previous,
      previousGeneration,
    );
    if (sizeIssue) throw new PortableSnapshotSizeError(sizeIssue);
  }
  async recordEvaluationEvidence(
    evaluation: EvaluationRecord,
    expected?: EvaluationRecord,
  ): Promise<void> {
    this.requireEvidenceRevision(
      evaluation.workspaceId,
      evaluation.revision,
      evaluation.contentHash,
    );
    const existing = this.state.evaluations.get(evaluation.id);
    if (
      (expected === undefined && existing !== undefined) ||
      (expected !== undefined && !sameRecord(existing, expected))
    )
      throw new Error("Evaluation evidence changed in another operation.");
    const previous = this.buildSnapshot(evaluation.workspaceId);
    const previousGeneration =
      this.generations.get(evaluation.workspaceId) ?? 0;
    this.state.evaluations.set(evaluation.id, structuredClone(evaluation));
    this.bumpGeneration(evaluation.workspaceId);
    const sizeIssue = this.enforcePortableBudget(
      evaluation.workspaceId,
      previous,
      previousGeneration,
    );
    if (sizeIssue) throw new PortableSnapshotSizeError(sizeIssue);
  }
  async appendAuditEvent(event: AuditEvent): Promise<void> {
    const previous = this.buildSnapshot(event.workspaceId);
    const previousGeneration = this.generations.get(event.workspaceId) ?? 0;
    this.state.auditEvents.set(event.id, structuredClone(event));
    this.bumpGeneration(event.workspaceId);
    const sizeIssue = this.enforcePortableBudget(
      event.workspaceId,
      previous,
      previousGeneration,
    );
    if (sizeIssue) throw new PortableSnapshotSizeError(sizeIssue);
  }

  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
    const snapshot = this.buildSnapshot(workspaceId);
    if ("code" in snapshot) return snapshot;
    return portableSnapshotSizeError(snapshot) ?? snapshot;
  }

  private buildSnapshot(workspaceId: string): WorkspaceSnapshot | DomainError {
    const workspace = this.state.workspaces.get(workspaceId);
    const revisions = this.state.revisions.get(workspaceId);
    if (!workspace || !revisions)
      return domainError("workspace_not_found", "Workspace was not found.");
    const hashes = new Set(
      revisions.flatMap((revision) => [
        revision.contentHash,
        ...revision.references.map((ref) => ref.contentHash),
      ]),
    );
    return {
      snapshotVersion: 1,
      exportedAt: new Date().toISOString(),
      workspace: structuredClone(workspace),
      revisions: structuredClone(revisions),
      blobs: [...hashes].flatMap((hash) =>
        this.state.blobs.get(hash)
          ? [structuredClone(this.state.blobs.get(hash)!)]
          : [],
      ),
      artifacts: this.workspaceValues(this.state.artifacts, workspaceId),
      evaluations: this.workspaceValues(this.state.evaluations, workspaceId),
      auditEvents: this.workspaceValues(this.state.auditEvents, workspaceId),
    };
  }

  async importSnapshot(
    snapshot: WorkspaceSnapshot,
    options: {
      replaceExisting?: boolean;
      replacementTarget?: WorkspaceReplacementTarget;
    } = {},
  ): Promise<WorkspaceBundle | DomainError> {
    const validation = await this.validateSnapshot(snapshot, options);
    if (validation) return validation;
    if (options.replaceExisting) this.removeWorkspace(snapshot.workspace.id);
    return this.admitSnapshot(snapshot);
  }

  async validateSnapshot(
    snapshot: WorkspaceSnapshot,
    options: {
      replaceExisting?: boolean;
      replacementTarget?: WorkspaceReplacementTarget;
    } = {},
  ): Promise<DomainError | null> {
    const sizeIssue = portableSnapshotSizeError(snapshot);
    if (sizeIssue) return sizeIssue;
    const existingWorkspace = this.state.workspaces.get(snapshot.workspace.id);
    if (
      options.replaceExisting &&
      (!options.replacementTarget ||
        !sameWorkspace(
          existingWorkspace,
          options.replacementTarget.workspace,
        ) ||
        this.generations.get(snapshot.workspace.id) !==
          options.replacementTarget.generation)
    )
      return domainError(
        "revision_conflict",
        "The saved workspace changed after replacement was confirmed.",
      );
    if (existingWorkspace && !options.replaceExisting)
      return domainError(
        "invalid_snapshot",
        "A workspace with this id already exists and requires confirmed replacement.",
      );
    if (snapshot.snapshotVersion !== 1 || snapshot.revisions.length === 0)
      return domainError(
        "invalid_snapshot",
        "Unsupported or empty workspace snapshot.",
      );
    for (const blob of snapshot.blobs)
      if (
        (await sha256(blob.content)) !== blob.hash ||
        byteLength(blob.content) !== blob.bytes
      )
        return domainError(
          "invalid_snapshot",
          `Blob integrity check failed for ${blob.hash}.`,
        );
    const revisions = [...snapshot.revisions].sort(
      (a, b) => a.revision - b.revision,
    );
    if (
      revisions.some(
        (revision, index) =>
          revision.revision !== index + 1 ||
          revision.parentRevision !== (index === 0 ? null : index),
      )
    )
      return domainError("invalid_snapshot", "Revision lineage is invalid.");
    if (snapshot.workspace.currentRevision !== revisions.at(-1)!.revision)
      return domainError(
        "invalid_snapshot",
        "The current workspace revision must be the lineage tip.",
      );
    if (
      revisions.some(
        (revision) => revision.workspaceId !== snapshot.workspace.id,
      )
    )
      return domainError(
        "invalid_snapshot",
        "Snapshot revisions belong to another workspace.",
      );
    const recordError =
      snapshotRecordError(
        snapshot.artifacts,
        this.state.artifacts,
        snapshot.workspace.id,
        "artifact",
        options.replaceExisting ? snapshot.workspace.id : undefined,
      ) ??
      snapshotRecordError(
        snapshot.evaluations,
        this.state.evaluations,
        snapshot.workspace.id,
        "evaluation",
        options.replaceExisting ? snapshot.workspace.id : undefined,
      ) ??
      snapshotRecordError(
        snapshot.auditEvents,
        this.state.auditEvents,
        snapshot.workspace.id,
        "audit event",
        options.replaceExisting ? snapshot.workspace.id : undefined,
      );
    if (recordError) return recordError;
    return null;
  }

  loadValidatedSnapshot(
    snapshot: WorkspaceSnapshot,
    options: { replaceExisting?: boolean; generation?: number } = {},
  ): WorkspaceBundle {
    if (options.replaceExisting) this.removeWorkspace(snapshot.workspace.id);
    return this.admitSnapshot(snapshot, options.generation);
  }

  private admitSnapshot(
    snapshot: WorkspaceSnapshot,
    generation?: number,
  ): WorkspaceBundle {
    const revisions = [...snapshot.revisions].sort(
      (a, b) => a.revision - b.revision,
    );
    snapshot.blobs.forEach((blob) =>
      this.state.blobs.set(blob.hash, structuredClone(blob)),
    );
    this.state.workspaces.set(
      snapshot.workspace.id,
      structuredClone(snapshot.workspace),
    );
    this.state.revisions.set(snapshot.workspace.id, structuredClone(revisions));
    snapshot.artifacts.forEach((item) =>
      this.state.artifacts.set(item.id, structuredClone(item)),
    );
    snapshot.evaluations.forEach((item) =>
      this.state.evaluations.set(item.id, structuredClone(item)),
    );
    snapshot.auditEvents.forEach((item) =>
      this.state.auditEvents.set(item.id, structuredClone(item)),
    );
    if (generation === undefined) this.bumpGeneration(snapshot.workspace.id);
    else this.generations.set(snapshot.workspace.id, generation);
    return this.bundle(
      snapshot.workspace,
      revisions.find(
        (revision) => revision.revision === snapshot.workspace.currentRevision,
      )!,
    );
  }

  async restoreWorkspace(
    workspaceId: string,
    snapshot?: WorkspaceSnapshot,
  ): Promise<void> {
    if (snapshot) {
      const target = await this.getReplacementTarget(workspaceId);
      const validation = await this.validateSnapshot(snapshot, {
        replaceExisting: true,
        replacementTarget: "code" in target ? undefined : target,
      });
      if (validation) throw new Error(validation.message);
    }
    this.removeWorkspace(workspaceId);
    if (snapshot) this.admitSnapshot(snapshot);
  }

  private removeWorkspace(workspaceId: string): void {
    this.generations.delete(workspaceId);
    this.state.workspaces.delete(workspaceId);
    this.state.revisions.delete(workspaceId);
    deleteWorkspaceRecords(this.state.artifacts, workspaceId);
    deleteWorkspaceRecords(this.state.evaluations, workspaceId);
    deleteWorkspaceRecords(this.state.auditEvents, workspaceId);
    const referencedHashes = new Set(
      [...this.state.revisions.values()].flatMap((revisions) =>
        revisions.flatMap((revision) => [
          revision.contentHash,
          ...revision.references.map((reference) => reference.contentHash),
        ]),
      ),
    );
    for (const hash of this.state.blobs.keys())
      if (!referencedHashes.has(hash)) this.state.blobs.delete(hash);
  }

  private enforcePortableBudget(
    workspaceId: string,
    previous?: WorkspaceSnapshot | DomainError,
    previousGeneration = 0,
  ): DomainError | null {
    const candidate = this.buildSnapshot(workspaceId);
    if ("code" in candidate) return candidate;
    const sizeIssue = portableSnapshotSizeError(candidate);
    if (!sizeIssue) return null;
    this.removeWorkspace(workspaceId);
    if (previous && !("code" in previous))
      this.admitSnapshot(previous, previousGeneration);
    return sizeIssue;
  }

  async getReplacementTarget(
    workspaceId: string,
  ): Promise<WorkspaceReplacementTarget | DomainError> {
    const workspace = this.state.workspaces.get(workspaceId);
    if (!workspace)
      return domainError("workspace_not_found", "Workspace was not found.");
    return {
      workspace: structuredClone(workspace),
      generation: this.generations.get(workspaceId) ?? 0,
    };
  }

  private bumpGeneration(workspaceId: string): void {
    this.generations.set(
      workspaceId,
      (this.generations.get(workspaceId) ?? 0) + 1,
    );
  }

  private requireEvidenceRevision(
    workspaceId: string,
    revision: number,
    contentHash: string,
  ): void {
    const persisted = this.state.revisions
      .get(workspaceId)
      ?.find((record) => record.revision === revision);
    if (!persisted || persisted.contentHash !== contentHash)
      throw new Error("Evidence revision changed before it was saved.");
  }

  protected async putBlob(content: string): Promise<string> {
    const hash = await sha256(content);
    if (!this.state.blobs.has(hash))
      this.state.blobs.set(hash, { hash, content, bytes: byteLength(content) });
    return hash;
  }
  private workspaceValues<T extends { workspaceId: string }>(
    map: Map<string, T>,
    workspaceId: string,
  ): T[] {
    return [...map.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .map((item) => structuredClone(item));
  }
  private bundle(
    workspace: WorkspaceRecord,
    revision: SkillRevision,
  ): WorkspaceBundle {
    const skillMd = this.state.blobs.get(revision.contentHash)!.content;
    return {
      evidenceGeneration: this.generations.get(workspace.id) ?? 0,
      workspace: structuredClone(workspace),
      revision: structuredClone(revision),
      skillMd,
      referenceFiles: revision.references.map((ref) => ({
        path: ref.path,
        content: this.state.blobs.get(ref.contentHash)!.content,
      })),
      artifacts: this.workspaceValues(
        this.state.artifacts,
        workspace.id,
      ).filter((item) => item.revision === revision.revision),
      evaluations: this.workspaceValues(this.state.evaluations, workspace.id),
      auditEvents: this.workspaceValues(this.state.auditEvents, workspace.id),
    };
  }
}

function sameWorkspace(
  left: WorkspaceRecord | undefined,
  right: WorkspaceRecord,
): boolean {
  return (
    left !== undefined &&
    left.id === right.id &&
    left.name === right.name &&
    left.currentRevision === right.currentRevision &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.ephemeral === right.ephemeral
  );
}
