import { describe, expect, it, vi } from "vitest";
import type { IDBPDatabase } from "idb";
import { EMPTY_SKILL } from "../skill";
import { IndexedDbWorkspaceStore } from "./indexeddb-store";
import { MemoryWorkspaceStore } from "./memory-store";

function databaseControl() {
  let failWrites = false;
  const deletedBlobs: string[] = [];
  const revisions = new Map<string, any>();
  const database = {
    getAll: async () => [],
    transaction: () => ({
      objectStore: (name: string) => ({
        getAll: async () =>
          name === "revisions" ? [...revisions.values()] : [],
        put: async (value: any) => {
          if (failWrites) throw new Error("persistence failed");
          if (name === "revisions") revisions.set(value.key, value);
        },
        delete: async (key: string) => {
          if (failWrites) throw new Error("persistence failed");
          if (name === "revisions") revisions.delete(key);
          if (name === "blobs") deletedBlobs.push(key);
        },
      }),
      done: Promise.resolve(),
    }),
  } as unknown as IDBPDatabase;
  return {
    database,
    failNextWrites() {
      failWrites = true;
    },
    allowWrites() {
      failWrites = false;
    },
    deletedBlobs,
    referenceBlobFromOtherWorkspace(hash: string) {
      revisions.set("other:1", {
        key: "other:1",
        workspaceId: "other",
        revision: 1,
        contentHash: hash,
        references: [],
      });
    },
  };
}

describe("IndexedDbWorkspaceStore transactions", () => {
  it("does not expose a revision whose persistence failed", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const created = await store.createWorkspace({
      name: "test-skill",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    control.failNextWrites();
    await expect(
      store.appendRevision({
        workspaceId: created.workspace.id,
        baseRevision: 1,
        skillMd: `${EMPTY_SKILL}\nUpdated`,
        actor: "human",
      }),
    ).rejects.toThrow("persistence failed");
    const unchanged = await store.openWorkspace(created.workspace.id);
    expect("code" in unchanged ? undefined : unchanged.revision.revision).toBe(
      1,
    );
    control.allowWrites();
    const retried = await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nUpdated`,
      actor: "human",
    });
    expect("code" in retried ? undefined : retried.revision.revision).toBe(2);
  });

  it("hashes only the workspace targeted by a mutation", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const first = await store.createWorkspace({
      name: "first",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    await store.createWorkspace({
      name: "second",
      skillMd: `${EMPTY_SKILL}\nSecond workspace.`,
      referenceFiles: [],
    });
    const digest = vi.spyOn(crypto.subtle, "digest");
    await store.appendRevision({
      workspaceId: first.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nUpdated first workspace.`,
      actor: "human",
    });
    expect(digest).toHaveBeenCalledTimes(1);
    digest.mockRestore();
  });

  it("replaces an existing workspace with an earlier snapshot", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const created = await store.createWorkspace({
      name: "restorable",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await store.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const updated = await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nLater revision.`,
      actor: "human",
    });
    if ("code" in updated) throw new Error(updated.message);
    const restored = await store.importSnapshot(snapshot, {
      replaceExisting: true,
    });
    if ("code" in restored) throw new Error(restored.message);
    expect(restored.revision.revision).toBe(1);
    expect("code" in (await store.openWorkspace(created.workspace.id, 2))).toBe(
      true,
    );
    expect(control.deletedBlobs).toContain(updated.revision.contentHash);
  });

  it("keeps the prior workspace visible when replacement persistence fails", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const created = await store.createWorkspace({
      name: "durable",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await store.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const updated = await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nKeep this revision.`,
      actor: "human",
    });
    if ("code" in updated) throw new Error(updated.message);
    control.failNextWrites();
    await expect(
      store.importSnapshot(snapshot, { replaceExisting: true }),
    ).rejects.toThrow("persistence failed");
    const unchanged = await store.openWorkspace(created.workspace.id);
    expect("code" in unchanged ? undefined : unchanged.revision.revision).toBe(
      2,
    );
  });

  it("serializes snapshot admission against global record ids", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const source = new MemoryWorkspaceStore();
    const first = await source.createWorkspace({
      name: "first-import",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const second = await source.createWorkspace({
      name: "second-import",
      skillMd: `${EMPTY_SKILL}\nSecond import.`,
      referenceFiles: [],
    });
    const firstSnapshot = await source.exportSnapshot(first.workspace.id);
    const secondSnapshot = await source.exportSnapshot(second.workspace.id);
    if ("code" in firstSnapshot || "code" in secondSnapshot)
      throw new Error("snapshot export failed");
    (secondSnapshot.auditEvents[0] as { id: string }).id =
      firstSnapshot.auditEvents[0]!.id;

    const results = await Promise.all([
      store.importSnapshot(firstSnapshot),
      store.importSnapshot(secondSnapshot),
    ]);
    expect(results.filter((result) => !("code" in result))).toHaveLength(1);
    expect(
      results.filter(
        (result) => "code" in result && result.code === "invalid_snapshot",
      ),
    ).toHaveLength(1);
  });

  it("retains replaced blobs referenced by another persisted workspace", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const created = await store.createWorkspace({
      name: "shared-content",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await store.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const updated = await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nShared with another tab.`,
      actor: "human",
    });
    if ("code" in updated) throw new Error(updated.message);
    control.referenceBlobFromOtherWorkspace(updated.revision.contentHash);

    const restored = await store.importSnapshot(snapshot, {
      replaceExisting: true,
    });
    if ("code" in restored) throw new Error(restored.message);
    expect(control.deletedBlobs).not.toContain(updated.revision.contentHash);
  });
});
