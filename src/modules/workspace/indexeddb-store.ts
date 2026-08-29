import { openDB, type IDBPDatabase } from "idb";
import type { DomainError } from "../shared";
import { MemoryWorkspaceStore } from "./memory-store";
import type {
  ArtifactRecord,
  AuditEvent,
  EvaluationRecord,
  SkillRevision,
  WorkspaceBundle,
  WorkspaceRecord,
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

type PersistCondition =
  | { readonly kind: "create" }
  | { readonly kind: "append"; readonly baseRevision: number }
  | {
      readonly kind: "replace";
      readonly target: WorkspaceRecord;
    }
  | { readonly kind: "existing"; readonly target: WorkspaceRecord };

const persistenceError = (
  code: DomainError["code"],
  message: string,
  details?: Record<string, unknown>,
): DomainError => ({ code, message, ...(details ? { details } : {}) });

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
    condition: PersistCondition,
  ): Promise<DomainError | null> {
    const snapshot = await memory.exportSnapshot(workspaceId);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readwrite");
    const [
      workspaces,
      persistedRevisions,
      ,
      artifacts,
      evaluations,
      auditEvents,
    ] = (await Promise.all(
      STORES.map((store) => transaction.objectStore(store).getAll()),
    )) as [
      WorkspaceRecord[],
      (SkillRevision & { key: string })[],
      unknown[],
      ArtifactRecord[],
      EvaluationRecord[],
      AuditEvent[],
    ];
    const persistedWorkspace = workspaces.find(
      (workspace) => workspace.id === workspaceId,
    );
    let conflict: DomainError | null = null;
    if (condition.kind === "create" && persistedWorkspace)
      conflict = persistenceError(
        "invalid_snapshot",
        "A workspace with this id already exists.",
      );
    if (
      condition.kind === "append" &&
      persistedWorkspace?.currentRevision !== condition.baseRevision
    )
      conflict = persistenceError(
        "revision_conflict",
        "The workspace changed after this edit began.",
        {
          expectedBaseRevision: persistedWorkspace?.currentRevision,
          receivedBaseRevision: condition.baseRevision,
        },
      );
    if (
      (condition.kind === "replace" || condition.kind === "existing") &&
      !sameWorkspace(persistedWorkspace, condition.target)
    )
      conflict = persistenceError(
        "revision_conflict",
        condition.kind === "replace"
          ? "The saved workspace changed after replacement was confirmed."
          : "The workspace changed in another browser tab.",
      );
    for (const [records, incoming, label] of [
      [artifacts, snapshot.artifacts, "artifact"],
      [evaluations, snapshot.evaluations, "evaluation"],
      [auditEvents, snapshot.auditEvents, "audit event"],
    ] as const) {
      if (
        incoming.some((record) =>
          records.some(
            (persisted) =>
              persisted.id === record.id &&
              persisted.workspaceId !== workspaceId,
          ),
        )
      )
        conflict = persistenceError(
          "invalid_snapshot",
          `Snapshot ${label} id collides with existing data.`,
        );
    }
    if (conflict) {
      await transaction.done;
      return conflict;
    }
    const priorRevisions = persistedRevisions.filter(
      (revision) => revision.workspaceId === workspaceId,
    );
    const priorArtifacts = artifacts.filter(
      (artifact) => artifact.workspaceId === workspaceId,
    );
    const priorEvaluations = evaluations.filter(
      (evaluation) => evaluation.workspaceId === workspaceId,
    );
    const priorAuditEvents = auditEvents.filter(
      (event) => event.workspaceId === workspaceId,
    );
    const currentHashes = new Set(snapshot.blobs.map((blob) => blob.hash));
    const staleHashes = [
      ...new Set(
        priorRevisions.flatMap((revision) => [
          revision.contentHash,
          ...revision.references.map((reference) => reference.contentHash),
        ]),
      ),
    ].filter(
      (hash) =>
        !currentHashes.has(hash) &&
        !persistedRevisions.some(
          (revision) =>
            revision.workspaceId !== workspaceId &&
            (revision.contentHash === hash ||
              revision.references.some(
                (reference) => reference.contentHash === hash,
              )),
        ),
    );
    await Promise.all([
      ...priorRevisions.map((revision) =>
        transaction
          .objectStore("revisions")
          .delete(`${revision.workspaceId}:${revision.revision}`),
      ),
      ...priorArtifacts.map((artifact) =>
        transaction.objectStore("artifacts").delete(artifact.id),
      ),
      ...priorEvaluations.map((evaluation) =>
        transaction.objectStore("evaluations").delete(evaluation.id),
      ),
      ...priorAuditEvents.map((event) =>
        transaction.objectStore("auditEvents").delete(event.id),
      ),
      ...staleHashes.map((hash) =>
        transaction.objectStore("blobs").delete(hash),
      ),
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
    return null;
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
    condition?: (previous: WorkspaceSnapshot | undefined) => PersistCondition,
    onConflict?: (error: DomainError) => T,
  ): Promise<T> {
    return this.enqueueMutation(async () => {
      const previous = targetWorkspaceId
        ? await this.memory.exportSnapshot(targetWorkspaceId)
        : undefined;
      const staged = new MemoryWorkspaceStore();
      if (previous && !("code" in previous)) {
        staged.loadValidatedSnapshot(previous);
      }
      const result = await operation(staged);
      const id = workspaceId(result);
      if (id === undefined) return result;
      const conflict = await this.persist(
        staged,
        id,
        condition?.(
          previous && !("code" in previous) ? previous : undefined,
        ) ?? { kind: "create" },
      );
      if (conflict) {
        this.memory = new MemoryWorkspaceStore();
        this.hydrated = false;
        if (onConflict) return onConflict(conflict);
        throw new Error(conflict.message);
      }
      const committed = await staged.exportSnapshot(id);
      if ("code" in committed) throw new Error(committed.message);
      this.memory.loadValidatedSnapshot(committed, {
        replaceExisting: true,
      });
      return result;
    });
  }

  async createWorkspace(
    input: Parameters<WorkspaceStore["createWorkspace"]>[0],
  ): Promise<WorkspaceBundle> {
    await this.hydrate();
    return this.commitMutation(
      (staged) => staged.createWorkspace(input),
      (bundle) => bundle.workspace.id,
      undefined,
      () => ({ kind: "create" }),
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
      () => ({ kind: "append", baseRevision: input.baseRevision }),
      (error) => error,
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
      (previous) => ({ kind: "existing", target: previous!.workspace }),
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
      (previous) => ({ kind: "existing", target: previous!.workspace }),
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
      (previous) => ({ kind: "existing", target: previous!.workspace }),
    );
  }
  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
    await this.hydrate();
    return this.memory.exportSnapshot(workspaceId);
  }
  async importSnapshot(
    snapshot: WorkspaceSnapshot,
    options: {
      replaceExisting?: boolean;
      replacementTarget?: WorkspaceRecord;
    } = {},
  ) {
    await this.hydrate();
    return this.commitMutation(
      async (staged) => {
        const validation = await this.memory.validateSnapshot(
          snapshot,
          options,
        );
        return validation ?? staged.loadValidatedSnapshot(snapshot, options);
      },
      (result) => ("code" in result ? undefined : result.workspace.id),
      snapshot.workspace.id,
      () =>
        options.replaceExisting
          ? { kind: "replace", target: options.replacementTarget! }
          : { kind: "create" },
      (error) => error,
    );
  }
}
