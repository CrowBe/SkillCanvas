import { describe, expect, it } from "vitest";
import { analyzeLint, analyzeStructure } from "./analysis";

const withFencedExample = [
  "---",
  "name: fenced-example-skill",
  "description: Use when the user wants an example output block rendered.",
  "---",
  "",
  "# Real section",
  "",
  "```md",
  "# Example output",
  "```",
  "",
  "## Second section",
  "",
].join("\n");

const blockScalarDescription = [
  "---",
  "name: block-scalar-skill",
  "description: >-",
  "  Reconciles quarterly ledger totals across every subsidiary",
  "  before the finance team closes the books.",
  "---",
  "",
  "# Ledger reconciliation",
  "",
  "Steps go here.",
].join("\n");

describe("analyzeStructure", () => {
  it("ignores headings inside fenced code blocks", () => {
    const structure = analyzeStructure(withFencedExample);
    expect(structure.sections.map((section) => section.title)).toEqual([
      "Real section",
      "Second section",
    ]);
    for (const section of structure.sections)
      expect(
        withFencedExample.slice(
          section.sourceSpan.start,
          section.sourceSpan.end,
        ),
      ).toContain(section.title);
  });

  it("does not treat an annotated fence line as a closing fence", () => {
    const raw = [
      "---",
      "name: fenced-example-skill",
      "description: Use when fenced examples need analysis.",
      "---",
      "",
      "```md",
      "```not-a-close",
      "# Still hidden",
      "```",
    ].join("\n");
    expect(analyzeStructure(raw).sections).toEqual([]);
    expect(
      analyzeLint(raw).findings.some((item) => item.rule === "body.structure"),
    ).toBe(true);
  });

  it("keeps frontmatter fence text out of body structure state", () => {
    const raw = [
      "---",
      "name: frontmatter-fence-skill",
      "description: |-",
      "  Use when frontmatter contains an example fence.",
      "  ```",
      "---",
      "",
      "# Workflow",
      "",
      "Do the work.",
    ].join("\n");
    const structure = analyzeStructure(raw);
    expect(structure.sections.map((section) => section.title)).toEqual([
      "Workflow",
    ]);
    expect(
      raw.slice(
        structure.sections[0]!.sourceSpan.start,
        structure.sections[0]!.sourceSpan.end,
      ),
    ).toBe("# Workflow");
  });

  it("uses the exact frontmatter delimiter for body headings", () => {
    const raw = [
      "---",
      "name: exact-boundary-skill",
      "description: Use when exact frontmatter boundaries matter.",
      "---oops: value",
      "# frontmatter text",
      "---",
      "",
      "# Workflow",
    ].join("\n");
    expect(
      analyzeStructure(raw).sections.map((section) => section.title),
    ).toEqual(["Workflow"]);
  });
});

describe("analyzeLint", () => {
  it("anchors block-scalar description findings to the frontmatter key", () => {
    const lint = analyzeLint(blockScalarDescription);
    const finding = lint.findings.find(
      (item) => item.rule === "frontmatter.description-trigger",
    );
    expect(finding).toBeDefined();
    expect(finding!.sourceSpan).toBeDefined();
    const span = finding!.sourceSpan!;
    expect(blockScalarDescription.slice(span.start, span.end)).toContain(
      "description: >-",
    );
    expect(blockScalarDescription.slice(span.start, span.end)).toContain(
      "closes the books.",
    );
  });
});
