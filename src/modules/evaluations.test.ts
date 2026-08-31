import { describe, expect, it } from "vitest";
import {
  exampleFromSchema,
  invokeMockTool,
  prepareTestRun,
  prepareTriggering,
  submitTestRun,
  submitTriggering,
  schemaSubsetError,
  validateSchema,
} from "./evaluations";
import { EMPTY_SKILL } from "./skill";
import { MemoryWorkspaceStore } from "./workspace/memory-store";
import { createWorkspaceService } from "./workspace/service";

async function bundle() {
  const created = await createWorkspaceService(
    new MemoryWorkspaceStore(),
  ).create({ skillMd: EMPTY_SKILL });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("evaluation protocols", () => {
  it("pins stable triggering case identity and grades one observation", async () => {
    const workspace = await bundle();
    const first = await prepareTriggering(workspace);
    const second = await prepareTriggering(workspace);
    expect((first.data as any).cases.map((item: any) => item.id)).toEqual(
      (second.data as any).cases.map((item: any) => item.id),
    );
    const testCase = (first.data as any).cases[0];
    const submitted = submitTriggering(first, {
      caseId: testCase.id,
      selectedChoiceId: "candidate",
      rationale: "Description matches.",
    });
    expect(
      submitted.ok && (submitted.value.data as any).observations[0],
    ).toMatchObject({ passed: true, suppliedBy: "visiting browser agent" });
  });

  it("derives fixtures and checks tool/final JSON contracts", async () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
    } as const;
    expect(exampleFromSchema(schema)).toEqual({ items: ["example"] });
    expect(validateSchema({}, schema)).toContain("$.items is required.");
    const run = await prepareTestRun(
      await bundle(),
      {
        name: "read_items",
        description: "Read items",
        inputSchema: {
          type: "object",
          required: ["limit"],
          properties: { limit: { type: "integer" } },
        },
        outputSchema: schema,
      },
      schema,
    );
    const invoked = invokeMockTool(run, { limit: 2 });
    expect(invoked.ok).toBe(true);
    if (!invoked.ok) return;
    const submitted = submitTestRun(invoked.value.record, { items: ["done"] });
    expect(
      submitted.ok &&
        (submitted.value.data as any).checks.every(
          (check: any) => check.passed,
        ),
    ).toBe(true);
  });

  it("rejects values outside a schema enum", () => {
    expect(
      validateSchema("delete", { type: "string", enum: ["create"] }),
    ).toEqual(["$ must be one of the allowed enum values."]);
    expect(
      validateSchema({ action: "create" }, { enum: [{ action: "create" }] }),
    ).toEqual([]);
  });

  it("rejects structural keywords without compatible types", () => {
    expect(
      schemaSubsetError({ properties: { action: { enum: ["create"] } } }),
    ).toContain("requires type object");
    expect(schemaSubsetError({ required: ["action"] })).toContain(
      "requires type object",
    );
    expect(schemaSubsetError({ items: { type: "string" } })).toContain(
      "requires type array",
    );
  });

  it("keeps completed test runs terminal", async () => {
    const run = await prepareTestRun(await bundle(), {
      name: "read_items",
      description: "Read items",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    const completed = submitTestRun(run, {});
    if (!completed.ok) throw new Error(completed.error.message);
    for (const result of [
      invokeMockTool(completed.value, {}),
      submitTestRun(completed.value, {}),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("evaluation_complete");
    }
  });
});

describe("triggering candidate derivation", () => {
  it("reads block-scalar frontmatter descriptions", async () => {
    const skillMd = [
      "---",
      "name: block-scalar-skill",
      "description: >-",
      "  Use when the user wants quarterly revenue reconciled across ledgers.",
      "---",
      "",
      "# Block scalar skill",
      "",
      "Body.",
    ].join("\n");
    const created = await createWorkspaceService(
      new MemoryWorkspaceStore(),
    ).create({ skillMd });
    if (!created.ok) throw new Error(created.error.message);
    const run = await prepareTriggering(created.value);
    const candidate = (run.data as any).cases[0].choices.find(
      (choice: any) => choice.candidate,
    );
    expect(candidate.name).toBe("block-scalar-skill");
    expect(candidate.description).toContain("quarterly revenue");
  });
});
