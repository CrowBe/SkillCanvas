# Skill Canvas

Skill Canvas is a proof-of-concept, browser-based Agent Skills workbench for the OpenAI WebMCP hackathon. Its thesis is that Skills are high-value but low-visibility: they strongly shape an agent's behavior, yet imported and default Skills often remain invisible while the agent works. That makes basic questions surprisingly hard: What does this Skill do? Is it good? Which instructions are active? What changed when I edited it?

The user brings a browser agent: the agent supplies inference and semantic judgment; the deployed website makes the Skill legible. It renders intent, visualizes structural anatomy, lints deterministic properties, breaks an accepted semantic map into an instruction-load vector, records observed evaluations, compares revisions, and exports the standard-native artifact. These are multiple angles on understanding and improving the same Skill, not a single opaque quality score.

There are no accounts, provider keys, server-side model gateway, teams, publishing flow, or whole-agent configuration. The static app remains fully useful when WebMCP is unavailable. IndexedDB is the current deployment-friendly persistence adapter, and the welcome screen lists workspaces saved in the current browser profile so they remain reachable after a session ends. This is not a claim that the product must remain local-first.

## Run it

```bash
npm install
npm run dev
```

Production output is a static `dist/` directory:

```bash
npm run build
```

Deploy `dist/` to any HTTPS static host. For a deployed WebMCP origin, enrol that exact origin in Chrome's WebMCP origin trial and serve the issued token through an `Origin-Trial` response header or an equivalent `<meta http-equiv="origin-trial">` tag. Keep the runtime feature check: origin-trial availability is temporary and browser-specific.

## Product loop

1. Create an empty Skill or import a bounded `SKILL.md` plus reference files.
2. Read the Rendered view and Skill anatomy first; jump from structural or lint findings to the exact Source-span.
3. Ask what it does, whether its deterministic properties are sound, and where complexity comes from before editing.
4. Save a full-source replacement against `baseRevision`. A stale base returns `revision_conflict`; it never overwrites silently.
5. Validate a visiting-agent instruction-map proposal and inspect its multidimensional load vector.
6. Prepare a triggering evaluation one case at a time, or a mocked test run driven by one Tool contract and optional Response schema.
7. Compare revisions and export either:
   - a standard-native zip containing only `SKILL.md` and references; or
   - a versioned workbench snapshot containing revisions, accepted maps, local evidence, and audit events.
8. Restore an evidence-free workbench snapshot from the welcome screen, history panel, or `workspace_snapshot_import` WebMCP tool. Snapshots containing evaluation or comparison evidence are rejected; import the Skill and references without that evidence and regenerate it locally.

## Architecture

Both React and WebMCP call the same `WorkspaceService`. It owns validation, revisioning, artifact computation, evaluation protocols, comparison, and export. `WorkspaceStore` is the persistence port beneath it, with IndexedDB and memory adapters. WebMCP is a thin outer adapter and has no domain behavior of its own.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module contract, artifact envelopes, trust boundaries, evaluation sequence, and deferred scope. Current-draft WebMCP research and primary-source links are in [docs/webmcp-research.md](docs/webmcp-research.md).

## WebMCP setup and fallback

The current implementation feature-detects `document.modelContext`, then awaits:

```ts
document.modelContext.registerTool(tool, { signal: controller.signal });
```

Aborting the controller unregisters the tools. Every execution returns one JSON-compatible application envelope:

```ts
{
  protocolVersion: "skill-canvas/1",
  ok: true,
  workspaceId,
  revision,
  contentHash,
  data
}
```

It does not advertise `outputSchema`, streaming, native schema validation, or progress because those remain unsettled in the current draft. Tool inputs are validated by workbench code.

For local Chrome testing:

1. Enable `chrome://flags/#enable-webmcp-testing`, then relaunch Chrome.
2. To use the experimental DevTools WebMCP panel, also enable `chrome://flags/#devtools-webmcp-support`.
3. Open the app from a trustworthy origin (`http://localhost` is suitable for local testing).
4. Confirm the top bar says **WebMCP tools live**. Without support it says **Browser fallback** and all human UI paths continue to work.

### Manual inspector recipe

Run this falsifier in the exact browser build being tested:

```js
({
  secure: window.isSecureContext,
  originKeyed: window.originAgentCluster,
  modelContext: typeof document.modelContext,
  registerTool: typeof document.modelContext?.registerTool,
  getTools: typeof document.modelContext?.getTools,
  executeTool: typeof document.modelContext?.executeTool,
});
```

Then use the DevTools WebMCP panel to discover `skill_open`, `skill_analyze`, `skill_update`, `evaluation_prepare`, and `evaluation_submit`. Complete:

1. `skill_open({ skillMd })`
2. `skill_analyze({ capabilities: ["lint", "structure"] })`
3. `skill_update({ baseRevision: 1, skillMd: revisedSource })`
4. `evaluation_prepare({ kind: "triggering" })`
5. For each returned case, `evaluation_submit({ evaluationId, submission: { caseId, selectedChoiceId, rationale } })`

The Chrome DevTools MCP server can instead expose `list_webmcp_tools` and `execute_webmcp_tool` when started with `--categoryExperimentalWebmcp`. This recipe is environment-dependent and is not counted as an automated browser pass unless run against a compatible Chrome binary.

## Trust model

- Imported content is data only. It is bounded, path-normalized, content-addressed, and never executed.
- Unknown YAML frontmatter is preserved.
- Immutable Skill/reference blobs deduplicate by byte-exact SHA-256.
- Revision, artifact, evaluation, and audit records point to hashes and carry explicit versions.
- Skill mutations require `baseRevision`, append an audit event, visibly update the UI, and remain reversible by adding a later revision.
- `appearance_set` is a visible browser preference. It never changes a Skill revision, content hash, evaluation artifact, snapshot, or Skill export.
- Instruction decomposition, trigger choices, rationales, model/browser identity, latency, and outputs are agent-supplied evidence. Deterministic validation and grading are reported separately.
- A triggering result is labelled as observed from the visiting browser agent. It is not runtime-portability proof.

## Verification

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
npm run test:browser
```

The always-on Playwright path deliberately runs without WebMCP and completes load → lint → revise → compare → export. Adapter tests inject a fake `ModelContext` to verify tool registration, shared-service parity, envelopes, and AbortController cleanup. Native WebMCP discovery remains the explicit recipe above unless a compatible Chrome binary is supplied.

## Reference behavior inventory

Selectively ported from the read-only `agent.branch` reference:

- `SKILL.md` YAML/body parsing with unknown-frontmatter preservation;
- Rendered/Source duality and Source-span character offsets;
- stable lint rule ids, severities, scores/grades, policy-oriented findings, and a versioned ruleset;
- the deterministic prompt-battery fallback and static distractor-library shape;
- schema-derived mock outputs, transcript-based contract checks, and the Mock-tool registry concept;
- warm-pro semantic color/look tokens for light, dark, tuxedo, cardigan, and terminal.

Adapted for this browser-agent proof:

- the skill-analysis seam becomes one deep `WorkspaceService` shared by React and WebMCP;
- model-backed triggering is split into prepare/submit so the visiting browser agent performs selection;
- test runs register a run-scoped mock through WebMCP when available and retain a visible manual invocation fallback;
- hosted persistence uses browser IndexedDB rather than server persistence;
- exported workbench snapshots retain local evidence separately from the standard-native Skill export, while snapshot admission rejects evaluation and comparison evidence that cannot cross the local trust boundary.

Deliberately not copied:

- the server, auth, database, usage/accounting, provider/model routing, model gateway, publishing, teams, product-wide generic machinery, and whole-agent configuration;
- model-generated prompt batteries, Insights, semantic instruction extraction, and any provider-backed execution;
- a scalar claim that a model can follow _N_ real Skill instructions. The vector is primary; the optional capacity probe is deferred until accepted-map UX is proven.

## Known limitations

- IndexedDB data is origin- and browser-profile-specific. Bounded evidence-free snapshots can move Skill content, references, revisions, and accepted maps; evaluation and comparison evidence must be regenerated locally.
- The parser preserves unknown frontmatter values semantically; YAML comments and original formatting are not preserved after serialization.
- The JSON Schema checker intentionally implements a small deterministic subset (`type`, `required`, `properties`, `items`, `enum`, `default`).
- Source diff metadata is line-oriented rather than a full syntax-aware diff; pathological large regions are bounded and explicitly marked approximate.
- Native WebMCP support is experimental and can diverge between the draft, Chrome channel, origin trial, DevTools, and browser-agent discovery behavior.
