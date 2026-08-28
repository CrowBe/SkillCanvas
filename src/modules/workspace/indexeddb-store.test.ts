import { describe, expect, it, vi } from "vitest";
import type { IDBPDatabase } from "idb";
import { EMPTY_SKILL } from "../skill";
import { IndexedDbWorkspaceStore } from "./indexeddb-store";

function databaseControl() {
  let failWrites = false;
  const database = {
    getAll: async () => [],
    transaction: () => ({
      objectStore: () => ({
        put: async () => {
          if (failWrites) throw new Error("persistence failed");
        },
        delete: async () => {
          if (failWrites) throw new Error("persistence failed");
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
    const restored = await store.importSnapshot(snapshot);
    if ("code" in restored) throw new Error(restored.message);
    expect(restored.revision.revision).toBe(1);
    expect("code" in (await store.openWorkspace(created.workspace.id, 2))).toBe(
      true,
    );
  });
});
