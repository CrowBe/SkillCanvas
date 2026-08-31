import type { InstructionLoadVector, InstructionMap } from "../instruction-map";
import type { DomainError } from "../shared";

export type BlobRecord = {
  readonly hash: string;
  readonly content: string;
  readonly bytes: number;
};
export type ReferencePointer = {
  readonly path: string;
  readonly contentHash: string;
  readonly bytes: number;
};
export type SkillRevision = {
  readonly workspaceId: string;
  readonly revision: number;
  readonly parentRevision: number | null;
  readonly contentHash: string;
  readonly references: readonly ReferencePointer[];
  readonly timestamp: string;
  readonly rulesetVersion: string;
};
export type WorkspaceRecord = {
  readonly id: string;
  readonly name: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly ephemeral: boolean;
};
export type WorkspaceReplacementTarget = {
  readonly workspace: WorkspaceRecord;
  readonly generation: number;
};
export type ArtifactRecord = {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly kind:
    | "lint"
    | "structure"
    | "instruction-map"
    | "instruction-load"
    | "compare"
    | "comparison-evaluation-state";
  readonly version: string;
  readonly createdAt: string;
  readonly data: unknown;
};
export type AuditEvent = {
  readonly id: string;
  readonly workspaceId: string;
  readonly at: string;
  readonly actor: "human" | "webmcp" | "system";
  readonly action: string;
  readonly revision?: number;
  readonly details?: Readonly<Record<string, unknown>>;
};
export type EvaluationKind = "triggering" | "test-run" | "capacity-probe";
export type EvaluationRecord = {
  readonly id: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly contentHash: string;
  readonly kind: EvaluationKind;
  readonly status: "prepared" | "in-progress" | "complete";
  readonly versions: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly data: unknown;
};
export type WorkspaceBundle = {
  readonly evidenceGeneration: number;
  readonly workspace: WorkspaceRecord;
  readonly revision: SkillRevision;
  readonly skillMd: string;
  readonly referenceFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly evaluations: readonly EvaluationRecord[];
  readonly auditEvents: readonly AuditEvent[];
};
export type WorkspaceSnapshot = {
  readonly snapshotVersion: 1;
  readonly exportedAt: string;
  readonly workspace: WorkspaceRecord;
  readonly revisions: readonly SkillRevision[];
  readonly blobs: readonly BlobRecord[];
  readonly artifacts: readonly ArtifactRecord[];
  readonly evaluations: readonly EvaluationRecord[];
  readonly auditEvents: readonly AuditEvent[];
};

export interface WorkspaceStore {
  createWorkspace(input: {
    name: string;
    skillMd: string;
    referenceFiles: readonly { path: string; content: string }[];
    ephemeral?: boolean;
    actor?: AuditEvent["actor"];
  }): Promise<WorkspaceBundle>;
  listWorkspaces(): Promise<readonly WorkspaceRecord[]>;
  openWorkspace(
    workspaceId: string,
    revision?: number,
  ): Promise<WorkspaceBundle | DomainError>;
  appendRevision(input: {
    workspaceId: string;
    baseRevision: number;
    skillMd: string;
    referenceFiles?: readonly { path: string; content: string }[];
    actor: AuditEvent["actor"];
  }): Promise<WorkspaceBundle | DomainError>;
  putArtifact(
    artifact: ArtifactRecord,
    expectedContentHash: string,
    expectedGeneration: number,
  ): Promise<void>;
  updateArtifacts(input: {
    workspaceId: string;
    revision: number;
    expectedContentHash: string;
    expectedGeneration: number;
    artifacts: readonly ArtifactRecord[];
    deleteIds?: readonly string[];
  }): Promise<void>;
  recordEvaluationEvidence(
    evaluation: EvaluationRecord,
    expected?: EvaluationRecord,
  ): Promise<void>;
  appendAuditEvent(event: AuditEvent): Promise<void>;
  exportSnapshot(workspaceId: string): Promise<WorkspaceSnapshot | DomainError>;
  getReplacementTarget(
    workspaceId: string,
  ): Promise<WorkspaceReplacementTarget | DomainError>;
  importSnapshot(
    snapshot: WorkspaceSnapshot,
    options?: {
      replaceExisting?: boolean;
      replacementTarget?: WorkspaceReplacementTarget;
    },
  ): Promise<WorkspaceBundle | DomainError>;
}

export type AcceptedInstructionArtifacts = {
  readonly map: InstructionMap;
  readonly vector: InstructionLoadVector;
};
