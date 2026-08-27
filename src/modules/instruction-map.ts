import { err, ok, type Result, type SourceSpan } from "./shared";

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

export function validateInstructionMap(
  map: InstructionMap,
  raw: string,
  revision: number,
): Result<InstructionMap> {
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
  const chain = (id: string, memo = new Map<string, number>()): number => {
    if (memo.has(id)) return memo.get(id)!;
    const item = requirements.get(id);
    const value = item?.dependencies.length
      ? 1 + Math.max(...item.dependencies.map((dep) => chain(dep, memo)))
      : 1;
    memo.set(id, value);
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
  const conflictPairs = new Set<string>();
  for (const a of map.requirements)
    for (const b of map.requirements) {
      if (a.id >= b.id || a.scopeId !== b.scopeId) continue;
      if (
        a.statement.toLowerCase() === b.statement.toLowerCase() &&
        (a.kind === "prohibition") !== (b.kind === "prohibition")
      )
        conflictPairs.add(`${a.id}:${b.id}`);
    }
  const descendants = (scopeId: string) =>
    map.scopes
      .filter(
        (scope) => scope.id === scopeId || isDescendant(scope, scopeId, scopes),
      )
      .map((scope) => scope.id);
  const maxActive = Math.max(
    0,
    ...map.scopes.map((scope) => {
      const pathScopes = new Set(descendants(scope.id));
      return map.requirements.filter((item) => pathScopes.has(item.scopeId))
        .length;
    }),
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
    branchCount: map.scopes.filter(
      (scope) =>
        map.scopes.filter((child) => child.parentId === scope.id).length > 1,
    ).length,
    crossScopeReferences,
    conflicts: conflictPairs.size,
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

function isDescendant(
  scope: InstructionScope,
  ancestorId: string,
  scopes: Map<string, InstructionScope>,
): boolean {
  let current: InstructionScope | undefined = scope;
  while (current?.parentId) {
    if (current.parentId === ancestorId) return true;
    current = scopes.get(current.parentId);
  }
  return false;
}
