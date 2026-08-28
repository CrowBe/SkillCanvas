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
 * separate versioned object stores. Immutable blobs are keyed by byte-exact
 * hash, so identical SKILL.md/reference content is stored once.
 */
export class IndexedDbWorkspaceStore implements WorkspaceStore {
  private memory = new MemoryWorkspaceStore();
  private database?: IDBPDatabase;
  private hydrated = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(database?: IDBPDatabase) {
    this.database = database;
  }

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

  private async persist(
    memory: MemoryWorkspaceStore,
    workspaceId: string,
    previous?: WorkspaceSnapshot,
  ): Promise<void> {
    const snapshot = await memory.exportSnapshot(workspaceId);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readwrite");
    await Promise.all([
      ...(previous?.revisions.map((revision) =>
        transaction
          .objectStore("revisions")
          .delete(`${revision.workspaceId}:${revision.revision}`),
      ) ?? []),
      ...(previous?.artifacts.map((artifact) =>
        transaction.objectStore("artifacts").delete(artifact.id),
      ) ?? []),
      ...(previous?.evaluations.map((evaluation) =>
        transaction.objectStore("evaluations").delete(evaluation.id),
      ) ?? []),
      ...(previous?.auditEvents.map((event) =>
        transaction.objectStore("auditEvents").delete(event.id),
      ) ?? []),
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

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commitMutation<T>(
    operation: (memory: MemoryWorkspaceStore) => Promise<T>,
    workspaceId: (result: T) => string | undefined,
    targetWorkspaceId?: string,
  ): Promise<T> {
    return this.enqueueMutation(async () => {
      const previous = targetWorkspaceId
        ? await this.memory.exportSnapshot(targetWorkspaceId)
        : undefined;
      let mutatedWorkspaceId = targetWorkspaceId;
      try {
        const result = await operation(this.memory);
        const id = workspaceId(result);
        if (id !== undefined) {
          mutatedWorkspaceId = id;
          await this.persist(
            this.memory,
            id,
            previous && !("code" in previous) ? previous : undefined,
          );
        }
        return result;
      } catch (error) {
        if (mutatedWorkspaceId)
          await this.memory.restoreWorkspace(
            mutatedWorkspaceId,
            previous && !("code" in previous) ? previous : undefined,
          );
        throw error;
      }
    });
  }

  async createWorkspace(
    input: Parameters<WorkspaceStore["createWorkspace"]>[0],
  ): Promise<WorkspaceBundle> {
    await this.hydrate();
    return this.commitMutation(
      (staged) => staged.createWorkspace(input),
      (bundle) => bundle.workspace.id,
    );
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
    return this.commitMutation(
      (staged) => staged.appendRevision(input),
      (result) => ("code" in result ? undefined : input.workspaceId),
      input.workspaceId,
    );
  }
  async putArtifact(artifact: ArtifactRecord) {
    await this.hydrate();
    await this.commitMutation(
      async (staged) => {
        await staged.putArtifact(artifact);
      },
      () => artifact.workspaceId,
      artifact.workspaceId,
    );
  }
  async recordEvaluationEvidence(evaluation: EvaluationRecord) {
    await this.hydrate();
    await this.commitMutation(
      async (staged) => {
        await staged.recordEvaluationEvidence(evaluation);
      },
      () => evaluation.workspaceId,
      evaluation.workspaceId,
    );
  }
  async appendAuditEvent(event: AuditEvent) {
    await this.hydrate();
    await this.commitMutation(
      async (staged) => {
        await staged.appendAuditEvent(event);
      },
      () => event.workspaceId,
      event.workspaceId,
    );
  }
  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
    await this.hydrate();
    return this.memory.exportSnapshot(workspaceId);
  }
  async importSnapshot(snapshot: WorkspaceSnapshot) {
    await this.hydrate();
    return this.commitMutation(
      (staged) => staged.importSnapshot(snapshot),
      (result) => ("code" in result ? undefined : result.workspace.id),
      snapshot.workspace.id,
    );
  }
}
