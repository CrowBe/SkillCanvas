import { describe, expect, it } from "vitest";
import { SNAPSHOT_MAX_BYTES, byteLength } from "../shared";
import { EMPTY_SKILL } from "../skill";
import { MemoryWorkspaceStore } from "./memory-store";
import { createWorkspaceService } from "./service";

describe("WorkspaceService", () => {
  it("rejects revisions that would make the portable snapshot oversized", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const reference = (index: number) => ({
      path: `references/${index}.txt`,
      content: `${index}:`.padEnd(470_000, String(index % 10)),
    });
    const created = await service.create({
      skillMd: EMPTY_SKILL,
      referenceFiles: Array.from({ length: 7 }, (_, index) => reference(index)),
    });
    if (!created.ok) throw new Error(created.error.message);

    const rejected = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nOversized history.`,
      referenceFiles: Array.from({ length: 9 }, (_, index) => reference(index)),
      actor: "human",
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("size_limit");
    const current = await service.open(created.value.workspace.id);
    expect(current.ok && current.value.revision.revision).toBe(1);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    expect(byteLength(exported.value)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    const restored = await createWorkspaceService(
      new MemoryWorkspaceStore(),
    ).importSnapshot(exported.value);
    expect(restored.ok).toBe(true);
  });

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

  it("deduplicates byte-identical blobs in portable snapshots", async () => {
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

  it("rejects noncanonical workspace and audit ids", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await source.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);

    for (const mutate of [
      (snapshot: any) => {
        snapshot.workspace.id = "x";
        snapshot.revisions[0].workspaceId = "x";
        snapshot.auditEvents[0].workspaceId = "x";
      },
      (snapshot: any) => {
        snapshot.auditEvents[0].id = "x";
      },
    ]) {
      const snapshot = JSON.parse(exported.value);
      mutate(snapshot);
      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(JSON.stringify(snapshot));
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });

  it("restores an earlier snapshot over the same workspace", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const updated = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nLater revision.`,
      actor: "human",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const collision = await service.importSnapshot(exported.value);
    expect(collision.ok).toBe(false);
    const inspection = await service.inspectSnapshotImport(exported.value);
    if (!inspection.ok || !inspection.value.replacementTarget)
      throw new Error("replacement target missing");
    const restored = await service.replaceSnapshot(
      exported.value,
      inspection.value.replacementTarget,
    );
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.revision.revision).toBe(1);
    expect(restored.value.skillMd).toBe(EMPTY_SKILL);
    expect(await service.list()).toHaveLength(1);
  });
});

describe("WorkspaceService input validation", () => {
  it("removes accepted load metrics when a map becomes proposed", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const map = {
      revision: 1,
      suppliedBy: "visiting-agent proposal",
      status: "proposed",
      scopes: [{ id: "root", label: "Root" }],
      requirements: [],
    } as const;
    const accepted = await service.submitInstructionMap(
      created.value.workspace.id,
      map,
      true,
    );
    if (!accepted.ok) throw new Error(accepted.error.message);
    let current = await service.open(created.value.workspace.id);
    if (!current.ok) throw new Error(current.error.message);
    expect(
      current.value.artifacts.some((item) => item.kind === "instruction-load"),
    ).toBe(true);
    const proposed = await service.submitInstructionMap(
      created.value.workspace.id,
      map,
      false,
    );
    if (!proposed.ok) throw new Error(proposed.error.message);
    current = await service.open(created.value.workspace.id);
    if (!current.ok) throw new Error(current.error.message);
    expect(
      current.value.artifacts.some((item) => item.kind === "instruction-load"),
    ).toBe(false);
    expect(
      (
        current.value.artifacts.find((item) => item.kind === "instruction-map")
          ?.data as any
      ).status,
    ).toBe("proposed");
  });

  it("rejects incoherent imported instruction map and load pairs", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const submitted = await service.submitInstructionMap(
      created.value.workspace.id,
      {
        revision: 1,
        suppliedBy: "visiting-agent proposal",
        status: "proposed",
        scopes: [{ id: "root", label: "Root" }],
        requirements: [],
      },
      true,
    );
    if (!submitted.ok) throw new Error(submitted.error.message);
    const exported = await service.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    for (const mutate of [
      (snapshot: any) => {
        snapshot.artifacts.find(
          (artifact: any) => artifact.kind === "instruction-map",
        ).data.status = "proposed";
      },
      (snapshot: any) => {
        snapshot.artifacts.find(
          (artifact: any) => artifact.kind === "instruction-load",
        ).data.totalAtomicRequirements += 1;
      },
      (snapshot: any) => {
        snapshot.artifacts = snapshot.artifacts.filter(
          (artifact: any) => artifact.kind !== "instruction-load",
        );
      },
      (snapshot: any) => {
        snapshot.artifacts
          .filter((artifact: any) =>
            ["instruction-map", "instruction-load"].includes(artifact.kind),
          )
          .forEach((artifact: any) => {
            artifact.id = `foreign-${artifact.kind}`;
          });
      },
    ]) {
      const snapshot = JSON.parse(exported.value);
      mutate(snapshot);
      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(JSON.stringify(snapshot));
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });

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
        approximate: false,
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
      expect(compared.value.source.approximate).toBe(true);
    }
  });

  it("keeps sparse large changes exact after the matrix budget", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const header = [
      "---",
      "name: sparse-diff-skill",
      "description: Use when sparse changes need exact metadata.",
      "---",
      "",
      "# Data",
    ];
    const lines = Array.from({ length: 3000 }, (_, index) => `line-${index}`);
    const before = [...header, ...lines].join("\n");
    const changed = [...lines];
    changed[100] = "changed-100";
    changed[2900] = "changed-2900";
    const created = await service.create({ skillMd: before });
    if (!created.ok) throw new Error(created.error.message);
    const updated = await service.update({
      workspaceId: created.value.workspace.id,
      baseRevision: 1,
      skillMd: [...header, ...changed].join("\n"),
      actor: "human",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const compared = await service.compare(created.value.workspace.id, 1, 2);
    expect(compared.ok).toBe(true);
    if (compared.ok)
      expect(compared.value.source).toEqual({
        additions: 2,
        deletions: 2,
        changedLines: [107, 2907],
        approximate: false,
      });
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

  it("rejects deeply nested live schemas with a domain result", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const schema: Record<string, unknown> = { type: "string" };
    let current = schema;
    for (let depth = 0; depth < 1000; depth += 1) {
      const child: Record<string, unknown> = { type: "array" };
      current.type = "array";
      current.items = child;
      current = child;
    }

    const result = await service.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "deep_schema",
          description: "Exercise bounded admission",
          inputSchema: schema,
          outputSchema: { type: "object" },
        },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_submission");
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

  it("preserves an explicitly null final output", async () => {
    const service = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const prepared = await service.prepareEvaluation(
      created.value.workspace.id,
      "test-run",
      {
        contract: {
          name: "read_null",
          description: "Return null",
          inputSchema: { type: "object" },
          outputSchema: { type: "null" },
          mockOutput: null,
        },
        responseSchema: { type: "null" },
      },
    );
    if (!prepared.ok) throw new Error(prepared.error.message);
    const submitted = await service.submitEvaluation(
      created.value.workspace.id,
      prepared.value.id,
      { finalOutput: null },
    );
    expect(submitted.ok).toBe(true);
    if (submitted.ok)
      expect((submitted.value.data as any).finalOutput).toBeNull();
  });
});

describe("snapshot import schema guards", () => {
  it("recomputes deterministic artifacts during snapshot admission", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const firstAnalysis = await source.analyze(id, ["lint", "structure"]);
    if (!firstAnalysis.ok) throw new Error(firstAnalysis.error.message);
    const updated = await source.update({
      workspaceId: id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\n## Added\n\nRun the workflow.`,
      actor: "human",
    });
    if (!updated.ok) throw new Error(updated.error.message);
    const secondAnalysis = await source.analyze(id, ["lint", "structure"]);
    if (!secondAnalysis.ok) throw new Error(secondAnalysis.error.message);
    const exported = await source.exportSnapshot(id);
    if (!exported.ok) throw new Error(exported.error.message);

    for (const mutate of [
      (snapshot: any) => {
        snapshot.artifacts.find(
          (item: any) => item.kind === "lint",
        ).data.score += 1;
      },
      (snapshot: any) => {
        snapshot.artifacts.find(
          (item: any) => item.kind === "structure",
        ).data.title = "Falsified";
      },
    ]) {
      const snapshot = JSON.parse(exported.value);
      mutate(snapshot);
      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(JSON.stringify(snapshot));
      expect(imported.ok).toBe(false);
      if (!imported.ok) expect(imported.error.code).toBe("invalid_snapshot");
    }
  });
});

describe("portable snapshot evidence boundary", () => {
  it("keeps only the latest canonical comparison across revisions", async () => {
    const store = new MemoryWorkspaceStore();
    const service = createWorkspaceService(store);
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    const second = await service.update({
      workspaceId: id,
      baseRevision: 1,
      skillMd: `${EMPTY_SKILL}\nSecond revision.`,
      actor: "human",
    });
    if (!second.ok) throw new Error(second.error.message);
    await service.compare(id, 1, 2);
    const third = await service.update({
      workspaceId: id,
      baseRevision: 2,
      skillMd: `${EMPTY_SKILL}\nThird revision.`,
      actor: "human",
    });
    if (!third.ok) throw new Error(third.error.message);
    await service.compare(id, 2, 3);
    const snapshot = await store.exportSnapshot(id);
    if ("code" in snapshot) throw new Error(snapshot.message);
    const comparisons = snapshot.artifacts.filter(
      (artifact) => artifact.kind === "compare",
    );

    expect(comparisons).toHaveLength(1);
    expect((comparisons[0]!.data as any).afterRevision).toBe(3);
    expect(comparisons[0]!.id).toMatch(
      /:compare:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("exports importable JSON without deterministic evidence", async () => {
    const store = new MemoryWorkspaceStore();
    const service = createWorkspaceService(store);
    const created = await service.create({ skillMd: EMPTY_SKILL });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.value.workspace.id;
    await service.prepareEvaluation(id, "triggering");
    await service.compare(id, 1, 1);

    const exported = await service.exportSnapshot(id);
    if (!exported.ok) throw new Error(exported.error.message);
    const snapshot = JSON.parse(exported.value);
    expect(snapshot.evaluations).toEqual([]);
    expect(
      snapshot.artifacts.some((item: any) => item.kind === "compare"),
    ).toBe(false);
    const imported = await createWorkspaceService(
      new MemoryWorkspaceStore(),
    ).importSnapshot(exported.value);
    expect(imported.ok).toBe(true);
  });

  it("rejects locally captured evaluation and comparison evidence", async () => {
    for (const kind of ["evaluation", "comparison"] as const) {
      const store = new MemoryWorkspaceStore();
      const service = createWorkspaceService(store);
      const created = await service.create({ skillMd: EMPTY_SKILL });
      if (!created.ok) throw new Error(created.error.message);
      const id = created.value.workspace.id;
      if (kind === "evaluation")
        await service.prepareEvaluation(id, "triggering");
      else await service.compare(id, 1, 1);
      const snapshot = await store.exportSnapshot(id);
      if ("code" in snapshot) throw new Error(snapshot.message);

      const imported = await createWorkspaceService(
        new MemoryWorkspaceStore(),
      ).importSnapshot(JSON.stringify(snapshot));
      expect(imported.ok).toBe(false);
      if (!imported.ok) {
        expect(imported.error.code).toBe("invalid_snapshot");
        expect(imported.error.message).toContain("regenerate evaluations");
      }
    }
  });
});
