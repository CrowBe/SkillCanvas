import { describe, expect, it } from "vitest";
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
});
