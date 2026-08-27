import { describe, expect, it } from "vitest";
import {
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
});
