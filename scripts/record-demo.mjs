/**
 * Skill Canvas demo recording for the WebMCP hackathon submission.
 *
 * Records a <3 minute narrated-action walkthrough of the deployed workbench
 * driven through the native WebMCP tool surface — the same flow as
 * tests/browser/webmcp-evals.spec.ts, at presentation pacing, with Playwright's
 * built-in video capture (works on Wayland where desktop screen capture is
 * portal-gated).
 *
 * Run from the repository root:
 *   node scripts/record-demo.mjs
 * Output: ./demo-output/skill-canvas-demo.webm
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const ORIGIN =
  process.env.DEMO_ORIGIN ?? "https://skillcanvas.skillcanvas.workers.dev";

const GREETING_SKILL = `---
name: greeting-scribe
description: Writes short formal greetings for named recipients. Use when a user asks for a polite opening line.
---

# Greeting Scribe

## Purpose
Produce a one-sentence formal greeting for a given recipient name.

## Procedure
1. Read the recipient name from the request.
2. Output exactly one sentence of the form: "Dear {name}, greetings and salutations."
3. If no name is provided, ask for one before writing anything.

## Constraints
- Never add emoji.
- Never exceed one sentence.
`;

const CONTRACT = {
  name: "greeting_scribe_invoke",
  description: "Generates a formal greeting sentence for a recipient.",
  inputSchema: {
    type: "object",
    required: ["recipient"],
    properties: { recipient: { type: "string" } },
  },
  outputSchema: {
    type: "object",
    required: ["sentence"],
    properties: { sentence: { type: "string" } },
  },
};

async function executeTool(page, name, input = {}) {
  return page.evaluate(
    async ([toolName, jsonInput]) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((t) => t.name === toolName);
      const raw = await document.modelContext.executeTool(tool, jsonInput);
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    },
    [name, JSON.stringify(input)],
  );
}

/** Lets a viewer read what just happened. */
const beat = (page, ms = 2200) => page.waitForTimeout(ms);

mkdirSync("demo-output", { recursive: true });

const browser = await chromium.launch({
  args: ["--enable-features=WebMCP", "--enable-blink-features=WebMCP"],
  viewport: { width: 1280, height: 800 },
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: "demo-output", size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

// 1. Landing — the pitch
await page.goto(ORIGIN);
await page.waitForTimeout(3500);

// 2. Load the example Skill in the UI so the human-visible path is on record
await page.getByTestId("load-sample").click();
await page.waitForTimeout(3000);

// 3. WebMCP: register + discover the 12 tools
const toolNames = await page.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name),
);
console.log("registered:", toolNames.length, "tools");

// 4. Agent authors a Skill through skill_open
await executeTool(page, "skill_open", {
  name: "Greeting Scribe",
  skillMd: GREETING_SKILL,
});
await beat(page, 2500);

// 5. Deterministic analysis
const analyzed = await executeTool(page, "skill_analyze", {
  capabilities: ["lint", "structure"],
});
console.log("lint score:", analyzed.data?.lint?.score ?? "?");
await beat(page, 2000);

// Camera: show the Map panel while the proposal lands
await page.getByRole("button", { name: "Map" }).click();
await beat(page, 1200);

// 6. Instruction map proposal from the visiting agent
const skillMd = (await executeTool(page, "skill_read", {})).data.skillMd;
const spanOf = (frag) => {
  const start = skillMd.indexOf(frag);
  return { start, end: start + frag.length };
};
await executeTool(page, "instruction_map_submit", {
  accept: false,
  map: {
    status: "proposed",
    revision: 1,
    scopes: [
      { id: "scope-procedure", label: "Procedure" },
      { id: "scope-constraints", label: "Constraints" },
    ],
    requirements: [
      {
        id: "req-read-name",
        sourceSpan: spanOf("Read the recipient name from the request."),
        statement: "Read the recipient name from the request.",
        kind: "action",
        scopeId: "scope-procedure",
        dependencies: [],
        verifiability: "deterministic",
      },
      {
        id: "req-one-sentence",
        sourceSpan: spanOf("Output exactly one sentence of the form"),
        statement: "Output exactly one sentence of the required form.",
        kind: "action",
        scopeId: "scope-procedure",
        dependencies: ["req-read-name"],
        verifiability: "deterministic",
      },
      {
        id: "req-no-emoji",
        sourceSpan: spanOf("Never add emoji."),
        statement: "Never add emoji.",
        kind: "prohibition",
        scopeId: "scope-constraints",
        dependencies: [],
        verifiability: "deterministic",
      },
    ],
  },
});
await beat(page, 2500);

// 7. Triggering evaluation: the agent answers the prompt battery
await page.getByRole("button", { name: "Evals" }).click();
await beat(page, 1200);
const prepared = await executeTool(page, "evaluation_prepare", {
  kind: "triggering",
});
for (const c of prepared.data.data.cases) {
  const fire = ["greeting", "salutation", "opening line", "polite"].some((w) =>
    c.prompt.toLowerCase().includes(w),
  );
  const choice = fire
    ? "candidate"
    : (c.choices.find((ch) => !ch.candidate)?.id ?? c.choices[0].id);
  await executeTool(page, "evaluation_submit", {
    evaluationId: prepared.data.id,
    submission: {
      kind: "triggering",
      caseId: c.id,
      selectedChoiceId: choice,
      rationale: fire
        ? "The request asks for a greeting for a named recipient."
        : "The request is not a formal greeting for a named recipient.",
    },
  });
  await page.waitForTimeout(900);
}
await beat(page, 2500);

// 8. Test run: mock tool registered, invoked, graded
const run = await executeTool(page, "evaluation_prepare", {
  kind: "test-run",
  contract: CONTRACT,
});
await executeTool(page, run.data.mockToolName, { recipient: "Priya" });
await executeTool(page, "evaluation_submit", {
  evaluationId: run.data.evaluation.id,
  submission: {
    kind: "test-run",
    finalOutput: { sentence: "Dear Priya, greetings and salutations." },
  },
});
await beat(page, 3000);

// 9. Revise + compare
const updated = await executeTool(page, "skill_update", {
  baseRevision: 1,
  skillMd: `${GREETING_SKILL}\n## Output style\n- Address the recipient by name exactly once.\n`,
});
await page.getByRole("button", { name: "Compare" }).first().click();
await executeTool(page, "skill_compare", {
  beforeRevision: 1,
  afterRevision: updated.revision,
});
await beat(page, 3000);

// 10. Re-analyze the new tip, then export evidence-free
await page.getByRole("button", { name: "Lint" }).click();
await executeTool(page, "skill_analyze", {
  capabilities: ["lint", "structure"],
});
await beat(page, 2000);
await executeTool(page, "workspace_snapshot_export", {});
await beat(page, 2500);

// 11. The environment seam: the agent picks a theme and explains itself
await executeTool(page, "appearance_set", {
  choice: "terminal",
  agentRationale: "The Skill targets a terminal workflow; Terminal suits it.",
});
// Hold long enough that the collaboration badge reads on video.
await beat(page, 5000);
// Hand the workspace back: a human override clears the agent's note.
await executeTool(page, "appearance_set", { choice: "light" });
await beat(page, 1500);

// Close slowly so the final frame holds
await page.waitForTimeout(1500);
await page.close();
await context.close();
await browser.close();
console.log("recorded demo-output/*.webm");
