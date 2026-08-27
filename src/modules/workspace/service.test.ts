import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { EMPTY_SKILL } from "../skill";
import { MemoryWorkspaceStore } from "./memory-store";
import { createWorkspaceService } from "./service";

describe("WorkspaceService", () => {
  it("appends immutable revisions and returns a typed stale-base conflict", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const nextRaw = created.value.skillMd.replace(
      "Describe the workflow",
      "Follow the complete workflow",
    );
    const next = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: nextRaw,
      actor: "human",
    });
    expect(next.ok && next.value.revision.parentRevision).toBe(1);
    const stale = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: nextRaw,
      actor: "webmcp",
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("revision_conflict");
    const prior = await service.open(created.value.workspace.id, 1);
    expect(prior.ok && prior.value.skillMd).toBe(created.value.skillMd);
  });

  it("deduplicates canonical blobs and exports a metadata-free Skill zip", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: [
        { path: "references/guide.md", content: "same" },
        { path: "references/other.md", content: "same" },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const snapshot = await service.exportSnapshot(created.value.workspace.id);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(JSON.parse(snapshot.value).blobs).toHaveLength(2);
    const exported = await service.exportSkill(created.value.workspace.id);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const zip = await JSZip.loadAsync(exported.value);
    expect(Object.keys(zip.files).sort()).toEqual([
      "SKILL.md",
      "references/",
      "references/guide.md",
      "references/other.md",
    ]);
    expect(
      Object.keys(zip.files).some((name) => name.includes("workbench")),
    ).toBe(false);
  });

  it("rejects traversal and duplicate normalized paths", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const traversal = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: [{ path: "../secret", content: "x" }],
    });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.error.code).toBe("invalid_path");
    const duplicate = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: [
        { path: "A.md", content: "x" },
        { path: "a.md", content: "y" },
      ],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate_path");
  });

  it("rejects malformed snapshot records before they reach an adapter", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const malformed = await service.importSnapshot(
      JSON.stringify({
        snapshotVersion: 1,
        workspace: { id: "x" },
        revisions: [],
        blobs: "not-an-array",
        artifacts: [],
        evaluations: [],
        auditEvents: [],
      }),
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("invalid_snapshot");
  });
});
