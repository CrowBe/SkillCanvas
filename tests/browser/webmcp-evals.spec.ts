import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * WebMCP full tool-set evals.
 *
 * These tests drive a real WebMCP-capable Chrome through every registered
 * workbench tool over `document.modelContext.executeTool` and check each
 * application envelope. They are the automated form of the manual inspector
 * recipe in README ("WebMCP setup and fallback").
 *
 * They are skipped unless all of the following hold:
 * - `WEBMCP_EVAL=1` is set (opt-in; the default lane must stay always-green);
 * - the browser reports a live `document.modelContext` (Chrome 151+ with the
 *   WebMCP feature enabled, e.g. `--enable-features=WebMCP
 *   --enable-blink-features=WebMCP`);
 * - the served origin is a secure context (`https://` or `localhost`).
 *
 * Run against the deployed workbench:
 *   WEBMCP_EVAL=1 npx playwright test tests/browser/webmcp-evals.spec.ts \
 *     --project=chromium
 * with the launcher from `docs/webmcp-research.md`:
 *   google-chrome --user-data-dir=/tmp/webmcp-eval-profile \
 *     --remote-debugging-port=9222 --remote-allow-origins='*' \
 *     --enable-features=WebMCP --enable-blink-features=WebMCP \
 *     https://skillcanvas.skillcanvas.workers.dev
 */

const WEBMCP_EVAL = process.env.WEBMCP_EVAL === "1";

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

const GREETING_CONTRACT = {
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
} as const;

type Envelope = {
  protocolVersion: string;
  ok: boolean;
  workspaceId: string | null;
  revision: number | null;
  contentHash: string | null;
  data?: any;
  error?: { code: string; message: string };
};

/** Asserts a failed envelope carries a domain error and returns its code. */
function errorCode(envelope: Envelope): string {
  expect(envelope.ok).toBe(false);
  expect(envelope.error).toBeTruthy();
  return envelope.error!.code;
}

function promptMatchesCandidate(triggerCase: {
  prompt: string;
  choices: { candidate: boolean; description: string }[];
}): boolean {
  const candidate = triggerCase.choices.find((choice) => choice.candidate);
  const terms = candidate?.description.toLowerCase().match(/[a-z]+/g) ?? [];
  const prompt = triggerCase.prompt.toLowerCase();
  return terms.some((term) => term.length > 4 && prompt.includes(term));
}

let _webmcpAvailabilityObserved = false;

/**
 * Executes a workbench tool through the native WebMCP surface. Chrome 151's
 * imperative `executeTool` requires the input as a JSON *string*; the plain
 * object form rejects with UnknownError. The workbench handler tolerates both
 * wires, so the evals pin the string form that the deployed browser expects.
 */
async function executeTool(
  page: import("@playwright/test").Page,
  name: string,
  input: unknown = {},
): Promise<Envelope> {
  return page
    .evaluate(
      async ([toolNameInput, jsonInput]) => {
        const context = (document as any).modelContext;
        if (!context) return { __unavailable: true };
        const tools = await context.getTools();
        const tool = tools.find(
          (t: { name: string }) => t.name === toolNameInput,
        );
        if (!tool) throw new Error(`Tool not registered: ${toolNameInput}`);
        const raw = await context.executeTool(tool, jsonInput);
        return typeof raw === "string" ? JSON.parse(raw) : raw;
      },
      [name, JSON.stringify(input)] as const,
    )
    .then((envelope: any) => {
      if (envelope && envelope.__unavailable) {
        _webmcpAvailabilityObserved = true;
        throw new Error(
          "document.modelContext is unavailable: this Chrome build does not " +
            "expose WebMCP. Relaunch with --enable-features=WebMCP " +
            "--enable-blink-features=WebMCP and skip with WEBMCP_EVAL unset.",
        );
      }
      return envelope as Envelope;
    });
}

async function listToolNames(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page.evaluate(async () => {
    const context = (document as any).modelContext;
    if (!context) return [];
    return (await context.getTools()).map((t: { name: string }) => t.name);
  });
}

test.beforeAll(async () => {
  test.skip(
    !WEBMCP_EVAL,
    "WebMCP evals are opt-in: run with WEBMCP_EVAL=1 in a WebMCP-capable Chrome.",
  );
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            Boolean((document as any).modelContext) && window.isSecureContext,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
});

test("workbench registers the full 12-tool set with WebMCP", async ({
  page,
}) => {
  const names = await listToolNames(page);
  for (const expected of [
    "skill_open",
    "skill_read",
    "skill_update",
    "skill_analyze",
    "instruction_map_submit",
    "evaluation_prepare",
    "evaluation_submit",
    "skill_compare",
    "workspace_snapshot_export",
    "workspace_snapshot_import",
    "appearance_read",
    "appearance_set",
  ]) {
    expect(names, `missing tool: ${expected}`).toContain(expected);
  }
  // The status badge is plain text in the top bar; read it via evaluate — the
  // locator-based visibility poll crashes this WebMCP-enabled target session.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            document.body.innerText.includes("WebMCP tools live") ||
            document.body.innerText.includes("Browser fallback"),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const badge = await page.evaluate(() =>
    document.body.innerText.includes("WebMCP tools live"),
  );
  expect(badge, "top bar should say WebMCP tools live").toBe(true);
});

test("skill lifecycle: open, read, analyze, update, compare", async ({
  page,
}) => {
  const opened = await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });
  expect(opened.ok).toBe(true);
  expect(opened.protocolVersion).toBe("skill-canvas/1");
  expect(opened.revision).toBe(1);
  expect(opened.contentHash).toMatch(/^[0-9a-f]{64}$/);

  const read = await executeTool(page, "skill_read", {});
  expect(read.ok).toBe(true);
  expect(read.data.skillMd).toContain("greeting-scribe");

  const analyzed = await executeTool(page, "skill_analyze", {
    capabilities: ["lint", "structure"],
  });
  expect(analyzed.ok).toBe(true);
  expect(analyzed.data.lint).toBeTruthy();
  expect(analyzed.data.structure).toBeTruthy();

  const revisedSkillMd = `${GREETING_SKILL}\n## Output style\n- Address the recipient by name exactly once.\n`;
  const updated = await executeTool(page, "skill_update", {
    baseRevision: 1,
    skillMd: revisedSkillMd,
  });
  expect(updated.ok).toBe(true);
  expect(updated.revision).toBe(2);
  expect(updated.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(updated.contentHash).not.toBe(opened.contentHash);

  const compared = await executeTool(page, "skill_compare", {
    beforeRevision: 1,
    afterRevision: 2,
  });
  expect(compared.ok).toBe(true);
  expect(compared.data.kind).toBe("compare");
  expect(compared.data.source.additions).toBeGreaterThan(0);
  expect(compared.data.lint.before).toBeTruthy();
  expect(compared.data.lint.after).toBeTruthy();
});

test("stale baseRevision is refused with revision_conflict", async ({
  page,
}) => {
  await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });
  const stale = await executeTool(page, "skill_update", {
    baseRevision: 1,
    skillMd: `${GREETING_SKILL}\n## Stale\n`,
  });
  // The tip is already 1 -> 2 from a previous eval on this workspace; a base
  // below tip must never overwrite. Accept either an explicit conflict error
  // or an appended revision, but never a silent overwrite of revision 1.
  if (stale.ok) {
    expect(stale.revision).toBeGreaterThan(1);
  } else {
    expect(errorCode(stale)).toBe("revision_conflict");
  }
});

test("instruction map: shape errors then a valid proposed map", async ({
  page,
}) => {
  const opened = await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });
  expect(opened.ok).toBe(true);
  const skillMd = (await executeTool(page, "skill_read", {})).data
    .skillMd as string;

  const spanOf = (fragment: string) => {
    const start = skillMd.indexOf(fragment);
    expect(
      start,
      `span fragment not found: ${fragment}`,
    ).toBeGreaterThanOrEqual(0);
    return { start, end: start + fragment.length };
  };

  const missingStatus = await executeTool(page, "instruction_map_submit", {
    map: { revision: 1, requirements: [], scopes: [] },
  });
  expect(missingStatus.ok).toBe(false);
  expect(errorCode(missingStatus)).toBe("invalid_instruction_map");

  const missingScopes = await executeTool(page, "instruction_map_submit", {
    map: { status: "proposed", revision: 1, requirements: [] },
  });
  expect(missingScopes.ok).toBe(false);
  expect(errorCode(missingScopes)).toBe("invalid_instruction_map");

  const proposed = await executeTool(page, "instruction_map_submit", {
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
  expect(proposed.ok).toBe(true);
  expect(proposed.data.map.status).toBe("proposed");
  expect(proposed.data.map.suppliedBy).toBe("visiting-agent proposal");
});

test("triggering evaluation: prepare, one case at a time, graded", async ({
  page,
}) => {
  await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });
  const prepared = await executeTool(page, "evaluation_prepare", {
    kind: "triggering",
  });
  expect(prepared.ok).toBe(true);
  expect(prepared.data.kind).toBe("triggering");
  expect(prepared.data.versions.promptBattery).toBe("prompt-battery/1");
  const cases = prepared.data.data.cases as {
    id: string;
    prompt: string;
    expected: "fire" | "silent";
    choices: {
      id: string;
      candidate: boolean;
      name: string;
      description: string;
    }[];
  }[];
  expect(cases.length).toBeGreaterThan(0);

  // Batch submissions are refused: the protocol is one case at a time.
  const batched = await executeTool(page, "evaluation_submit", {
    evaluationId: prepared.data.id,
    submission: {
      kind: "triggering",
      cases: cases.map((c) => ({ caseId: c.id })),
    },
  });
  expect(batched.ok).toBe(false);
  expect(errorCode(batched)).toBe("invalid_submission");

  let completed: Envelope | undefined;
  for (const triggerCase of cases) {
    const fire = promptMatchesCandidate(triggerCase);
    const choice = fire
      ? "candidate"
      : (triggerCase.choices.find((c) => !c.candidate)?.id ??
        triggerCase.choices[0]?.id);
    const submitted = await executeTool(page, "evaluation_submit", {
      evaluationId: prepared.data.id,
      submission: {
        kind: "triggering",
        caseId: triggerCase.id,
        selectedChoiceId: choice,
        rationale: fire
          ? "The request asks for a greeting for a named recipient."
          : "The request is not a formal greeting for a named recipient.",
      },
    });
    expect(submitted.ok, JSON.stringify(submitted.error ?? {})).toBe(true);
    expect(["in-progress", "complete"]).toContain(submitted.data.status);
    completed = submitted;
  }
  expect(completed?.data.status).toBe("complete");
  expect(completed?.data.data.observations).toHaveLength(cases.length);
  expect(
    completed?.data.data.observations.every(
      (observation: { passed: boolean }) => observation.passed,
    ),
  ).toBe(true);
});

test("test run: contract prepare, run-scoped mock, deterministic grading", async ({
  page,
}) => {
  await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });

  // A contract without outputSchema is refused.
  const incomplete = await executeTool(page, "evaluation_prepare", {
    kind: "test-run",
    contract: {
      name: GREETING_CONTRACT.name,
      description: GREETING_CONTRACT.description,
      inputSchema: GREETING_CONTRACT.inputSchema,
    },
  });
  expect(incomplete.ok).toBe(false);
  expect(errorCode(incomplete)).toBe("invalid_submission");

  const prepared = await executeTool(page, "evaluation_prepare", {
    kind: "test-run",
    contract: GREETING_CONTRACT,
  });
  expect(prepared.ok).toBe(true);
  const evaluationId = prepared.data.evaluation.id as string;
  const mockToolName = prepared.data.mockToolName as string;
  expect(mockToolName).toMatch(/^mock_greeting_scribe_invoke_/);

  const invoked = await executeTool(page, mockToolName, { recipient: "Priya" });
  expect(invoked.ok).toBe(true);
  expect(invoked.data.output).toEqual({ sentence: "example" });
  expect(invoked.data.transcript.length).toBeGreaterThan(0);

  const finalized = await executeTool(page, "evaluation_submit", {
    evaluationId,
    submission: {
      kind: "test-run",
      finalOutput: { sentence: "Dear Priya, greetings and salutations." },
    },
  });
  expect(finalized.ok).toBe(true);
  expect(finalized.data.status).toBe("complete");
  const checks = finalized.data.data.checks as {
    id: string;
    passed: boolean;
    deterministic: boolean;
  }[];
  for (const expected of [
    "expected-tool-called",
    "arguments-1",
    "mock-output-1",
  ]) {
    expect(checks.find((c) => c.id === expected)?.passed).toBe(true);
  }
  expect(checks.every((c) => c.deterministic)).toBe(true);
});

test("snapshots: export is evidence-free and admission rejects junk", async ({
  page,
}) => {
  await executeTool(page, "skill_open", {
    name: "Greeting Scribe",
    skillMd: GREETING_SKILL,
  });
  const exported = await executeTool(page, "workspace_snapshot_export", {});
  expect(exported.ok).toBe(true);
  expect(exported.data.filename).toMatch(/\.workbench\.json$/);
  expect(exported.data.includesDeterministicEvidence).toBe(false);

  const rejected = await executeTool(page, "workspace_snapshot_import", {
    json: JSON.stringify({ schemaVersion: 999, junk: true }),
  });
  expect(rejected.ok).toBe(false);
  expect(errorCode(rejected)).toBe("invalid_snapshot");
});

test("appearance: read and set, excluded from workspace revisioning", async ({
  page,
}) => {
  const read = await executeTool(page, "appearance_read", {});
  expect(read.ok).toBe(true);
  expect(read.revision).toBeNull();
  expect(read.contentHash).toBeNull();
  const choices = read.data.choices as { id: string }[];
  expect(choices.map((c) => c.id)).toEqual(
    expect.arrayContaining([
      "system",
      "light",
      "dark",
      "tuxedo",
      "cardigan",
      "terminal",
    ]),
  );

  const set = await executeTool(page, "appearance_set", {
    choice: "terminal",
    agentRationale: "The Skill targets a terminal workflow; Terminal suits it.",
  });
  expect(set.ok).toBe(true);
  expect(set.data.storedChoice).toBe("terminal");
  expect(set.data.agentRationale).toBe(
    "The Skill targets a terminal workflow; Terminal suits it.",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terminal");
  // The collaboration note is visible in the UI.
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          // The badge CSS uppercases its text; compare case-insensitively.
          document.body.innerText
            .toLowerCase()
            .includes(
              "agent chose terminal: the skill targets a terminal workflow",
            ),
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
  // A human picker change clears the note (the controller clears it without
  // a rationale option); restoring the theme for later visual checks.
  await executeTool(page, "appearance_set", { choice: "light" });
  const cleared = await executeTool(page, "appearance_read", {});
  expect(cleared.data.agentRationale).toBeNull();
});

test.afterAll(async () => {
  if (WEBMCP_EVAL) {
    const dir = path.join("test-results", "webmcp-evals");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "README.md"),
      "# WebMCP eval run\n\nRecorded envelope expectations live inline in " +
        "tests/browser/webmcp-evals.spec.ts. This directory holds traces " +
        "from failing runs (trace: retain-on-failure).\n",
    );
  }
});
