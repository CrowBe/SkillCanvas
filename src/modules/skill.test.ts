import { describe, expect, it } from "vitest";
import { analyzeLint, analyzeStructure } from "./analysis";
import { parseSkillMd, serializeSkillMd } from "./skill";

const RAW = `---
name: test-skill
description: Use when a user wants a deterministic test.
custom:
  nested: true
---

# Test skill

Run the workflow carefully.
`;

describe("SKILL.md source", () => {
  it("preserves unknown frontmatter through parse and serialize", () => {
    const parsed = parseSkillMd(RAW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.extra).toEqual({
      custom: { nested: true },
    });
    const reparsed = parseSkillMd(serializeSkillMd(parsed.value));
    expect(reparsed).toEqual(parsed);
  });

  it("rejects a frontmatter delimiter with trailing content", () => {
    const parsed = parseSkillMd(
      "---\nname: invalid\ndescription: Use when testing.\n---oops\n# Body",
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.code).toBe("invalid_skill");
  });

  it("emits stable lint rules and valid source spans", () => {
    const raw = RAW.replace("test-skill", "Test Skill");
    const lint = analyzeLint(raw);
    const finding = lint.findings.find(
      (item) => item.rule === "frontmatter.name-format",
    );
    expect(finding?.sourceSpan).toBeDefined();
    expect(
      raw.slice(finding!.sourceSpan!.start, finding!.sourceSpan!.end),
    ).toBe("Test Skill");
    expect(lint.rulesetVersion).toBe("skill-canvas-rules/1");
  });

  it("characterizes heading structure with source spans", () => {
    const structure = analyzeStructure(RAW);
    expect(structure.sections).toHaveLength(1);
    expect(
      RAW.slice(
        structure.sections[0]!.sourceSpan.start,
        structure.sections[0]!.sourceSpan.end,
      ),
    ).toBe("# Test skill");
  });
});
