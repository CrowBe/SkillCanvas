import { describe, expect, it } from "vitest";
import { EMPTY_SKILL } from "../skill";
import { MemoryWorkspaceStore } from "./memory-store";
import {
  admitSnapshot,
  portableSnapshotJson,
  type AdmittedSnapshot,
} from "./snapshot-admission";
import type { WorkspaceSnapshot } from "./types";

async function admitted(
  snapshot: WorkspaceSnapshot,
): Promise<AdmittedSnapshot> {
  const result = await admitSnapshot(portableSnapshotJson(snapshot));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function snapshotFrom(store: MemoryWorkspaceStore, workspaceId: string) {
  const snapshot = await store.exportSnapshot(workspaceId);
  if ("code" in snapshot) throw new Error(snapshot.message);
  return structuredClone(snapshot);
}

async function storeWith(name: string) {
  const store = new MemoryWorkspaceStore();
  const created = await store.createWorkspace({
    name,
    skillMd: EMPTY_SKILL,
    referenceFiles: [],
  });
  return { store, created };
}

describe("MemoryWorkspaceStore snapshot landing", () => {
  it("requires confirmed replacement when the workspace id is taken", async () => {
    const { store, created } = await storeWith("original");
    const snapshot = await snapshotFrom(store, created.workspace.id);
    const collision = await store.importSnapshot(await admitted(snapshot));
    expect("code" in collision && collision.code).toBe("invalid_snapshot");
  });

  it("rejects a replacement target that no longer matches, leaving the workspace intact", async () => {
    const { store, created } = await storeWith("original");
    const snapshot = await snapshotFrom(store, created.workspace.id);
    const confirmed = await store.getReplacementTarget(created.workspace.id);
    if ("code" in confirmed) throw new Error(confirmed.message);
    await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nChanged in another tab.`,
      actor: "human",
    });

    const stale = await store.importSnapshot(
      await admitted(snapshot),
      confirmed,
    );
    expect("code" in stale && stale.code).toBe("revision_conflict");
    const unchanged = await store.openWorkspace(created.workspace.id);
    expect("code" in unchanged ? undefined : unchanged.revision.revision).toBe(
      2,
    );
  });

  it("replaces in place once the confirmed target still matches", async () => {
    const { store, created } = await storeWith("original");
    const snapshot = await snapshotFrom(store, created.workspace.id);
    await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nLater revision.`,
      actor: "human",
    });
    const confirmed = await store.getReplacementTarget(created.workspace.id);
    if ("code" in confirmed) throw new Error(confirmed.message);

    const replaced = await store.importSnapshot(
      await admitted(snapshot),
      confirmed,
    );
    expect("code" in replaced ? undefined : replaced.revision.revision).toBe(1);
    expect("code" in (await store.openWorkspace(created.workspace.id, 2))).toBe(
      true,
    );
  });

  it("rejects child-record ids already held by another workspace", async () => {
    const { store: target, created: existing } = await storeWith("existing");
    const existingSnapshot = await snapshotFrom(target, existing.workspace.id);
    const { store: source, created: incoming } = await storeWith("incoming");
    const collision = await snapshotFrom(source, incoming.workspace.id);
    (collision.auditEvents[0] as { id: string }).id =
      existingSnapshot.auditEvents[0]!.id;

    const rejected = await target.importSnapshot(await admitted(collision));
    expect("code" in rejected && rejected.code).toBe("invalid_snapshot");
    expect(await target.listWorkspaces()).toHaveLength(1);
  });
});
