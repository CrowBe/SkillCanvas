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

  it("deduplicates byte-identical blobs and exports a metadata-free Skill zip", async () => {
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

  it("preserves line endings as part of blob identity", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: [
        { path: "references/lf.md", content: "one\ntwo\n" },
        { path: "references/crlf.md", content: "one\r\ntwo\r\n" },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    expect(snapshot.blobs).toHaveLength(3);
    expect(snapshot.blobs.map((blob: any) => blob.content)).toEqual(
      expect.arrayContaining(["one\ntwo\n", "one\r\ntwo\r\n"]),
    );
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
  it("returns invalid_submission for malformed Skill input shapes", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const badSkill = await service.create({ skillMd: 42 as never });
    expect(badSkill.ok).toBe(false);
    if (!badSkill.ok) expect(badSkill.error.code).toBe("invalid_submission");
    const badReferences = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: [{ path: "guide.md" } as never],
    });
    expect(badReferences.ok).toBe(false);
    if (!badReferences.ok)
      expect(badReferences.error.code).toBe("invalid_submission");
    const nullSkill = await service.create({ skillMd: null as never });
    expect(nullSkill.ok).toBe(false);
    const nullReferences = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: null as never,
    });
    expect(nullReferences.ok).toBe(false);
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const nullUpdateReferences = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: EMPTY_SKILL,
      referenceFiles: null as never,
      actor: "human",
    });
    expect(nullUpdateReferences.ok).toBe(false);
  });

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

describe("comparison source diff", () => {
  it("counts inserted lines without treating shifted lines as replacements", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const before = [
      "---",
      "name: diff-skill",
      "description: Use when a line diff is needed.",
      "---",
      "",
      "# A",
      "B",
    ].join("\n");
    const created = await service.create({ skillMd: before });
    if (!created.ok) throw new Error(created.error.message);
    const after = before.replace("# A\nB", "# X\n# A\nB");
    const updated = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: after,
      actor: "human",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const compared = await service.compare(created.value.workspace.id, 1, 2);
    expect(compared.ok).toBe(true);
    if (compared.ok)
      expect(compared.value.source).toEqual({
        additions: 1,
        deletions: 0,
        changedLines: [6],
      });
  });

  it("bounds comparison work for large unrelated line sets", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const header = [
      "---",
      "name: large-diff-skill",
      "description: Use when a bounded line diff is needed.",
      "---",
      "",
      "# Data",
    ];
    const before = [
      ...header,
      ...Array.from({ length: 3000 }, (_, index) => `before-${index}`),
    ].join("\n");
    const after = [
      ...header,
      ...Array.from({ length: 3000 }, (_, index) => `after-${index}`),
    ].join("\n");
    const created = await service.create({ skillMd: before });
    if (!created.ok) throw new Error(created.error.message);
    const updated = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: after,
      actor: "human",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const compared = await service.compare(created.value.workspace.id, 1, 2);
    expect(compared.ok).toBe(true);
    if (compared.ok) {
      expect(compared.value.source.additions).toBe(3000);
      expect(compared.value.source.deletions).toBe(3000);
      expect(compared.value.source.changedLines).toHaveLength(3000);
    }
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

  it("rejects incomplete triggering observations and transcript steps", async () => {
    for (const mutate of [
      (snapshot: any) => {
        const triggering = snapshot.evaluations.find(
          (item: any) => item.kind === "triggering",
        );
        triggering.data.observations.push({
          caseId: triggering.data.cases[0].id,
        });
      },
      (snapshot: any) => {
        const testRun = snapshot.evaluations.find(
          (item: any) => item.kind === "test-run",
        );
        testRun.data.transcript.push({ kind: "tool-call" });
      },
    ]) {
      const json = await snapshotWith(mutate);
      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(json);
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });

  it("rejects malformed artifact and audit records before store import", async () => {
    for (const mutate of [
      (snapshot: any) => snapshot.artifacts.push(null),
      (snapshot: any) => snapshot.auditEvents.push(null),
    ]) {
      const json = await snapshotWith(mutate);
      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(json);
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });
});

describe("snapshot import triggering case guards", () => {
  it("rejects a triggering case whose expected value is missing or unknown", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const prepared = await service.prepareEvaluation(id, "triggering");
    if (!prepared.ok) throw new Error(prepared.error.message);
    const exported = await service.exportSnapshot(id);
    if (!exported.ok) throw new Error(exported.error.message);
    for (const mutate of [
      (item: any) => delete item.expected,
      (item: any) => {
        item.expected = "maybe";
      },
    ]) {
      const snapshot = JSON.parse(exported.value);
      const triggering = snapshot.evaluations.find(
        (item: any) => item.kind === "triggering",
      );
      mutate(triggering.data.cases[0]);
      const importer = createWorkspaceService(new MemoryWorkspaceStore());
      const imported = await importer.importSnapshot(JSON.stringify(snapshot));
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });

  it("grades the selected choice candidate flag instead of a magic id", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await service.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    const triggering = snapshot.evaluations.find(
      (item: any) => item.kind === "triggering",
    );
    for (const testCase of triggering.data.cases)
      testCase.choices.find((choice: any) => choice.candidate).id = "skill-1";
    const importer = createWorkspaceService(new MemoryWorkspaceStore());
    const imported = await importer.importSnapshot(JSON.stringify(snapshot));
    if (!imported.ok) throw new Error(imported.error.message);
    const record = imported.value.evaluations.find(
      (item) => item.kind === "triggering",
    )!;
    const firstCase = (record.data as any).cases[0];
    const graded = await importer.submitEvaluation(
      imported.value.workspace.id,
      record.id,
      {
        caseId: firstCase.id,
        selectedChoiceId: "skill-1",
        rationale: "This is the candidate Skill.",
      },
    );
    expect(graded.ok).toBe(true);
    if (graded.ok)
      expect((graded.value.data as any).observations[0].passed).toBe(true);
  });

  it("rejects incomplete triggering choice records", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await service.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    const triggering = snapshot.evaluations.find(
      (item: any) => item.kind === "triggering",
    );
    delete triggering.data.cases[0].choices[0].candidate;
    const imported = await createWorkspaceService(
      new MemoryWorkspaceStore(),
    ).importSnapshot(JSON.stringify(snapshot));
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
  });
});

describe("snapshot import evaluation kinds", () => {
  it("rejects deferred evaluation kinds before rendering", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await service.prepareEvaluation(
      created.value.workspace.id,
      "triggering",
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    snapshot.evaluations[0].kind = "capacity-probe";
    const imported = await createWorkspaceService(
      new MemoryWorkspaceStore(),
    ).importSnapshot(JSON.stringify(snapshot));
    expect(imported.ok).toBe(false);
    if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
  });
});
