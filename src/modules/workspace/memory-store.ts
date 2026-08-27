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
  WorkspaceSnapshot,
  WorkspaceStore,
} from "./types";

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

export class MemoryWorkspaceStore implements WorkspaceStore {
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
    await this.appendAuditEvent({
      id: makeId("audit"),
      workspaceId: workspace.id,
      at: now,
      actor: input.actor,
      action: "skill.revision-appended",
      revision: revisionNumber,
      details: { baseRevision: input.baseRevision },
    });
    return this.bundle(nextWorkspace, revision);
  }

  async putArtifact(artifact: ArtifactRecord): Promise<void> {
    this.state.artifacts.set(artifact.id, structuredClone(artifact));
  }
  async recordEvaluationEvidence(evaluation: EvaluationRecord): Promise<void> {
    this.state.evaluations.set(evaluation.id, structuredClone(evaluation));
  }
  async appendAuditEvent(event: AuditEvent): Promise<void> {
    this.state.auditEvents.set(event.id, structuredClone(event));
  }

  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
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
  ): Promise<WorkspaceBundle | DomainError> {
    if (snapshot.snapshotVersion !== 1 || snapshot.revisions.length === 0)
      return domainError(
        "invalid_snapshot",
        "Unsupported or empty workspace snapshot.",
      );
    if (this.state.workspaces.has(snapshot.workspace.id))
      return domainError(
        "invalid_snapshot",
        "A workspace with this id already exists.",
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
    return this.bundle(
      snapshot.workspace,
      revisions.find(
        (revision) => revision.revision === snapshot.workspace.currentRevision,
      )!,
    );
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
