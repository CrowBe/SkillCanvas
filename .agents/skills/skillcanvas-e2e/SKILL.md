---
name: skillcanvas-e2e
description: End-to-end WebMCP verification for the Skill Canvas workbench.
version: 0.1.0
author: Ben Barclay (CrowBe), Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [SkillCanvas, WebMCP, E2E, Playwright, Evals]
    related_skills: []
---

# Skill Canvas E2E Skill

Drives the Skill Canvas workbench (`CrowBe/SkillCanvas`) through its full
WebMCP tool surface in a real WebMCP-enabled Chromium and encodes the observed
contract as opt-in Playwright evals. Use it when verifying a WebMCP change
against the deployed workbench or a local build, or when re-recording the
tool-envelope contract after a Chrome update.

It does not replace the always-on lanes: unit tests (`npm test`) and the
fallback Playwright spec (`tests/browser/workbench.spec.ts`) must stay green
without WebMCP; this skill adds the native-surface pass on top.

## When to Use

- After changing any `src/modules/webmcp.ts` tool handler, envelope, or schema.
- After a Chrome channel update that may shift the `executeTool` wire format.
- Before cutting a release that advertises WebMCP support.
- Don't use for: routine UI checks (the default `chromium` Playwright project
  already covers the fallback path), or for verifying non-WebMCP behavior.

## Prerequisites

- Google Chrome (or Playwright Chromium) with the WebMCP feature: Chrome 151+
  verified. Playwright's `webmcp` project passes the required flags
  automatically (see `playwright.config.ts`).
- `WEBMCP_EVAL=1` in the environment — the evals skip without it.
- A secure origin: `https://` deployment or `http://127.0.0.1`/`localhost`.
- Node deps installed (`npm install`).

## How to Run

Through the `terminal` tool, from the repository root:

```bash
# Opt-in WebMCP evals (8 tests over the full 12-tool set)
WEBMCP_EVAL=1 npx playwright test tests/browser/webmcp-evals.spec.ts --project=webmcp

# Default always-green lane (evals skip; fallback flow + visual smokes)
npx playwright test --project=chromium

# Manual probe of a deployed origin in a dedicated WebMCP Chrome
google-chrome --user-data-dir=/tmp/webmcp-eval-profile \
  --remote-debugging-port=9222 --remote-allow-origins='*' \
  --enable-features=WebMCP --enable-blink-features=WebMCP \
  https://skillcanvas.skillcanvas.workers.dev
```

Completion criterion: `WEBMCP_EVAL=1` run reports `8 passed`, and the default
lane reports the evals as `skipped` with everything else `passed`.

## Quick Reference

- `executeTool(tool, JSON.stringify(input))` — Chrome 151 requires a JSON
  **string** second argument; a plain object rejects with `UnknownError`.
- Registered tools: `skill_open`, `skill_read`, `skill_update`,
  `skill_analyze`, `instruction_map_submit`, `evaluation_prepare`,
  `evaluation_submit`, `skill_compare`, `workspace_snapshot_export`,
  `workspace_snapshot_import`, `appearance_read`, `appearance_set`.
- Every envelope: `{protocolVersion: "skill-canvas/1", ok, workspaceId,
revision, contentHash, data?, error?}`.
- Full tool contract research: `docs/webmcp-research.md` in the repository.

## Procedure

1. **Verify the native surface.** Open the origin and feature-detect:
   `!!document.modelContext` and `window.isSecureContext` must both be true,
   and `getTools()` must list all 12 tools. Completion criterion: the app's
   top bar reads "WebMCP tools live".
2. **Run the eval suite.** `WEBMCP_EVAL=1 npx playwright test
tests/browser/webmcp-evals.spec.ts --project=webmcp`. Completion
   criterion: 8 passed with no retries needed.
3. **Read failures as contract drift, not flakiness.** A failing eval means
   the tool envelope diverged from the recorded behavior (or Chrome changed
   the wire). Diff the actual envelope against the expectation in the spec
   before changing either side. Completion criterion: the root cause is
   identified in app code or Chrome behavior, not guessed.
4. **Re-record after intentional changes.** If the envelope change is
   deliberate, update the eval expectations and the contract notes in
   `docs/webmcp-research.md` in the same commit. Completion criterion: evals
   pass and the docs match the observed wire.
5. **Confirm the default lane.** Run `npx playwright test --project=chromium`
   without `WEBMCP_EVAL` and confirm the evals skip. Completion criterion: no
   new failures; CI without WebMCP stays green.

## Pitfalls

- **Chrome 151 wire:** `executeTool` rejects plain-object inputs with a
  generic `UnknownError`. Always `JSON.stringify` the input. The workbench
  handler tolerates both wires, so this only bites at the `executeTool`
  call site.
- **Triggering evaluations are one case at a time.** A batched `cases` array
  returns `invalid_submission`. Submit `{kind: "triggering", caseId,
selectedChoiceId, rationale}` per case; each envelope returns the next case.
- **Instruction maps need exact shape.** `status: "proposed"`, a `scopes[]`
  array, `scopeId` on every requirement, and `sourceSpan` offsets that select
  non-empty text of the _current_ SKILL.md. Spans from an older revision are
  rejected.
- **Test-run contracts require `outputSchema`** inside the contract object.
  The tool input's optional `responseSchema` property is ignored by the
  validator despite being advertised.
- **Locator-based visibility checks can crash the target.** One observed
  Playwright locator poll ("WebMCP tools live" badge) killed the CDP session
  with `Internal server error, session closed` while a plain
  `page.evaluate` read of the same text worked. Prefer `page.evaluate` +
  `expect.poll` for assertions on WebMCP-enabled targets.
- **Headless-shell without the flags has no `document.modelContext`.** The
  evals then fail the availability poll rather than silently passing — that
  failure is the signal the launcher is wrong, not that the app regressed.

## Verification

- `WEBMCP_EVAL=1 npx playwright test tests/browser/webmcp-evals.spec.ts
  --project=webmcp` → 8 passed.
- `npx playwright test --project=chromium` → evals skipped, rest passed.
- `npm run typecheck && npm run lint && npm run format:check && npm test` →
  all clean (one pre-existing `App.tsx` exhaustive-deps warning is known).
- Traces from failing runs land in `test-results/webmcp-evals-*` and can be
  inspected with `npx playwright show-trace <path>`.

## Demo Recording (submission video)

The same tool flow doubles as the hackathon demo video recorder:
`node scripts/record-demo.mjs` from the repository root records the deployed
workbench (override with `DEMO_ORIGIN`) performing the full loop — load
example, agent-authored skill, analyze, instruction-map proposal, triggering
battery, mock test run with deterministic checks, revise, compare, re-analyze,
evidence-free export — at presentation pacing with on-screen panel switches.
Playwright's built-in `recordVideo` captures the browser content itself, so it
works on Wayland where desktop screen capture is portal-gated (GNOME's
Screenshot D-Bus API denies non-interactive callers and no
`gpu-screen-recorder`/`wf-recorder` is installed). Output:
`demo-output/skill-canvas-demo.webm` (~35-40 s at 1280x800; gitignored).
Add narration and music externally; the rules require a public YouTube video
under three minutes with audio.
