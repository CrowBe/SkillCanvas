import { byteLength, err, ok, type Result, type SourceSpan } from "./shared";

export type InstructionKind =
  "action" | "constraint" | "condition" | "prohibition" | "preference";
export type Verifiability =
  "deterministic" | "semantic-judgment" | "unverified";
export type AtomicRequirement = {
  readonly id: string;
  readonly sourceSpan: SourceSpan;
  readonly statement: string;
  readonly kind: InstructionKind;
  readonly scopeId: string;
  readonly dependencies: readonly string[];
  readonly verifiability: Verifiability;
};
export type InstructionScope = {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
};
export type InstructionMap = {
  readonly revision: number;
  readonly suppliedBy: "visiting-agent proposal";
  readonly status: "proposed" | "accepted";
  readonly scopes: readonly InstructionScope[];
  readonly requirements: readonly AtomicRequirement[];
};
export type InstructionLoadVector = {
  readonly totalAtomicRequirements: number;
  readonly maximumSimultaneouslyActive: number;
  readonly longestDependencyChain: number;
  readonly maximumScopeDepth: number;
  readonly branchCount: number;
  readonly crossScopeReferences: number;
  readonly conflicts: number;
  readonly duplicates: number;
  readonly deterministicallyVerifiableFraction: number;
};

const INSTRUCTION_KINDS: readonly string[] = [
  "action",
  "constraint",
  "condition",
  "prohibition",
  "preference",
];
const VERIFIABILITIES: readonly string[] = [
  "deterministic",
  "semantic-judgment",
  "unverified",
];
export const INSTRUCTION_MAP_MAX_SCOPES = 1000;
export const INSTRUCTION_MAP_MAX_REQUIREMENTS = 1000;
export const INSTRUCTION_MAP_MAX_DEPENDENCIES_PER_REQUIREMENT = 100;
export const INSTRUCTION_MAP_MAX_DEPTH = 100;
export const INSTRUCTION_MAP_MAX_BYTES = 512 * 1024;
export const INSTRUCTION_MAP_MAX_ID_LENGTH = 256;
export const INSTRUCTION_MAP_MAX_LABEL_LENGTH = 512;
export const INSTRUCTION_MAP_MAX_STATEMENT_LENGTH = 4096;
export const INSTRUCTION_MAP_MAX_INPUT_DEPTH = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapeError(message: string): Result<InstructionMap> {
  return err("invalid_instruction_map", message);
}

function oversized(value: string, maximum: number): boolean {
  return value.length > maximum;
}

function jsonWithinBudget(value: unknown, maximum: number): boolean {
  let remaining = maximum;
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const { value: candidate, depth } = pending.pop()!;
    remaining -= 1;
    if (remaining < 0) return false;
    if (typeof candidate === "string") {
      if (candidate.length > remaining) return false;
      remaining -= byteLength(candidate);
      if (remaining < 0) return false;
      continue;
    }
    if (candidate === null || typeof candidate !== "object") continue;
    if (depth >= INSTRUCTION_MAP_MAX_INPUT_DEPTH) return false;
    for (const [key, nested] of Object.entries(candidate)) {
      if (key.length > remaining) return false;
      remaining -= byteLength(key);
      if (remaining < 0) return false;
      pending.push({ value: nested, depth: depth + 1 });
    }
  }
  return true;
}

function checkShape(input: unknown): Result<InstructionMap> {
  if (!isRecord(input)) return shapeError("Instruction map must be an object.");
  if (!jsonWithinBudget(input, INSTRUCTION_MAP_MAX_BYTES))
    return shapeError(
      `Instruction map exceeds ${INSTRUCTION_MAP_MAX_BYTES} bytes.`,
    );
  if (typeof input.revision !== "number")
    return shapeError("Instruction map requires a numeric revision.");
  if (input.status !== "proposed" && input.status !== "accepted")
    return shapeError(
      'Instruction map status must be "proposed" or "accepted".',
    );
  if (!Array.isArray(input.scopes) || !Array.isArray(input.requirements))
    return shapeError(
      "Instruction map requires scopes and requirements arrays.",
    );
  if (input.scopes.length > INSTRUCTION_MAP_MAX_SCOPES)
    return shapeError(
      `Instruction maps may contain at most ${INSTRUCTION_MAP_MAX_SCOPES} scopes.`,
    );
  if (input.requirements.length > INSTRUCTION_MAP_MAX_REQUIREMENTS)
    return shapeError(
      `Instruction maps may contain at most ${INSTRUCTION_MAP_MAX_REQUIREMENTS} requirements.`,
    );
  for (const scope of input.scopes) {
    if (!isRecord(scope) || typeof scope.id !== "string" || scope.id === "")
      return shapeError("Every scope requires a string id.");
    if (oversized(scope.id, INSTRUCTION_MAP_MAX_ID_LENGTH))
      return shapeError("Scope id exceeds the instruction map limit.");
    if (typeof scope.label !== "string")
      return shapeError(`Scope ${scope.id} requires a string label.`);
    if (oversized(scope.label, INSTRUCTION_MAP_MAX_LABEL_LENGTH))
      return shapeError(
        `Scope ${scope.id} label exceeds the instruction map limit.`,
      );
    if (scope.parentId !== undefined && typeof scope.parentId !== "string")
      return shapeError(`Scope ${scope.id} has an invalid parentId.`);
    if (
      typeof scope.parentId === "string" &&
      oversized(scope.parentId, INSTRUCTION_MAP_MAX_ID_LENGTH)
    )
      return shapeError(
        `Scope ${scope.id} parentId exceeds the instruction map limit.`,
      );
  }
  for (const requirement of input.requirements) {
    if (
      !isRecord(requirement) ||
      typeof requirement.id !== "string" ||
      requirement.id === ""
    )
      return shapeError("Every requirement requires a string id.");
    const label = requirement.id;
    if (oversized(label, INSTRUCTION_MAP_MAX_ID_LENGTH))
      return shapeError("Requirement id exceeds the instruction map limit.");
    if (typeof requirement.statement !== "string")
      return shapeError(`Requirement ${label} requires a statement.`);
    if (oversized(requirement.statement, INSTRUCTION_MAP_MAX_STATEMENT_LENGTH))
      return shapeError(
        `Requirement ${label} statement exceeds the instruction map limit.`,
      );
    if (typeof requirement.scopeId !== "string")
      return shapeError(`Requirement ${label} requires a scopeId.`);
    if (oversized(requirement.scopeId, INSTRUCTION_MAP_MAX_ID_LENGTH))
      return shapeError(
        `Requirement ${label} scopeId exceeds the instruction map limit.`,
      );
    if (!INSTRUCTION_KINDS.includes(requirement.kind as string))
      return shapeError(`Requirement ${label} has an unknown kind.`);
    if (!VERIFIABILITIES.includes(requirement.verifiability as string))
      return shapeError(`Requirement ${label} has an unknown verifiability.`);
    if (
      !Array.isArray(requirement.dependencies) ||
      requirement.dependencies.some((item) => typeof item !== "string")
    )
      return shapeError(`Requirement ${label} has invalid dependencies.`);
    if (
      requirement.dependencies.some((item) =>
        oversized(item, INSTRUCTION_MAP_MAX_ID_LENGTH),
      )
    )
      return shapeError(
        `Requirement ${label} dependency exceeds the instruction map limit.`,
      );
    if (
      requirement.dependencies.length >
      INSTRUCTION_MAP_MAX_DEPENDENCIES_PER_REQUIREMENT
    )
      return shapeError(`Requirement ${label} has too many dependencies.`);
    const span = requirement.sourceSpan;
    if (
      !isRecord(span) ||
      typeof span.start !== "number" ||
      typeof span.end !== "number"
    )
      return shapeError(`Requirement ${label} requires a numeric source span.`);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return shapeError("Instruction map must be JSON serializable.");
  }
  if (byteLength(serialized) > INSTRUCTION_MAP_MAX_BYTES)
    return shapeError(
      `Instruction map exceeds ${INSTRUCTION_MAP_MAX_BYTES} bytes.`,
    );
  return ok(input as unknown as InstructionMap);
}

export function validateInstructionMap(
  input: unknown,
  raw: string,
  revision: number,
): Result<InstructionMap> {
  const shape = checkShape(input);
  if (!shape.ok) return shape;
  const map = shape.value;
  if (map.revision !== revision)
    return err(
      "invalid_instruction_map",
      "Instruction map is not pinned to the current revision.",
    );
  const scopeIds = new Set(map.scopes.map((scope) => scope.id));
  const requirementIds = new Set(map.requirements.map((item) => item.id));
  if (
    scopeIds.size !== map.scopes.length ||
    requirementIds.size !== map.requirements.length
  )
    return err(
      "invalid_instruction_map",
      "Scope and requirement ids must be unique.",
    );
  for (const scope of map.scopes)
    if (scope.parentId && !scopeIds.has(scope.parentId))
      return err(
        "invalid_instruction_map",
        `Unknown parent scope: ${scope.parentId}`,
      );
  const parents = new Map(
    map.scopes.map((scope) => [scope.id, scope.parentId]),
  );
  for (const scope of map.scopes) {
    const seen = new Set<string>([scope.id]);
    let parentId = parents.get(scope.id);
    while (parentId) {
      if (seen.has(parentId))
        return err(
          "invalid_instruction_map",
          `Scope hierarchy contains a cycle at ${parentId}.`,
        );
      seen.add(parentId);
      if (seen.size > INSTRUCTION_MAP_MAX_DEPTH)
        return err(
          "invalid_instruction_map",
          `Scope hierarchy exceeds depth ${INSTRUCTION_MAP_MAX_DEPTH}.`,
        );
      parentId = parents.get(parentId);
    }
  }
  for (const requirement of map.requirements) {
    const { start, end } = requirement.sourceSpan;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > raw.length
    )
      return err(
        "invalid_instruction_map",
        `Invalid source span for ${requirement.id}.`,
      );
    if (raw.slice(start, end).trim() === "")
      return err(
        "invalid_instruction_map",
        `Source span for ${requirement.id} is empty.`,
      );
    if (!scopeIds.has(requirement.scopeId))
      return err(
        "invalid_instruction_map",
        `Unknown scope for ${requirement.id}.`,
      );
    if (
      requirement.dependencies.some(
        (id) => !requirementIds.has(id) || id === requirement.id,
      )
    )
      return err(
        "invalid_instruction_map",
        `Invalid dependency for ${requirement.id}.`,
      );
  }
  if (hasCycle(map.requirements))
    return err(
      "invalid_instruction_map",
      "Instruction dependencies must be acyclic.",
    );
  if (maximumDependencyDepth(map.requirements) > INSTRUCTION_MAP_MAX_DEPTH)
    return err(
      "invalid_instruction_map",
      `Instruction dependencies exceed depth ${INSTRUCTION_MAP_MAX_DEPTH}.`,
    );
  return ok(map);
}

export function instructionLoadVector(
  map: InstructionMap,
): InstructionLoadVector {
  const scopes = new Map(map.scopes.map((scope) => [scope.id, scope]));
  const requirements = new Map(map.requirements.map((item) => [item.id, item]));
  const depth = (id: string): number => {
    let value = 1;
    let current = scopes.get(id);
    const seen = new Set<string>();
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      value += 1;
      current = scopes.get(current.parentId);
    }
    return value;
  };
  const chainMemo = new Map<string, number>();
  const chain = (id: string): number => {
    if (chainMemo.has(id)) return chainMemo.get(id)!;
    const item = requirements.get(id);
    const value = item?.dependencies.length
      ? 1 + Math.max(...item.dependencies.map((dep) => chain(dep)))
      : 1;
    chainMemo.set(id, value);
    return value;
  };
  const statements = new Map<string, number>();
  let crossScopeReferences = 0;
  for (const item of map.requirements) {
    const key = item.statement.trim().toLowerCase();
    statements.set(key, (statements.get(key) ?? 0) + 1);
    crossScopeReferences += item.dependencies.filter(
      (dep) => requirements.get(dep)?.scopeId !== item.scopeId,
    ).length;
  }
  const conflictGroups = new Map<
    string,
    { prohibitions: number; permissions: number }
  >();
  const requirementsByScope = new Map<string, number>();
  for (const item of map.requirements) {
    const key = `${item.scopeId}\0${item.statement.toLowerCase()}`;
    const group = conflictGroups.get(key) ?? {
      prohibitions: 0,
      permissions: 0,
    };
    if (item.kind === "prohibition") group.prohibitions += 1;
    else group.permissions += 1;
    conflictGroups.set(key, group);
    requirementsByScope.set(
      item.scopeId,
      (requirementsByScope.get(item.scopeId) ?? 0) + 1,
    );
  }
  const ancestors = (scopeId: string) => {
    const ids = new Set<string>();
    let current = scopes.get(scopeId);
    while (current && !ids.has(current.id)) {
      ids.add(current.id);
      current = current.parentId ? scopes.get(current.parentId) : undefined;
    }
    return ids;
  };
  const maxActive = Math.max(
    0,
    ...map.scopes.map((scope) => {
      const pathScopes = ancestors(scope.id);
      let active = 0;
      for (const scopeId of pathScopes)
        active += requirementsByScope.get(scopeId) ?? 0;
      return active;
    }),
  );
  const childCounts = new Map<string, number>();
  for (const scope of map.scopes)
    if (scope.parentId)
      childCounts.set(
        scope.parentId,
        (childCounts.get(scope.parentId) ?? 0) + 1,
      );
  return {
    totalAtomicRequirements: map.requirements.length,
    maximumSimultaneouslyActive: maxActive,
    longestDependencyChain: Math.max(
      0,
      ...map.requirements.map((item) => chain(item.id)),
    ),
    maximumScopeDepth: Math.max(
      0,
      ...map.scopes.map((scope) => depth(scope.id)),
    ),
    branchCount: [...childCounts.values()].filter((count) => count > 1).length,
    crossScopeReferences,
    conflicts: [...conflictGroups.values()].reduce(
      (sum, group) => sum + group.prohibitions * group.permissions,
      0,
    ),
    duplicates: [...statements.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    deterministicallyVerifiableFraction:
      map.requirements.length === 0
        ? 0
        : map.requirements.filter(
            (item) => item.verifiability === "deterministic",
          ).length / map.requirements.length,
  };
}

function maximumDependencyDepth(
  requirements: readonly AtomicRequirement[],
): number {
  const graph = new Map(
    requirements.map((item) => [item.id, item.dependencies]),
  );
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const dependencies = graph.get(id) ?? [];
    const value = dependencies.length
      ? 1 + Math.max(...dependencies.map(depth))
      : 1;
    memo.set(id, value);
    return value;
  };
  return Math.max(0, ...requirements.map((item) => depth(item.id)));
}

function hasCycle(requirements: readonly AtomicRequirement[]): boolean {
  const graph = new Map(
    requirements.map((item) => [item.id, item.dependencies]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return requirements.some((item) => visit(item.id));
}
