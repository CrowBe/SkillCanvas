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

describe("WorkspaceService input validation", () => {
  it("returns a typed error for a malformed instruction map instead of throwing", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const missingArrays = await service.submitInstructionMap(
      id,
      {
        revision: 1,
        status: "proposed",
        suppliedBy: "visiting-agent proposal",
      },
      true,
    );
    expect(missingArrays.ok).toBe(false);
    if (!missingArrays.ok)
      expect(missingArrays.error.code).toBe("invalid_instruction_map");
    const badRequirement = await service.submitInstructionMap(
      id,
      {
        revision: 1,
        status: "proposed",
        suppliedBy: "visiting-agent proposal",
        scopes: [{ id: "root", label: "Root" }],
        requirements: [{ id: "r", statement: "one" }],
      },
      true,
    );
    expect(badRequirement.ok).toBe(false);
    expect((await service.submitInstructionMap(id, "not-a-map", true)).ok).toBe(
      false,
    );
  });

  it("returns a typed error for a malformed Tool contract instead of throwing", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const result = await service.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      { contract: { name: "x" } as never },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_submission");
  });
});

describe("WorkspaceService schema and submission guards", () => {
  it("rejects a contract whose nested schema is malformed instead of throwing", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const result = await service.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: { a: null } },
        } as never,
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_submission");
    const stringProperties = await service.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "t",
          description: "t",
          inputSchema: { type: "object" },
          outputSchema: { type: "object", properties: "abc" },
        } as never,
      },
    );
    expect(stringProperties.ok).toBe(false);
  });

  it("returns a typed error for a triggering submission without a rationale", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const prepared = await service.prepareEvaluation(id, "triggering");
    if (!prepared.ok) throw new Error(prepared.error.message);
    const caseId = (prepared.value.data as any).cases[0].id;
    const result = await service.submitEvaluation(id, prepared.value.id, {
      caseId,
      selectedChoiceId: "candidate",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_submission");
  });
});

describe("snapshot import schema guards", () => {
  it("rejects an imported test-run evaluation whose contract schema is malformed", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const prepared = await service.prepareEvaluation(id, "test-run", {
      contract: {
        name: "read_items",
        description: "Read items",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        mockOutput: {},
      },
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const exported = await service.exportSnapshot(id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    const testRun = snapshot.evaluations.find(
      (item: any) => item.kind === "test-run",
    );
    testRun.data.contract.inputSchema = null;
    const importer = createWorkspaceService(new MemoryWorkspaceStore());
    const imported = await importer.importSnapshot(JSON.stringify(snapshot));
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
  });
});

describe("snapshot import evaluation data guards", () => {
  async function snapshotWith(
    mutate: (snapshot: any) => void,
  ): Promise<string> {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const triggering = await service.prepareEvaluation(id, "triggering");
    if (!triggering.ok) throw new Error(triggering.error.message);
    const testRun = await service.prepareEvaluation(id, "test-run", {
      contract: {
        name: "read_items",
        description: "Read items",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        mockOutput: {},
      },
    });
    if (!testRun.ok) throw new Error(testRun.error.message);
    const exported = await service.exportSnapshot(id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    mutate(snapshot);
    return JSON.stringify(snapshot);
  }

  it("imports a well-formed snapshot and still grades a triggering submission", async () => {
    const json = await snapshotWith(() => {});
    const importer = createWorkspaceService(new MemoryWorkspaceStore());
    const imported = await importer.importSnapshot(json);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    const record = imported.value.evaluations.find(
      (item) => item.kind === "triggering",
    )!;
    const caseId = (record.data as any).cases[0].id;
    const graded = await importer.submitEvaluation(
      imported.value.workspace.id,
      record.id,
      {
        caseId,
        selectedChoiceId: "candidate",
        rationale: "Description matches.",
      },
    );
    expect(graded.ok).toBe(true);
  });

  it("rejects a test-run evaluation whose transcript is missing", async () => {
    const json = await snapshotWith((snapshot) => {
      const testRun = snapshot.evaluations.find(
        (item: any) => item.kind === "test-run",
      );
      delete testRun.data.transcript;
    });
    const importer = createWorkspaceService(new MemoryWorkspaceStore());
    const imported = await importer.importSnapshot(json);
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
  });

  it("rejects a triggering evaluation whose observations are missing", async () => {
    const json = await snapshotWith((snapshot) => {
      const triggering = snapshot.evaluations.find(
        (item: any) => item.kind === "triggering",
      );
      delete triggering.data.observations;
    });
    const importer = createWorkspaceService(new MemoryWorkspaceStore());
    const imported = await importer.importSnapshot(json);
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
  });
});
