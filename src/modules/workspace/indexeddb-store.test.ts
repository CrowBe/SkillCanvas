import { describe, expect, it, vi } from "vitest";
import type { IDBPDatabase } from "idb";
import { EMPTY_SKILL } from "../skill";
import { byteLength, sha256 } from "../shared";
import { IndexedDbWorkspaceStore } from "./indexeddb-store";
import { MemoryWorkspaceStore } from "./memory-store";
import { createWorkspaceService } from "./service";

function databaseControl() {
  let failWrites = false;
  const deletedBlobs: string[] = [];
  const databaseGetAlls: string[] = [];
  const transactionGetAlls: string[] = [];
  const records = new Map(
    [
      ["workspaces", "id"],
      ["revisions", "key"],
      ["blobs", "hash"],
      ["artifacts", "id"],
      ["evaluations", "id"],
      ["auditEvents", "id"],
    ].map(([name, key]) => [name, { key, values: new Map<string, any>() }]),
  );
  const database = {
    getAll: async (name: string) => {
      databaseGetAlls.push(name);
      return [...records.get(name)!.values.values()];
    },
    get: async (name: string, key: string) =>
      records.get(name)!.values.get(key),
    transaction: () => ({
      objectStore: (name: string) => {
        const store = records.get(name)!;
        return {
          get: async (key: string) => store.values.get(key),
          getAll: async () => {
            transactionGetAlls.push(name);
            return [...store.values.values()];
          },
          index: (indexName: string) => ({
            getAll: async (key: string) => {
              transactionGetAlls.push(`${name}.${indexName}`);
              return [...store.values.values()].filter(
                (value) => value[indexName] === key,
              );
            },
            count: async (key: string) =>
              [...store.values.values()].filter((value) =>
                Array.isArray(value[indexName])
                  ? value[indexName].includes(key)
                  : value[indexName] === key,
              ).length,
          }),
          put: async (value: any) => {
            if (failWrites) throw new Error("persistence failed");
            store.values.set(value[store.key], structuredClone(value));
          },
          delete: async (key: string) => {
            if (failWrites) throw new Error("persistence failed");
            store.values.delete(key);
            if (name === "blobs") deletedBlobs.push(key);
          },
        };
      },
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
    transactionGetAlls,
    databaseGetAlls,
    clearReadLog() {
      transactionGetAlls.length = 0;
      databaseGetAlls.length = 0;
    },
    referenceBlobFromOtherWorkspace(hash: string) {
      records.get("revisions")!.values.set("other:1", {
        key: "other:1",
        workspaceId: "other",
        revision: 1,
        contentHash: hash,
        references: [],
        blobHashes: [hash],
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
      replacementTarget: await replacementTarget(store, updated.workspace.id),
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
      store.importSnapshot(snapshot, {
        replaceExisting: true,
        replacementTarget: await replacementTarget(store, updated.workspace.id),
      }),
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
      replacementTarget: await replacementTarget(store, updated.workspace.id),
    });
    if ("code" in restored) throw new Error(restored.message);
    expect(control.deletedBlobs).not.toContain(updated.revision.contentHash);
  });

  it("rejects a stale tab revision against the persisted revision", async () => {
    const control = databaseControl();
    const first = new IndexedDbWorkspaceStore(control.database);
    const created = await first.createWorkspace({
      name: "shared",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const stale = new IndexedDbWorkspaceStore(control.database);
    await stale.openWorkspace(created.workspace.id);
    await first.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nFirst tab edit.`,
      actor: "human",
    });
    const rejected = await stale.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nStale tab edit.`,
      actor: "human",
    });
    expect("code" in rejected && rejected.code).toBe("revision_conflict");
    const current = await stale.openWorkspace(created.workspace.id);
    expect("code" in current ? undefined : current.skillMd).toContain(
      "First tab edit.",
    );
  });

  it("rejects replacement when the confirmed persisted target changed", async () => {
    const control = databaseControl();
    const first = new IndexedDbWorkspaceStore(control.database);
    const created = await first.createWorkspace({
      name: "shared",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await first.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const stale = new IndexedDbWorkspaceStore(control.database);
    await stale.openWorkspace(created.workspace.id);
    const confirmed = await replacementTarget(stale, created.workspace.id);
    await first.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nNew persisted revision.`,
      actor: "human",
    });
    const rejected = await stale.importSnapshot(snapshot, {
      replaceExisting: true,
      replacementTarget: confirmed,
    });
    expect("code" in rejected && rejected.code).toBe("revision_conflict");
    const current = await stale.openWorkspace(created.workspace.id);
    expect("code" in current ? undefined : current.revision.revision).toBe(2);
  });

  it("preserves concurrent evidence records from separate tabs", async () => {
    const control = databaseControl();
    const first = new IndexedDbWorkspaceStore(control.database);
    const created = await first.createWorkspace({
      name: "evidence",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const second = new IndexedDbWorkspaceStore(control.database);
    await second.openWorkspace(created.workspace.id);
    await first.putArtifact(
      {
        id: "artifact-first",
        workspaceId: created.workspace.id,
        revision: 1,
        kind: "lint",
        version: "1",
        createdAt: new Date().toISOString(),
        data: {},
      },
      created.revision.contentHash,
    );
    await second.putArtifact(
      {
        id: "artifact-second",
        workspaceId: created.workspace.id,
        revision: 1,
        kind: "structure",
        version: "1",
        createdAt: new Date().toISOString(),
        data: {},
      },
      created.revision.contentHash,
    );
    const reader = new IndexedDbWorkspaceStore(control.database);
    const current = await reader.openWorkspace(created.workspace.id);
    expect(
      "code" in current
        ? []
        : current.artifacts.map((artifact) => artifact.id).sort(),
    ).toEqual(["artifact-first", "artifact-second"]);
  });

  it("rejects replacement after persisted evidence changes", async () => {
    const control = databaseControl();
    const first = new IndexedDbWorkspaceStore(control.database);
    const created = await first.createWorkspace({
      name: "evidence",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await first.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const confirmed = await replacementTarget(first, created.workspace.id);
    const second = new IndexedDbWorkspaceStore(control.database);
    await second.putArtifact(
      {
        id: "new-evidence",
        workspaceId: created.workspace.id,
        revision: 1,
        kind: "lint",
        version: "1",
        createdAt: new Date().toISOString(),
        data: {},
      },
      created.revision.contentHash,
    );
    const rejected = await first.importSnapshot(snapshot, {
      replaceExisting: true,
      replacementTarget: confirmed,
    });
    expect("code" in rejected && rejected.code).toBe("revision_conflict");
    const reader = new IndexedDbWorkspaceStore(control.database);
    const current = await reader.openWorkspace(created.workspace.id);
    expect(
      "code" in current ? [] : current.artifacts.map((artifact) => artifact.id),
    ).toContain("new-evidence");
  });

  it("does not scan blob contents for ordinary mutations", async () => {
    const control = databaseControl();
    const store = new IndexedDbWorkspaceStore(control.database);
    const created = await store.createWorkspace({
      name: "scaled",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    control.clearReadLog();
    await store.putArtifact(
      {
        id: "targeted-artifact",
        workspaceId: created.workspace.id,
        revision: 1,
        kind: "lint",
        version: "1",
        createdAt: new Date().toISOString(),
        data: {},
      },
      created.revision.contentHash,
    );
    expect(control.transactionGetAlls).not.toContain("blobs");
    expect(control.databaseGetAlls).toEqual([]);
    control.clearReadLog();
    await store.putArtifact(
      {
        id: "second-targeted-artifact",
        workspaceId: created.workspace.id,
        revision: 1,
        kind: "structure",
        version: "1",
        createdAt: new Date().toISOString(),
        data: {},
      },
      created.revision.contentHash,
    );
    expect(control.databaseGetAlls).toEqual([]);
    expect(control.transactionGetAlls).not.toContain("blobs");
  });

  it("rejects stale updates to the same evaluation record", async () => {
    const control = databaseControl();
    const firstStore = new IndexedDbWorkspaceStore(control.database);
    const first = createWorkspaceService(firstStore);
    const created = await first.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await first.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const second = createWorkspaceService(
      new IndexedDbWorkspaceStore(control.database),
    );
    const stale = await second.open(created.value.workspace.id);
    if (!stale.ok) throw new Error(stale.error.message);
    const firstCase = (prepared.value.data as any).cases[0];
    const accepted = await first.submitEvaluation(
      created.value.workspace.id,
      prepared.value.id,
      {
        caseId: firstCase.id,
        selectedChoiceId: firstCase.choices[0].id,
        rationale: "First tab evidence",
      },
    );
    if (!accepted.ok) throw new Error(accepted.error.message);
    await expect(
      second.submitEvaluation(created.value.workspace.id, prepared.value.id, {
        caseId: firstCase.id,
        selectedChoiceId: firstCase.choices[1].id,
        rationale: "Stale tab evidence",
      }),
    ).rejects.toThrow("Evaluation evidence changed");
    const reader = createWorkspaceService(
      new IndexedDbWorkspaceStore(control.database),
    );
    const current = await reader.open(created.value.workspace.id);
    if (!current.ok) throw new Error(current.error.message);
    const evaluation = current.value.evaluations.find(
      (record) => record.id === prepared.value.id,
    )!;
    expect((evaluation.data as any).observations[0].rationale).toBe(
      "First tab evidence",
    );
  });

  it("rejects concurrent evaluation updates through one store", async () => {
    const control = databaseControl();
    const service = createWorkspaceService(
      new IndexedDbWorkspaceStore(control.database),
    );
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await service.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const testCase = (prepared.value.data as any).cases[0];
    const submissions = await Promise.allSettled([
      service.submitEvaluation(created.value.workspace.id, prepared.value.id, {
        caseId: testCase.id,
        selectedChoiceId: testCase.choices[0].id,
        rationale: "First concurrent submission",
      }),
      service.submitEvaluation(created.value.workspace.id, prepared.value.id, {
        caseId: testCase.id,
        selectedChoiceId: testCase.choices[1].id,
        rationale: "Second concurrent submission",
      }),
    ]);
    expect(
      submissions.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      submissions.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const current = await service.open(created.value.workspace.id);
    if (!current.ok) throw new Error(current.error.message);
    const evaluation = current.value.evaluations.find(
      (record) => record.id === prepared.value.id,
    )!;
    expect((evaluation.data as any).observations).toHaveLength(1);
  });

  it("rejects stale artifacts after snapshot replacement", async () => {
    const control = databaseControl();
    const stale = new IndexedDbWorkspaceStore(control.database);
    const created = await stale.createWorkspace({
      name: "replaceable",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await stale.exportSnapshot(created.workspace.id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const replacementContent = `${EMPTY_SKILL}\nReplacement content.`;
    const replacementHash = await sha256(replacementContent);
    (snapshot.blobs as any[])[0] = {
      hash: replacementHash,
      content: replacementContent,
      bytes: byteLength(replacementContent),
    };
    (snapshot.revisions[0] as { contentHash: string }).contentHash =
      replacementHash;
    const replacing = new IndexedDbWorkspaceStore(control.database);
    const replaced = await replacing.importSnapshot(snapshot, {
      replaceExisting: true,
      replacementTarget: await replacementTarget(
        replacing,
        created.workspace.id,
      ),
    });
    if ("code" in replaced) throw new Error(replaced.message);
    await expect(
      stale.putArtifact(
        {
          id: "stale-lint",
          workspaceId: created.workspace.id,
          revision: 1,
          kind: "lint",
          version: "1",
          createdAt: new Date().toISOString(),
          data: {},
        },
        created.revision.contentHash,
      ),
    ).rejects.toThrow("Evidence revision changed");
    const reader = new IndexedDbWorkspaceStore(control.database);
    const current = await reader.openWorkspace(created.workspace.id);
    expect("code" in current ? [] : current.artifacts).toEqual([]);
  });
});

async function replacementTarget(
  store: IndexedDbWorkspaceStore,
  workspaceId: string,
) {
  const target = await store.getReplacementTarget(workspaceId);
  if ("code" in target) throw new Error(target.message);
  return target;
}
