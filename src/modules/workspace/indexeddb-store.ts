import { openDB, type IDBPDatabase } from "idb";
import type { DomainError } from "../shared";
import { MemoryWorkspaceStore } from "./memory-store";
import type {
  ArtifactRecord,
  AuditEvent,
  EvaluationRecord,
  WorkspaceBundle,
  WorkspaceSnapshot,
  WorkspaceStore,
} from "./types";

const DATABASE_NAME = "skill-canvas-workspaces";
const DATABASE_VERSION = 1;
const STORES = [
  "workspaces",
  "revisions",
  "blobs",
  "artifacts",
  "evaluations",
  "auditEvents",
] as const;

/**
 * Durable browser adapter. Domain behavior remains in the memory contract
 * implementation; this adapter hydrates/persists the same bounded records in
 * separate versioned object stores. Immutable blobs are keyed by canonical
 * hash, so identical SKILL.md/reference content is stored once.
 */
export class IndexedDbWorkspaceStore implements WorkspaceStore {
  private readonly memory = new MemoryWorkspaceStore();
  private database?: IDBPDatabase;
  private hydrated = false;

  private async db(): Promise<IDBPDatabase> {
    if (this.database) return this.database;
    this.database = await openDB(DATABASE_NAME, DATABASE_VERSION, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore("workspaces", { keyPath: "id" });
          database.createObjectStore("revisions", { keyPath: "key" });
          database.createObjectStore("blobs", { keyPath: "hash" });
          database.createObjectStore("artifacts", { keyPath: "id" });
          database.createObjectStore("evaluations", { keyPath: "id" });
          database.createObjectStore("auditEvents", { keyPath: "id" });
        }
      },
    });
    return this.database;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const db = await this.db();
    const [workspaces, revisions, blobs, artifacts, evaluations, auditEvents] =
      await Promise.all(STORES.map((store) => db.getAll(store)));
    for (const workspace of workspaces as any[]) {
      const snapshot: WorkspaceSnapshot = {
        snapshotVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace,
        revisions: (revisions as any[])
          .filter((item) => item.workspaceId === workspace.id)
          .map((item) => {
            const revision = { ...item };
            delete revision.key;
            return revision;
          }),
        blobs: (blobs as any[]).filter((blob) =>
          (revisions as any[]).some(
            (revision) =>
              revision.workspaceId === workspace.id &&
              (revision.contentHash === blob.hash ||
                revision.references.some(
                  (ref: any) => ref.contentHash === blob.hash,
                )),
          ),
        ),
        artifacts: (artifacts as ArtifactRecord[]).filter(
          (item) => item.workspaceId === workspace.id,
        ),
        evaluations: (evaluations as EvaluationRecord[]).filter(
          (item) => item.workspaceId === workspace.id,
        ),
        auditEvents: (auditEvents as AuditEvent[]).filter(
          (item) => item.workspaceId === workspace.id,
        ),
      };
      await this.memory.importSnapshot(snapshot);
    }
    this.hydrated = true;
  }

  private async persist(workspaceId: string): Promise<void> {
    const snapshot = await this.memory.exportSnapshot(workspaceId);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readwrite");
    await Promise.all([
      transaction.objectStore("workspaces").put(snapshot.workspace),
      ...snapshot.revisions.map((revision) =>
        transaction.objectStore("revisions").put({
          ...revision,
          key: `${revision.workspaceId}:${revision.revision}`,
        }),
      ),
      ...snapshot.blobs.map((blob) =>
        transaction.objectStore("blobs").put(blob),
      ),
      ...snapshot.artifacts.map((artifact) =>
        transaction.objectStore("artifacts").put(artifact),
      ),
      ...snapshot.evaluations.map((evaluation) =>
        transaction.objectStore("evaluations").put(evaluation),
      ),
      ...snapshot.auditEvents.map((event) =>
        transaction.objectStore("auditEvents").put(event),
      ),
      transaction.done,
    ]);
  }

  async createWorkspace(
    input: Parameters<WorkspaceStore["createWorkspace"]>[0],
  ): Promise<WorkspaceBundle> {
    await this.hydrate();
    const bundle = await this.memory.createWorkspace(input);
    await this.persist(bundle.workspace.id);
    return bundle;
  }
  async listWorkspaces() {
    await this.hydrate();
    return this.memory.listWorkspaces();
  }
  async openWorkspace(workspaceId: string, revision?: number) {
    await this.hydrate();
    return this.memory.openWorkspace(workspaceId, revision);
  }
  async appendRevision(input: Parameters<WorkspaceStore["appendRevision"]>[0]) {
    await this.hydrate();
    const result = await this.memory.appendRevision(input);
    if (!("code" in result)) await this.persist(input.workspaceId);
    return result;
  }
  async putArtifact(artifact: ArtifactRecord) {
    await this.hydrate();
    await this.memory.putArtifact(artifact);
    await this.persist(artifact.workspaceId);
  }
  async recordEvaluationEvidence(evaluation: EvaluationRecord) {
    await this.hydrate();
    await this.memory.recordEvaluationEvidence(evaluation);
    await this.persist(evaluation.workspaceId);
  }
  async appendAuditEvent(event: AuditEvent) {
    await this.hydrate();
    await this.memory.appendAuditEvent(event);
    await this.persist(event.workspaceId);
  }
  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
    await this.hydrate();
    return this.memory.exportSnapshot(workspaceId);
  }
  async importSnapshot(snapshot: WorkspaceSnapshot) {
    await this.hydrate();
    const result = await this.memory.importSnapshot(snapshot);
    if (!("code" in result)) await this.persist(result.workspace.id);
    return result;
  }
}
