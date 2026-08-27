# WebMCP implementation note

Researched 2026-08-27 from the current Web Machine Learning Community Group draft, its official repository, Chrome documentation, Chromium/WPT sources, and Chrome DevTools MCP documentation. WebMCP remains a **Draft Community Group Report**, not a W3C Standard, and Chrome describes it as an origin-trial/flagged feature that is still subject to change.

## Current API shape

The current normative entry point is `document.modelContext`, exposed only in secure contexts:

```webidl
partial interface Document {
  [SecureContext, SameObject] readonly attribute ModelContext modelContext;
};

interface ModelContext : EventTarget {
  Promise<undefined> registerTool(
    ModelContextTool tool,
    optional ModelContextRegisterToolOptions options = {}
  );
  Promise<sequence<RegisteredTool>> getTools(
    optional ModelContextGetToolOptions options = {}
  );
  Promise<DOMString> executeTool(
    RegisteredTool tool,
    optional object inputObject = {},
    optional ModelContextExecuteToolOptions options = {}
  );
  attribute EventHandler ontoolchange;
};
```

`navigator.modelContext` appears in the older August 2025 proposal and early Chrome examples, but Chrome's current imperative-API documentation says it is deprecated in Chrome 150 in favour of `document.modelContext`. New code should feature-detect `document.modelContext` only, behind a narrow adapter. Sources: [current draft, Document and ModelContext IDL](https://webmachinelearning.github.io/webmcp/#api), [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

The current imperative tool definition is:

```ts
type ModelContextTool = {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  execute(input: object, options: { signal: AbortSignal }): Promise<unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
};

await document.modelContext.registerTool(tool, {
  signal?: AbortSignal;
  exposedTo?: string[];
});
```

`name`, `description`, and `execute` are required by the draft IDL; `inputSchema`, `title`, and annotations are optional. A name is limited to 128 characters and ASCII alphanumerics plus `_`, `-`, and `.`. `exposedTo` selectively exposes a tool to secure cross-origin documents in the current tree. The callback's second argument is now an options object containing a cancellation signal, not the older proposal's general `agent` object. Sources: [current draft, `ModelContextTool` and callback](https://webmachinelearning.github.io/webmcp/#modelcontexttool-dictionary), [registration options](https://webmachinelearning.github.io/webmcp/#modelcontextregistertooloptions-dictionary).

## Registration and lifecycle

- `registerTool()` returns `Promise<undefined>`. Duplicate names reject with `InvalidStateError`; inactive documents, non-origin-keyed contexts, disabled `tools` permissions policy, invalid names/origins, an already-aborted registration signal, or a non-serializable schema also reject.
- Pass a dedicated `AbortController.signal` as the second argument. Aborting it unregisters that tool. This is the current cleanup mechanism and maps cleanly to a React effect cleanup and to a run-scoped mock tool.
- Registration/unregistration produces `toolchange`. There is no normative `updateTool()` method. For a changed schema or handler, abort the old registration and register again.
- The draft documents a race when a name is quickly unregistered and re-registered with a different schema: an invocation prepared against the old descriptor can reach the new registration. For a dynamic test-run mock, prefer a run-unique tool name or do not reuse the name until the old run is fully closed.
- A tool execution gets its own cancellation signal in `execute(input, { signal })`. An in-page caller may also cancel `executeTool(..., { signal })`.

Sources: [registration algorithm and teardown](https://webmachinelearning.github.io/webmcp/#dom-modelcontext-registertool), [execution callback options](https://webmachinelearning.github.io/webmcp/#toolexecutecallbackoptions-dictionary), [unregister/re-register race example](https://webmachinelearning.github.io/webmcp/#unregistration-execution-race), [Chrome unregister example](https://developer.chrome.com/docs/ai/webmcp/imperative-api#unregister-tools).

WebMCP is gated by the `tools` Permissions Policy, whose default allowlist is `self`. Top-level and same-origin frames therefore work by default; a cross-origin iframe needs `allow="tools"`. The document must also remain origin-keyed; explicitly opting out with `Origin-Agent-Cluster: ?0` disables the API. Sources: [current draft permissions-policy integration](https://webmachinelearning.github.io/webmcp/#permissions-policy), [Chrome security and permissions](https://developer.chrome.com/docs/ai/webmcp#security-and-permissions).

## Results, schemas, and streaming

The current draft does **not** prescribe MCP's `{ content: [...] }` result envelope. `execute` resolves with any JSON-serializable JavaScript value; the browser serializes it to JSON, and the in-page `executeTool()` API resolves to the resulting `DOMString`. Rejection or a value that cannot be serialized makes execution fail. Chrome's own examples return both plain strings and objects, so this workbench should return its proposed versioned JSON-compatible envelope as an application convention and should test that it is serializable. Source: [imperative execution serialization algorithm](https://webmachinelearning.github.io/webmcp/#imperative-execute-steps).

There is an `inputSchema` field described as JSON Schema, but no `outputSchema` member in the current `ModelContextTool` IDL. Native input/output validation, structured output schemas, streaming inputs/outputs, and progress reporting are all still tracked as open design questions. Therefore:

- validate all tool inputs in workbench code rather than relying on the browser;
- return one bounded, self-describing JSON-compatible result at completion;
- do not advertise `outputSchema`, streaming, or progress support;
- use the execution `AbortSignal` for cancellation and typed error envelopes for expected application failures.

Source: [official WebMCP repository, open questions](https://github.com/webmachinelearning/webmcp#open-questions). The normative draft contains no `outputSchema` or streaming member as of the research date.

## Chrome availability and setup

Chrome documents two current access paths:

1. **Local development:** in a compatible Chrome build, enable `chrome://flags/#enable-webmcp-testing` and relaunch. For the experimental WebMCP panel in Chrome 149 DevTools, also enable `chrome://flags/#devtools-webmcp-support`.
2. **Deployed origin:** enrol the origin in the WebMCP origin trial, available from Chrome 149, and serve its token before using the API. Chrome's generic origin-trial procedure supports either `<meta http-equiv="origin-trial" content="TOKEN">` in `<head>` or an `Origin-Trial: TOKEN` response header.

Sources: [Chrome WebMCP setup](https://developer.chrome.com/docs/ai/webmcp#get-started), [Chrome 149 DevTools WebMCP flags](https://developer.chrome.com/blog/new-in-devtools-149#webmcp), [WebMCP origin trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial), [origin-trial token setup](https://developer.chrome.com/docs/web-platform/origin-trials/).

Do not infer availability from the Chrome version alone: feature-detect at runtime and preserve the complete non-WebMCP UI path. The origin trial is time-limited, and the public Chrome Status page is JavaScript-rendered; this research did not obtain a reliable public end-milestone value. Treat exact trial expiry and channel coverage as deployment-time checks.

## Test feasibility and recommended verification lanes

Native browser testing is feasible, but it should be a separate, capability-gated lane:

1. **Always-on browser fallback test:** launch ordinary Playwright Chromium with no WebMCP flags and prove the UI completes the required workflow. Assert that absence of `document.modelContext` is non-fatal.
2. **Adapter contract tests:** inject a small fake `ModelContext` into the adapter tests to verify definitions, handler delegation, result envelopes, registration failures, and AbortController cleanup. This tests workbench behaviour, not browser conformance.
3. **Native in-page integration test:** when a compatible Chrome executable is explicitly configured with WebMCP enabled, serve the app from a trustworthy, origin-keyed local origin; assert `document.modelContext` exists; call `getTools()`; locate the tool; call `executeTool(registeredTool, input)`; parse the returned JSON string; then abort the registration and assert disappearance. This does not need a model and directly exercises the draft's public in-page API.
4. **Visiting-agent/inspector recipe:** Chrome DevTools MCP exposes experimental `list_webmcp_tools` and `execute_webmcp_tool` commands when its server is started with `--categoryExperimentalWebmcp`; the browser still needs `#enable-webmcp-testing`. Chrome DevTools itself can also inspect and manually execute tools when both browser flags above are enabled. Use this lane for the brief's discovery-and-invocation recipe, but report it as manual/environment-dependent unless it actually runs in CI.

The upstream Web Platform Tests already cover imperative registration, schemas, duplicate names, registration signals, `toolchange`, discovery, execution, aborts, permissions policy, and cross-origin exposure, which is evidence that a native conformance lane is technically viable. Sources: [WPT WebMCP imperative suite](https://github.com/web-platform-tests/wpt/tree/master/webmcp/imperative), [Chrome DevTools MCP WebMCP tools](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md#webmcp), [Chrome's agent-ready testing setup](https://developer.chrome.com/blog/agent-ready-toolkit#test-and-debug-your-website-with-chrome-devtools-for-agents).

### Smallest falsifier

Before claiming native WebMCP coverage, run this on the exact browser binary used by the test:

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

If any required method is not `"function"`, skip/fail the native lane with an explicit `webmcp-unavailable` reason and use the documented inspector/manual recipe. Do not claim that a mocked adapter test proves Chrome or a visiting agent can discover the tools.

## Remaining uncertainty

- The API is changing quickly: the authoritative draft was published 2026-08-26, while some official explainers and examples still preserve older shapes. Re-check the IDL and Chrome imperative guide immediately before release.
- Browser-agent discovery is implementation-defined; `getTools()` is explicitly intended for in-page agents, while a built-in browser agent uses an internal observation mechanism. Passing `getTools()` tests proves page registration/discovery, not that every visiting browser agent exposes those tools to its model.
- The specification and Chrome implementation can temporarily diverge. Pin the tested Chrome channel/version in any native test report and retain the runtime feature probe in production.
