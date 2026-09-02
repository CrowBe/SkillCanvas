import { describe, expect, it } from "vitest";
import { EMPTY_SKILL } from "../skill";
import { sha256 } from "../shared";
import { MemoryWorkspaceStore } from "./memory-store";
import { admitSnapshot, portableSnapshotJson } from "./snapshot-admission";
import type { WorkspaceSnapshot } from "./types";

async function exported(skillMd = EMPTY_SKILL, revisions = 1) {
  const store = new MemoryWorkspaceStore();
  const created = await store.createWorkspace({
    name: "source",
    skillMd,
    referenceFiles: [],
  });
  for (let revision = 1; revision < revisions; revision += 1)
    await store.appendRevision({
      workspaceId: created.workspace.id,
      baseRevision: revision,
      skillMd: `${skillMd}\nRevision ${revision + 1}.`,
      actor: "human",
    });
  const snapshot = await store.exportSnapshot(created.workspace.id);
  if ("code" in snapshot) throw new Error(snapshot.message);
  return structuredClone(snapshot);
}

async function admissionOf(snapshot: WorkspaceSnapshot) {
  return admitSnapshot(portableSnapshotJson(snapshot));
}

describe("snapshot admission", () => {
  it("admits a snapshot exported from a workspace", async () => {
    const result = await admissionOf(await exported());
    expect(result.ok).toBe(true);
  });

  it("rejects a current revision that is not in the lineage", async () => {
    const snapshot = await exported();
    (snapshot.workspace as { currentRevision: number }).currentRevision = 999;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.code).toBe("invalid_snapshot");
  });

  it("requires the current revision to be the lineage tip", async () => {
    const snapshot = await exported(EMPTY_SKILL, 2);
    (snapshot.workspace as { currentRevision: number }).currentRevision = 1;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.message).toContain(
      "lineage tip",
    );
  });

  it("requires the revision chain to run from one without gaps", async () => {
    const snapshot = await exported(EMPTY_SKILL, 2);
    (
      snapshot.revisions[1] as { parentRevision: number | null }
    ).parentRevision = null;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.message).toContain(
      "Revision lineage is invalid.",
    );
  });

  it("rejects a blob whose content no longer matches its digest", async () => {
    const snapshot = await exported();
    const blob = snapshot.blobs[0] as { content: string; bytes: number };
    blob.content = `${EMPTY_SKILL}\nTampered.`;
    blob.bytes = new TextEncoder().encode(blob.content).length;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.message).toContain(
      "Blob integrity check failed",
    );
  });

  it("rejects a blob whose byte count disagrees with its content", async () => {
    const snapshot = await exported();
    (snapshot.blobs[0] as { bytes: number }).bytes += 1;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.message).toContain(
      "invalid blob record",
    );
  });

  it("rejects revisions belonging to another workspace", async () => {
    const snapshot = await exported();
    const other = await exported();
    (snapshot.revisions[0] as { workspaceId: string }).workspaceId =
      other.workspace.id;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.code).toBe("invalid_snapshot");
  });

  it("rejects an audit event owned by another workspace", async () => {
    const snapshot = await exported();
    const other = await exported();
    (snapshot.auditEvents[0] as { workspaceId: string }).workspaceId =
      other.workspace.id;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.code).toBe("invalid_snapshot");
  });

  it("rejects a repeated child-record id within one snapshot", async () => {
    const snapshot = await exported(EMPTY_SKILL, 2);
    expect(snapshot.auditEvents.length).toBeGreaterThan(1);
    (snapshot.auditEvents[1] as { id: string }).id =
      snapshot.auditEvents[0]!.id;
    const result = await admissionOf(snapshot);
    expect(result.ok === false && result.error.message).toContain(
      "appears more than once",
    );
  });

  it("rejects a snapshot with no revisions", async () => {
    const snapshot = await exported();
    const emptied = {
      ...snapshot,
      revisions: [],
      artifacts: [],
      auditEvents: [],
    };
    const result = await admissionOf(emptied);
    expect(result.ok === false && result.error.message).toContain(
      "Unsupported or empty",
    );
  });

  it("rejects JSON that is not a snapshot at all", async () => {
    expect((await admitSnapshot("{")).ok).toBe(false);
    expect((await admitSnapshot("[]")).ok).toBe(false);
  });

  it("mints an admitted snapshot a store will accept", async () => {
    const snapshot = await exported();
    const result = await admissionOf(snapshot);
    if (!result.ok) throw new Error(result.error.message);
    expect(await sha256(snapshot.blobs[0]!.content)).toBe(
      snapshot.blobs[0]!.hash,
    );
    const target = new MemoryWorkspaceStore();
    const landed = await target.importSnapshot(result.value);
    expect("code" in landed ? undefined : landed.workspace.id).toBe(
      snapshot.workspace.id,
    );
  });
});
