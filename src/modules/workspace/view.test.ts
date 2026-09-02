import { describe, expect, it } from "vitest";
import { MemoryWorkspaceStore } from "./memory-store";
import { createWorkspaceService } from "./service";
import { evaluationView, workspaceView } from "./view";
import type { EvaluationRecord, WorkspaceBundle } from "./types";

async function bundleWithEvaluations() {
  const service = createWorkspaceService(new MemoryWorkspaceStore());
  const created = await service.create({ name: "Evaluation order" });
  if (!created.ok) throw new Error(created.error.message);
  const workspaceId = created.value.workspace.id;
  const triggering = await service.prepareEvaluation(workspaceId, "triggering");
  const testRun = await service.prepareEvaluation(workspaceId, "test-run", {
    contract: {
      name: "read_feedback",
      description: "mock",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      mockOutput: {},
    },
  });
  if (!triggering.ok || !testRun.ok)
    throw new Error("evaluation preparation failed");
  const opened = await service.open(workspaceId);
  if (!opened.ok) throw new Error(opened.error.message);
  return {
    bundle: opened.value,
    triggering: triggering.value,
    testRun: testRun.value,
  };
}

const at = (record: EvaluationRecord, stamp: string): EvaluationRecord => ({
  ...record,
  createdAt: stamp,
  updatedAt: stamp,
});

const withEvaluations = (
  bundle: WorkspaceBundle,
  evaluations: readonly EvaluationRecord[],
): WorkspaceBundle => ({ ...bundle, evaluations });

const comparison = (id: string, createdAt: string, score: number) => ({
  id,
  workspaceId: "ws",
  revision: 1,
  kind: "compare" as const,
  version: "skill-canvas-rules/1",
  createdAt,
  data: {
    kind: "compare",
    beforeRevision: 1,
    afterRevision: 1,
    source: {
      additions: 0,
      deletions: 0,
      changedLines: [],
      approximate: false,
    },
    lint: {
      before: { score, grade: "A", counts: { error: 0, warn: 0, info: 0 } },
      after: { score, grade: "A", counts: { error: 0, warn: 0, info: 0 } },
    },
    evaluationReferences: [],
  },
});

describe("workspaceView", () => {
  it("selects the newest evaluation independently of storage order", async () => {
    const { bundle, triggering, testRun } = await bundleWithEvaluations();
    const older = at(triggering, "2026-01-01T00:00:00.000Z");
    const newer = at(testRun, "2026-02-01T00:00:00.000Z");

    expect(
      workspaceView(withEvaluations(bundle, [newer, older])).evaluation?.kind,
    ).toBe("test-run");
    expect(
      workspaceView(withEvaluations(bundle, [older, newer])).evaluation?.kind,
    ).toBe("test-run");
  });

  it("compares evaluation timestamps as instants, not as strings", async () => {
    const { bundle, triggering, testRun } = await bundleWithEvaluations();
    const offsetTriggering = at(triggering, "2026-01-01T00:30:00-01:00");
    const utcTestRun = at(testRun, "2026-01-01T01:00:00.000Z");

    expect(
      workspaceView(withEvaluations(bundle, [utcTestRun, offsetTriggering]))
        .evaluation?.kind,
    ).toBe("triggering");
  });

  it("breaks ties on creation, then on id", async () => {
    const { bundle, triggering, testRun } = await bundleWithEvaluations();
    const same = "2026-01-01T00:00:00.000Z";
    const a = { ...at(triggering, same), id: "eval_a" };
    const b = { ...at(testRun, same), id: "eval_b" };

    expect(
      workspaceView(withEvaluations(bundle, [b, a])).evaluation?.record.id,
    ).toBe("eval_b");
  });

  it("reads the latest comparison deterministically", async () => {
    const { bundle } = await bundleWithEvaluations();
    const artifacts = [
      comparison("newer", "2026-02-01T00:00:00.000Z", 92),
      comparison("older", "2026-01-01T00:00:00.000Z", 41),
    ];

    expect(
      workspaceView({ ...bundle, artifacts }).compare?.lint.after.score,
    ).toBe(92);
    expect(
      workspaceView({ ...bundle, artifacts: [...artifacts].reverse() }).compare
        ?.lint.after.score,
    ).toBe(92);
  });

  it("has nothing to show for a workspace with no artifacts or evaluations", async () => {
    const { bundle } = await bundleWithEvaluations();
    const view = workspaceView({ ...bundle, artifacts: [], evaluations: [] });

    expect(view).toEqual({
      lint: null,
      structure: null,
      instructionMap: null,
      instructionLoad: null,
      compare: null,
      evaluation: null,
    });
  });
});

describe("evaluationView", () => {
  it("selects the case awaiting an observation and counts passes", async () => {
    const { bundle, triggering } = await bundleWithEvaluations();
    const view = workspaceView(
      withEvaluations(bundle, [triggering]),
    ).evaluation;
    if (view?.kind !== "triggering")
      throw new Error("expected a triggering view");

    expect(view.nextCase?.id).toBe(view.data.cases[0]?.id);
    expect(view.passed).toBe(0);
  });

  it("reports no next case once every case is observed", async () => {
    const { triggering } = await bundleWithEvaluations();
    const data = triggering.data as {
      cases: readonly { id: string }[];
      observations: readonly unknown[];
    };
    const finished = {
      ...triggering,
      data: {
        ...data,
        observations: data.cases.map((item) => ({
          caseId: item.id,
          selectedChoiceId: "x",
          rationale: "done",
          passed: true,
          suppliedBy: "visiting browser agent" as const,
          submittedAt: "2026-01-01T00:00:00.000Z",
        })),
      },
    };
    const view = evaluationView(finished);
    if (view?.kind !== "triggering")
      throw new Error("expected a triggering view");

    expect(view.nextCase).toBeNull();
    expect(view.passed).toBe(data.cases.length);
  });

  it("has nothing to show for a kind the workbench does not display", async () => {
    const { triggering } = await bundleWithEvaluations();

    expect(evaluationView(null)).toBeNull();
    expect(
      evaluationView({ ...triggering, kind: "capacity-probe" }),
    ).toBeNull();
  });
});
