import type { LintArtifact, StructureArtifact } from "../analysis";
import {
  nextTriggerCase,
  type TestRunData,
  type TriggerCase,
  type TriggeringRunData,
} from "../evaluations";
import type { InstructionLoadVector, InstructionMap } from "../instruction-map";
import { readArtifact, type CompareArtifact } from "./artifacts";
import type { EvaluationRecord, WorkspaceBundle } from "./types";

/** A triggering run with the case awaiting an observation already selected. */
export type TriggeringView = {
  readonly kind: "triggering";
  readonly record: EvaluationRecord;
  readonly data: TriggeringRunData;
  readonly nextCase: TriggerCase | null;
  readonly passed: number;
};
/** A mocked test run with its Tool contract and transcript already typed. */
export type TestRunView = {
  readonly kind: "test-run";
  readonly record: EvaluationRecord;
  readonly data: TestRunData;
};
export type EvaluationView = TriggeringView | TestRunView;

/** Everything the workbench shows for one Revision, already selected. */
export type WorkspaceView = {
  readonly lint: LintArtifact | null;
  readonly structure: StructureArtifact | null;
  readonly instructionMap: InstructionMap | null;
  readonly instructionLoad: InstructionLoadVector | null;
  readonly compare: CompareArtifact | null;
  readonly evaluation: EvaluationView | null;
};

/**
 * The typed view of one Evaluation, or null when its kind has nothing to show.
 * `capacity-probe` is refused at preparation, so no such record exists.
 */
export function evaluationView(
  record: EvaluationRecord | null | undefined,
): EvaluationView | null {
  if (!record) return null;
  if (record.kind === "triggering") {
    const data = record.data as TriggeringRunData;
    return {
      kind: "triggering",
      record,
      data,
      nextCase: nextTriggerCase(data) ?? null,
      passed: data.observations.filter((item) => item.passed).length,
    };
  }
  if (record.kind === "test-run")
    return { kind: "test-run", record, data: record.data as TestRunData };
  return null;
}

/** The newest Evaluation: latest update, then creation, then id. */
function newestEvaluation(
  evaluations: readonly EvaluationRecord[],
): EvaluationRecord | undefined {
  return [...evaluations]
    .sort(
      (left, right) =>
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
    .at(-1);
}

export function workspaceView(bundle: WorkspaceBundle): WorkspaceView {
  return {
    lint: readArtifact(bundle, "lint"),
    structure: readArtifact(bundle, "structure"),
    instructionMap: readArtifact(bundle, "instruction-map"),
    instructionLoad: readArtifact(bundle, "instruction-load"),
    compare: readArtifact(bundle, "compare"),
    evaluation: evaluationView(newestEvaluation(bundle.evaluations)),
  };
}
