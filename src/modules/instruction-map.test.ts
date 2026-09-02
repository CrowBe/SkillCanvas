import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_MAP_MAX_BYTES,
  INSTRUCTION_MAP_MAX_DEPTH,
  INSTRUCTION_MAP_MAX_REQUIREMENTS,
  INSTRUCTION_MAP_MAX_STATEMENT_LENGTH,
  instructionLoadVector,
  validateInstructionMap,
  type InstructionMap,
} from "./instruction-map";

const raw = "one two three four five six";
const base = {
  revision: 1,
  suppliedBy: "visiting-agent proposal",
  status: "accepted",
} as const;

describe("instruction-load vector", () => {
  it("distinguishes equal atomic counts with different dependency and scope depth", () => {
    const flat: InstructionMap = {
      ...base,
      scopes: [{ id: "root", label: "Root" }],
      requirements: [
        {
          id: "a",
          sourceSpan: { start: 0, end: 3 },
          statement: "one",
          kind: "action",
          scopeId: "root",
          dependencies: [],
          verifiability: "deterministic",
        },
        {
          id: "b",
          sourceSpan: { start: 4, end: 7 },
          statement: "two",
          kind: "constraint",
          scopeId: "root",
          dependencies: [],
          verifiability: "unverified",
        },
      ],
    };
    const hierarchical: InstructionMap = {
      ...base,
      scopes: [
        { id: "root", label: "Root" },
        { id: "child", parentId: "root", label: "Child" },
      ],
      requirements: [
        flat.requirements[0]!,
        { ...flat.requirements[1]!, scopeId: "child", dependencies: ["a"] },
      ],
    };
    expect(validateInstructionMap(flat, raw, 1).ok).toBe(true);
    expect(validateInstructionMap(hierarchical, raw, 1).ok).toBe(true);
    const a = instructionLoadVector(flat);
    const b = instructionLoadVector(hierarchical);
    expect(a.totalAtomicRequirements).toBe(b.totalAtomicRequirements);
    expect(a.longestDependencyChain).toBe(1);
    expect(b.longestDependencyChain).toBe(2);
    expect(a.maximumScopeDepth).toBe(1);
    expect(b.maximumScopeDepth).toBe(2);
  });

  it("rejects out-of-bounds spans and cycles", () => {
    const map: InstructionMap = {
      ...base,
      scopes: [{ id: "root", label: "Root" }],
      requirements: [
        {
          id: "a",
          sourceSpan: { start: 0, end: 100 },
          statement: "x",
          kind: "action",
          scopeId: "root",
          dependencies: [],
          verifiability: "unverified",
        },
      ],
    };
    expect(validateInstructionMap(map, raw, 1).ok).toBe(false);
  });

  it("counts maximum active requirements along one scope path", () => {
    const requirement = (id: string, scopeId: string, start: number) => ({
      id,
      sourceSpan: { start, end: start + 3 },
      statement: raw.slice(start, start + 3),
      kind: "action" as const,
      scopeId,
      dependencies: [],
      verifiability: "deterministic" as const,
    });
    const map: InstructionMap = {
      ...base,
      scopes: [
        { id: "root", label: "Root" },
        { id: "left", parentId: "root", label: "Left" },
        { id: "right", parentId: "root", label: "Right" },
      ],
      requirements: [
        requirement("root-r", "root", 0),
        requirement("left-r", "left", 4),
        requirement("right-r", "right", 8),
      ],
    };
    expect(instructionLoadVector(map).maximumSimultaneouslyActive).toBe(2);
  });
});

describe("instruction map validation", () => {
  it("rejects a scope hierarchy that contains a cycle", () => {
    const cyclic: InstructionMap = {
      ...base,
      scopes: [
        { id: "a", parentId: "b", label: "A" },
        { id: "b", parentId: "a", label: "B" },
      ],
      requirements: [
        {
          id: "r",
          sourceSpan: { start: 0, end: 3 },
          statement: "one",
          kind: "action",
          scopeId: "a",
          dependencies: [],
          verifiability: "deterministic",
        },
      ],
    };
    const result = validateInstructionMap(cyclic, raw, 1);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toContain("cycle");
  });

  it("bounds map cardinality and dependency depth", () => {
    const requirement = (index: number) => ({
      id: `r-${index}`,
      sourceSpan: { start: 0, end: 3 },
      statement: "one",
      kind: "action" as const,
      scopeId: "root",
      dependencies: index === 0 ? [] : [`r-${index - 1}`],
      verifiability: "deterministic" as const,
    });
    const atDepthLimit: InstructionMap = {
      ...base,
      scopes: [{ id: "root", label: "Root" }],
      requirements: Array.from(
        { length: INSTRUCTION_MAP_MAX_DEPTH },
        (_, index) => requirement(index),
      ),
    };
    expect(validateInstructionMap(atDepthLimit, raw, 1).ok).toBe(true);
    expect(
      validateInstructionMap(
        {
          ...atDepthLimit,
          requirements: [
            ...atDepthLimit.requirements,
            requirement(INSTRUCTION_MAP_MAX_DEPTH),
          ],
        },
        raw,
        1,
      ).ok,
    ).toBe(false);
    expect(
      validateInstructionMap(
        {
          ...atDepthLimit,
          requirements: Array.from(
            { length: INSTRUCTION_MAP_MAX_REQUIREMENTS + 1 },
            (_, index) => ({ ...requirement(index), dependencies: [] }),
          ),
        },
        raw,
        1,
      ).ok,
    ).toBe(false);
  });

  it("rejects oversized fields and total payloads before analysis", () => {
    const requirement = (id: string, statement: string) => ({
      id,
      sourceSpan: { start: 0, end: 3 },
      statement,
      kind: "action" as const,
      scopeId: "root",
      dependencies: [],
      verifiability: "deterministic" as const,
    });
    const oversizedField = {
      ...base,
      scopes: [{ id: "root", label: "Root" }],
      requirements: [
        requirement("r", "x".repeat(INSTRUCTION_MAP_MAX_STATEMENT_LENGTH + 1)),
      ],
    };
    expect(validateInstructionMap(oversizedField, raw, 1).ok).toBe(false);

    const statement = "x".repeat(600);
    const oversizedPayload = {
      ...base,
      scopes: [{ id: "root", label: "Root" }],
      requirements: Array.from({ length: 900 }, (_, index) =>
        requirement(`r-${index}`, statement),
      ),
    };
    expect(JSON.stringify(oversizedPayload).length).toBeGreaterThan(
      INSTRUCTION_MAP_MAX_BYTES,
    );
    expect(validateInstructionMap(oversizedPayload, raw, 1).ok).toBe(false);
  });

  it("rejects adversarial nesting without overflowing the call stack", () => {
    const nested: Record<string, unknown> = {};
    let current = nested;
    for (let depth = 0; depth < 1000; depth += 1) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    const result = validateInstructionMap(
      {
        ...base,
        scopes: [{ id: "root", label: "Root" }],
        requirements: [],
        nested,
      },
      raw,
      1,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_instruction_map");
  });
});
