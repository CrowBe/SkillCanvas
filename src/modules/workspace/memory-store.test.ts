import { describe, expect, it } from "vitest";
import { EMPTY_SKILL } from "../skill";
import { MemoryWorkspaceStore } from "./memory-store";

describe("MemoryWorkspaceStore snapshot admission", () => {
  async function snapshotFrom(
    store: MemoryWorkspaceStore,
    workspaceId: string,
  ) {
    const snapshot = await store.exportSnapshot(workspaceId);
    if ("code" in snapshot) throw new Error(snapshot.message);
    return structuredClone(snapshot);
  }

  it("rejects a missing current revision without partially importing", async () => {
    const source = new MemoryWorkspaceStore();
    const created = await source.createWorkspace({
      name: "source",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const snapshot = await snapshotFrom(source, created.workspace.id);
    (snapshot.workspace as { currentRevision: number }).currentRevision = 999;
    const target = new MemoryWorkspaceStore();
    const imported = await target.importSnapshot(snapshot);
    expect("code" in imported && imported.code).toBe("invalid_snapshot");
    expect(await target.listWorkspaces()).toEqual([]);
  });

  it("rejects foreign ownership and existing child-record id collisions", async () => {
    const target = new MemoryWorkspaceStore();
    const existing = await target.createWorkspace({
      name: "existing",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const existingSnapshot = await snapshotFrom(target, existing.workspace.id);
    const source = new MemoryWorkspaceStore();
    const incoming = await source.createWorkspace({
      name: "incoming",
      skillMd: EMPTY_SKILL,
      referenceFiles: [],
    });
    const collision = await snapshotFrom(source, incoming.workspace.id);
    (collision.auditEvents[0] as { id: string }).id =
      existingSnapshot.auditEvents[0]!.id;
    const rejectedCollision = await target.importSnapshot(collision);
    expect("code" in rejectedCollision && rejectedCollision.code).toBe(
      "invalid_snapshot",
    );
    const foreign = await snapshotFrom(source, incoming.workspace.id);
    (foreign.auditEvents[0] as { workspaceId: string }).workspaceId =
      existing.workspace.id;
    const rejectedForeign = await target.importSnapshot(foreign);
    expect("code" in rejectedForeign && rejectedForeign.code).toBe(
      "invalid_snapshot",
    );
    expect(await target.listWorkspaces()).toHaveLength(1);
  });
});
