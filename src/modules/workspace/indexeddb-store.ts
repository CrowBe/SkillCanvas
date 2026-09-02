import { openDB, type IDBPDatabase } from "idb";
import { DomainMutationError, type DomainError } from "../shared";
import { MemoryWorkspaceStore } from "./memory-store";
import { portableSnapshotSizeError } from "./snapshot-budget";
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

const DATABASE_NAME = "skill-canvas-workspaces";
const DATABASE_VERSION = 2;
const STORES = [
  "workspaces",
  "revisions",
  "blobs",
  "artifacts",
  "evaluations",
  "auditEvents",
] as const;

type PersistedWorkspace = WorkspaceRecord & { persistenceGeneration: number };
type PersistedRevision = SkillRevision & {
  key: string;
  blobHashes: readonly string[];
};
type PersistCondition =
  | { readonly kind: "create" }
  | {
      readonly kind: "append";
      readonly base: SkillRevision;
      readonly workspace: WorkspaceRecord;
    }
  | {
      readonly kind: "replace";
      readonly target: WorkspaceReplacementTarget;
    }
  | {
      readonly kind: "artifacts";
      readonly records: readonly ArtifactRecord[];
      readonly deleteIds: readonly string[];
      readonly revision: number;
      readonly expectedContentHash: string;
      readonly expectedGeneration: number;
    }
  | {
      readonly kind: "evaluation";
      readonly record: EvaluationRecord;
      readonly expected?: EvaluationRecord;
    }
  | { readonly kind: "audit"; readonly record: AuditEvent };

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

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function domainWorkspace(value: PersistedWorkspace): WorkspaceRecord {
  const { persistenceGeneration: _, ...workspace } = value;
  return workspace;
}

function persistedRevision(revision: SkillRevision): PersistedRevision {
  return {
    ...revision,
    key: `${revision.workspaceId}:${revision.revision}`,
    blobHashes: [
      revision.contentHash,
      ...revision.references.map((reference) => reference.contentHash),
    ],
  };
}

function domainRevision(value: PersistedRevision): SkillRevision {
  const { key: _, blobHashes: __, ...revision } = value;
  return revision;
}

async function workspaceSnapshotInTransaction(
  transaction: any,
  persisted: PersistedWorkspace,
): Promise<WorkspaceSnapshot> {
  const workspaceId = persisted.id;
  const revisions = (await transaction
    .objectStore("revisions")
    .index("workspaceId")
    .getAll(workspaceId)) as PersistedRevision[];
  const [artifacts, evaluations, auditEvents] = (await Promise.all(
    ["artifacts", "evaluations", "auditEvents"].map((store) =>
      transaction.objectStore(store).index("workspaceId").getAll(workspaceId),
    ),
  )) as [ArtifactRecord[], EvaluationRecord[], AuditEvent[]];
  const hashes = [
    ...new Set(revisions.flatMap((revision) => revision.blobHashes)),
  ];
  const blobs = (
    await Promise.all(
      hashes.map((hash) => transaction.objectStore("blobs").get(hash)),
    )
  ).filter((blob): blob is BlobRecord => blob !== undefined);
  return {
    snapshotVersion: 1,
    exportedAt: new Date().toISOString(),
    workspace: domainWorkspace(persisted),
    revisions: revisions.map(domainRevision),
    blobs,
    artifacts,
    evaluations,
    auditEvents,
  };
}

function installIndexes(transaction: any): void {
  const revisions = transaction.objectStore("revisions");
  if (!revisions.indexNames.contains("workspaceId"))
    revisions.createIndex("workspaceId", "workspaceId");
  if (!revisions.indexNames.contains("blobHashes"))
    revisions.createIndex("blobHashes", "blobHashes", { multiEntry: true });
  for (const name of ["artifacts", "evaluations", "auditEvents"] as const) {
    const store = transaction.objectStore(name);
    if (!store.indexNames.contains("workspaceId"))
      store.createIndex("workspaceId", "workspaceId");
  }
}

async function migrateRevisionHashes(store: any): Promise<void> {
  let cursor = await store.openCursor();
  while (cursor) {
    const value = cursor.value as PersistedRevision;
    if (!Array.isArray(value.blobHashes))
      await cursor.update(persistedRevision(value));
    cursor = await cursor.continue();
  }
}

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
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          database.createObjectStore("workspaces", { keyPath: "id" });
          database.createObjectStore("revisions", { keyPath: "key" });
          database.createObjectStore("blobs", { keyPath: "hash" });
          database.createObjectStore("artifacts", { keyPath: "id" });
          database.createObjectStore("evaluations", { keyPath: "id" });
          database.createObjectStore("auditEvents", { keyPath: "id" });
        }
        if (oldVersion < 2) {
          installIndexes(transaction);
          void migrateRevisionHashes(
            transaction.objectStore("revisions"),
          ).catch(() => transaction.abort());
        }
      },
    });
    return this.database;
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readonly");
    const [workspaces, revisions, blobs, artifacts, evaluations, auditEvents] =
      await Promise.all(
        STORES.map((store) => transaction.objectStore(store).getAll()),
      );
    await transaction.done;
    for (const persisted of workspaces as PersistedWorkspace[]) {
      const workspace = domainWorkspace(persisted);
      const workspaceRevisions = (revisions as PersistedRevision[]).filter(
        (item) => item.workspaceId === workspace.id,
      );
      const snapshot: WorkspaceSnapshot = {
        snapshotVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace,
        revisions: workspaceRevisions.map(domainRevision),
        blobs: (blobs as BlobRecord[]).filter((blob) =>
          workspaceRevisions.some((revision) =>
            revision.blobHashes.includes(blob.hash),
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
      this.memory.loadValidatedSnapshot(snapshot, {
        generation: persisted.persistenceGeneration ?? 0,
      });
    }
    this.hydrated = true;
  }

  private async refreshWorkspace(workspaceId: string): Promise<boolean> {
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readonly");
    const persisted = (await transaction
      .objectStore("workspaces")
      .get(workspaceId)) as PersistedWorkspace | undefined;
    if (!persisted) {
      await transaction.done;
      return false;
    }
    const revisions = (await transaction
      .objectStore("revisions")
      .index("workspaceId")
      .getAll(workspaceId)) as PersistedRevision[];
    const [artifacts, evaluations, auditEvents] = (await Promise.all(
      ["artifacts", "evaluations", "auditEvents"].map((store) =>
        transaction.objectStore(store).index("workspaceId").getAll(workspaceId),
      ),
    )) as [ArtifactRecord[], EvaluationRecord[], AuditEvent[]];
    const hashes = [
      ...new Set(revisions.flatMap((revision) => revision.blobHashes)),
    ];
    const blobs = (
      await Promise.all(
        hashes.map((hash) => transaction.objectStore("blobs").get(hash)),
      )
    ).filter((blob): blob is BlobRecord => blob !== undefined);
    await transaction.done;
    this.memory.loadValidatedSnapshot(
      {
        snapshotVersion: 1,
        exportedAt: new Date().toISOString(),
        workspace: domainWorkspace(persisted),
        revisions: revisions.map(domainRevision),
        blobs,
        artifacts,
        evaluations,
        auditEvents,
      },
      {
        replaceExisting: true,
        generation: persisted.persistenceGeneration ?? 0,
      },
    );
    return true;
  }

  private async recordCollision(
    store: any,
    records: readonly { id: string; workspaceId: string }[],
    workspaceId: string,
    label: string,
  ): Promise<DomainError | null> {
    for (const record of records) {
      const persisted = await store.get(record.id);
      if (persisted && persisted.workspaceId !== workspaceId)
        return persistenceError(
          "invalid_snapshot",
          `Snapshot ${label} id ${record.id} collides with existing data.`,
        );
    }
    return null;
  }

  private async persist(
    memory: MemoryWorkspaceStore,
    workspaceId: string,
    previous: WorkspaceSnapshot | undefined,
    condition: PersistCondition,
  ): Promise<DomainError | null> {
    const snapshot = await memory.exportSnapshot(workspaceId);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const db = await this.db();
    const transaction = db.transaction([...STORES], "readwrite");
    const workspaceStore = transaction.objectStore("workspaces");
    const persistedWorkspace = (await workspaceStore.get(workspaceId)) as
      PersistedWorkspace | undefined;
    const workspace = persistedWorkspace
      ? domainWorkspace(persistedWorkspace)
      : undefined;
    const generation = persistedWorkspace?.persistenceGeneration ?? 0;
    let artifactDeleteIds =
      condition.kind === "artifacts" ? [...condition.deleteIds] : [];

    let conflict: DomainError | null = null;
    if (condition.kind === "create" && persistedWorkspace)
      conflict = persistenceError(
        "invalid_snapshot",
        "A workspace with this id already exists.",
      );
    if (condition.kind === "append") {
      const persistedBase = (await transaction
        .objectStore("revisions")
        .get(`${workspaceId}:${condition.base.revision}`)) as
        PersistedRevision | undefined;
      if (
        workspace?.currentRevision !== condition.base.revision ||
        !sameWorkspace(workspace, condition.workspace) ||
        !persistedBase ||
        !sameRecord(domainRevision(persistedBase), condition.base)
      )
        conflict = persistenceError(
          "revision_conflict",
          "The workspace changed after this edit began.",
          {
            expectedBaseRevision: workspace?.currentRevision,
            receivedBaseRevision: condition.base.revision,
          },
        );
    }
    if (
      condition.kind === "replace" &&
      (!sameWorkspace(workspace, condition.target.workspace) ||
        generation !== condition.target.generation)
    )
      conflict = persistenceError(
        "revision_conflict",
        "The saved workspace changed after replacement was confirmed.",
      );
    if (
      condition.kind === "artifacts" ||
      condition.kind === "evaluation" ||
      condition.kind === "audit"
    ) {
      if (!persistedWorkspace)
        conflict = persistenceError(
          "workspace_not_found",
          "Workspace was not found.",
        );
      if (
        condition.kind === "artifacts" &&
        generation !== condition.expectedGeneration
      )
        conflict = persistenceError(
          "revision_conflict",
          "Workspace evidence changed before it was saved.",
        );
      const storeName =
        condition.kind === "artifacts"
          ? "artifacts"
          : condition.kind === "evaluation"
            ? "evaluations"
            : "auditEvents";
      const records =
        condition.kind === "artifacts" ? condition.records : [condition.record];
      if (
        condition.kind === "artifacts" &&
        records.some(
          (record) =>
            record.workspaceId !== workspaceId ||
            record.revision !== condition.revision,
        )
      )
        conflict = persistenceError(
          "invalid_snapshot",
          "Artifact evidence ownership changed.",
        );
      const existingRecords = await Promise.all(
        records.map((record) =>
          transaction.objectStore(storeName).get(record.id),
        ),
      );
      if (
        condition.kind === "artifacts" &&
        records.some((record) => record.kind === "compare")
      ) {
        const persistedArtifacts = (await transaction
          .objectStore("artifacts")
          .index("workspaceId")
          .getAll(workspaceId)) as ArtifactRecord[];
        artifactDeleteIds = [
          ...new Set([
            ...artifactDeleteIds,
            ...persistedArtifacts
              .filter((artifact) => artifact.kind === "compare")
              .map((artifact) => artifact.id),
          ]),
        ];
      }
      if (
        existingRecords.some(
          (existing) => existing && existing.workspaceId !== workspaceId,
        )
      )
        conflict = persistenceError(
          "invalid_snapshot",
          `${condition.kind} id collides with existing data.`,
        );
      if (condition.kind === "artifacts" || condition.kind === "evaluation") {
        const revision =
          condition.kind === "artifacts"
            ? condition.revision
            : condition.record.revision;
        const expectedContentHash =
          condition.kind === "artifacts"
            ? condition.expectedContentHash
            : condition.record.contentHash;
        const persistedRevision = (await transaction
          .objectStore("revisions")
          .get(`${workspaceId}:${revision}`)) as PersistedRevision | undefined;
        if (persistedRevision?.contentHash !== expectedContentHash)
          conflict = persistenceError(
            "revision_conflict",
            "Evidence revision changed before it was saved.",
          );
      }
      if (
        condition.kind === "evaluation" &&
        ((condition.expected === undefined &&
          existingRecords[0] !== undefined) ||
          (condition.expected !== undefined &&
            !sameRecord(existingRecords[0], condition.expected)))
      )
        conflict = persistenceError(
          "revision_conflict",
          "Evaluation evidence changed in another browser tab.",
        );
      if (!conflict && condition.kind === "evaluation" && persistedWorkspace) {
        const current = await workspaceSnapshotInTransaction(
          transaction,
          persistedWorkspace,
        );
        const sizeIssue = portableSnapshotSizeError({
          ...current,
          evaluations: [
            ...current.evaluations.filter(
              (evaluation) => evaluation.id !== condition.record.id,
            ),
            condition.record,
          ],
        });
        if (sizeIssue) conflict = sizeIssue;
      }
      if (!conflict) {
        if (condition.kind === "artifacts") {
          const deleted = await Promise.all(
            artifactDeleteIds.map((id) =>
              transaction.objectStore("artifacts").get(id),
            ),
          );
          if (
            deleted.some(
              (existing) => existing && existing.workspaceId !== workspaceId,
            )
          ) {
            await transaction.done;
            return persistenceError(
              "invalid_snapshot",
              "Artifact evidence ownership changed.",
            );
          }
        }
        await Promise.all([
          ...records.map((record) =>
            transaction.objectStore(storeName).put(record),
          ),
          ...(condition.kind === "artifacts"
            ? artifactDeleteIds.map((id) =>
                transaction.objectStore("artifacts").delete(id),
              )
            : []),
          workspaceStore.put({
            ...persistedWorkspace!,
            persistenceGeneration: generation + 1,
          }),
          transaction.done,
        ]);
        return null;
      }
    }

    for (const [storeName, records, label] of [
      ["artifacts", snapshot.artifacts, "artifact"],
      ["evaluations", snapshot.evaluations, "evaluation"],
      ["auditEvents", snapshot.auditEvents, "audit event"],
    ] as const) {
      conflict ??= await this.recordCollision(
        transaction.objectStore(storeName),
        records,
        workspaceId,
        label,
      );
    }
    if (conflict) {
      await transaction.done;
      return conflict;
    }

    if (condition.kind === "append") {
      const revision = snapshot.revisions.find(
        (item) => item.revision === condition.base.revision + 1,
      )!;
      const previousAuditIds = new Set(
        previous?.auditEvents.map((event) => event.id),
      );
      const newAuditEvents = snapshot.auditEvents.filter(
        (event) => !previousAuditIds.has(event.id),
      );
      await Promise.all([
        workspaceStore.put({
          ...snapshot.workspace,
          persistenceGeneration: generation + 1,
        }),
        transaction.objectStore("revisions").put(persistedRevision(revision)),
        ...snapshot.blobs.map((blob) =>
          transaction.objectStore("blobs").put(blob),
        ),
        ...newAuditEvents.map((event) =>
          transaction.objectStore("auditEvents").put(event),
        ),
        transaction.done,
      ]);
      return null;
    }

    if (condition.kind === "replace") {
      const revisions = (await transaction
        .objectStore("revisions")
        .index("workspaceId")
        .getAll(workspaceId)) as PersistedRevision[];
      const artifacts = (await transaction
        .objectStore("artifacts")
        .index("workspaceId")
        .getAll(workspaceId)) as ArtifactRecord[];
      const evaluations = (await transaction
        .objectStore("evaluations")
        .index("workspaceId")
        .getAll(workspaceId)) as EvaluationRecord[];
      const auditEvents = (await transaction
        .objectStore("auditEvents")
        .index("workspaceId")
        .getAll(workspaceId)) as AuditEvent[];
      const currentHashes = new Set(snapshot.blobs.map((blob) => blob.hash));
      const hashCounts = new Map<string, number>();
      for (const revision of revisions)
        for (const hash of new Set(revision.blobHashes))
          hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1);
      const staleHashes: string[] = [];
      for (const [hash, targetCount] of hashCounts)
        if (
          !currentHashes.has(hash) &&
          (await transaction
            .objectStore("revisions")
            .index("blobHashes")
            .count(hash)) === targetCount
        )
          staleHashes.push(hash);
      await Promise.all([
        ...revisions.map((revision) =>
          transaction.objectStore("revisions").delete(revision.key),
        ),
        ...artifacts.map((record) =>
          transaction.objectStore("artifacts").delete(record.id),
        ),
        ...evaluations.map((record) =>
          transaction.objectStore("evaluations").delete(record.id),
        ),
        ...auditEvents.map((record) =>
          transaction.objectStore("auditEvents").delete(record.id),
        ),
        ...staleHashes.map((hash) =>
          transaction.objectStore("blobs").delete(hash),
        ),
        workspaceStore.put({
          ...snapshot.workspace,
          persistenceGeneration: generation + 1,
        }),
        ...snapshot.revisions.map((revision) =>
          transaction.objectStore("revisions").put(persistedRevision(revision)),
        ),
        ...snapshot.blobs.map((blob) =>
          transaction.objectStore("blobs").put(blob),
        ),
        ...snapshot.artifacts.map((record) =>
          transaction.objectStore("artifacts").put(record),
        ),
        ...snapshot.evaluations.map((record) =>
          transaction.objectStore("evaluations").put(record),
        ),
        ...snapshot.auditEvents.map((record) =>
          transaction.objectStore("auditEvents").put(record),
        ),
        transaction.done,
      ]);
      return null;
    }

    await Promise.all([
      workspaceStore.put({ ...snapshot.workspace, persistenceGeneration: 1 }),
      ...snapshot.revisions.map((revision) =>
        transaction.objectStore("revisions").put(persistedRevision(revision)),
      ),
      ...snapshot.blobs.map((blob) =>
        transaction.objectStore("blobs").put(blob),
      ),
      ...snapshot.artifacts.map((record) =>
        transaction.objectStore("artifacts").put(record),
      ),
      ...snapshot.evaluations.map((record) =>
        transaction.objectStore("evaluations").put(record),
      ),
      ...snapshot.auditEvents.map((record) =>
        transaction.objectStore("auditEvents").put(record),
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
      await this.hydrate();
      const previous = targetWorkspaceId
        ? await this.memory.exportSnapshot(targetWorkspaceId)
        : undefined;
      const prior = previous && !("code" in previous) ? previous : undefined;
      const staged = new MemoryWorkspaceStore();
      if (prior) {
        const priorBundle = await this.memory.openWorkspace(targetWorkspaceId!);
        staged.loadValidatedSnapshot(prior, {
          generation:
            "code" in priorBundle ? undefined : priorBundle.evidenceGeneration,
        });
      }
      const result = await operation(staged);
      const id = workspaceId(result);
      if (id === undefined) return result;
      const plan = condition?.(prior) ?? { kind: "create" };
      const conflict = await this.persist(staged, id, prior, plan);
      if (conflict) {
        await this.refreshWorkspace(id);
        if (onConflict) return onConflict(conflict);
        throw new DomainMutationError(conflict);
      }
      if (plan.kind === "create" || plan.kind === "replace") {
        const committed = await staged.exportSnapshot(id);
        if ("code" in committed) throw new Error(committed.message);
        this.memory.loadValidatedSnapshot(committed, {
          replaceExisting: true,
          generation: plan.kind === "create" ? 1 : plan.target.generation + 1,
        });
      } else {
        await this.refreshWorkspace(id);
      }
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
      (previous) => ({
        kind: "append",
        workspace: previous!.workspace,
        base: previous!.revisions.find(
          (revision) => revision.revision === input.baseRevision,
        )!,
      }),
      (error) => error,
    );
  }

  async putArtifact(
    artifact: ArtifactRecord,
    expectedContentHash: string,
    expectedGeneration: number,
  ) {
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
  }) {
    await this.hydrate();
    await this.commitMutation(
      (staged) => staged.updateArtifacts(input),
      () => input.workspaceId,
      input.workspaceId,
      () => ({
        kind: "artifacts",
        records: input.artifacts,
        deleteIds: input.deleteIds ?? [],
        revision: input.revision,
        expectedContentHash: input.expectedContentHash,
        expectedGeneration: input.expectedGeneration,
      }),
    );
  }

  async recordEvaluationEvidence(
    evaluation: EvaluationRecord,
    expected?: EvaluationRecord,
  ) {
    await this.hydrate();
    await this.commitMutation(
      (staged) => staged.recordEvaluationEvidence(evaluation, expected),
      () => evaluation.workspaceId,
      evaluation.workspaceId,
      () => ({
        kind: "evaluation",
        record: evaluation,
        expected,
      }),
    );
  }

  async appendAuditEvent(event: AuditEvent) {
    await this.hydrate();
    await this.commitMutation(
      (staged) => staged.appendAuditEvent(event),
      () => event.workspaceId,
      event.workspaceId,
      () => ({ kind: "audit", record: event }),
    );
  }

  async exportSnapshot(
    workspaceId: string,
  ): Promise<WorkspaceSnapshot | DomainError> {
    await this.hydrate();
    return this.memory.exportSnapshot(workspaceId);
  }

  async getReplacementTarget(
    workspaceId: string,
  ): Promise<WorkspaceReplacementTarget | DomainError> {
    const db = await this.db();
    const persisted = (await db.get("workspaces", workspaceId)) as
      PersistedWorkspace | undefined;
    if (!persisted)
      return persistenceError(
        "workspace_not_found",
        "Workspace was not found.",
      );
    return {
      workspace: domainWorkspace(persisted),
      generation: persisted.persistenceGeneration ?? 0,
    };
  }

  async importSnapshot(
    snapshot: WorkspaceSnapshot,
    options: {
      replaceExisting?: boolean;
      replacementTarget?: WorkspaceReplacementTarget;
    } = {},
  ) {
    await this.hydrate();
    return this.commitMutation(
      async (staged) => {
        const localTarget = await this.memory.getReplacementTarget(
          snapshot.workspace.id,
        );
        const validation = await this.memory.validateSnapshot(snapshot, {
          replaceExisting: options.replaceExisting,
          replacementTarget: "code" in localTarget ? undefined : localTarget,
        });
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
