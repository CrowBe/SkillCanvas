import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  createBrowserAppearanceController,
  type AppearanceState,
} from "./modules/appearance";
import { parseSkillMd } from "./modules/skill";
import { type LintArtifact, type StructureArtifact } from "./modules/analysis";
import {
  type InstructionLoadVector,
  type InstructionMap,
} from "./modules/instruction-map";
import { type ToolContract } from "./modules/evaluations";
import { IndexedDbWorkspaceStore } from "./modules/workspace/indexeddb-store";
import {
  createWorkspaceService,
  type WorkspaceService,
} from "./modules/workspace/service";
import { type CompareArtifact } from "./modules/workspace/artifacts";
import {
  evaluationView,
  workspaceView,
  type EvaluationView,
} from "./modules/workspace/view";
import type {
  EvaluationRecord,
  WorkspaceBundle,
  WorkspaceRecord,
} from "./modules/workspace/types";
import {
  REFERENCE_MAX_BYTES,
  REFERENCES_MAX,
  SKILL_MAX_BYTES,
  SNAPSHOT_MAX_BYTES,
} from "./modules/shared";
import {
  registerWebMcpTools,
  type MockRegistrationStatus,
} from "./modules/webmcp";

const store = new IndexedDbWorkspaceStore();
const service = createWorkspaceService(store);
const appearance = createBrowserAppearanceController();
let webMcpMountChain: Promise<unknown> = Promise.resolve();
const instructionMapDraft = (revision: number) =>
  JSON.stringify(
    {
      revision,
      suppliedBy: "visiting-agent proposal",
      status: "proposed",
      scopes: [{ id: "root", label: "Whole Skill" }],
      requirements: [],
    },
    null,
    2,
  );
const SAMPLE_SKILL = `---
name: customer-feedback-brief
description: Use when the user wants customer feedback grouped into themes and actions.
version: 0.1.0
---

# Customer feedback brief

## Workflow

1. Read the supplied feedback and group recurring themes.
2. Separate complaints, praise, and feature requests.
3. Rank themes by frequency and propose one action for each.

## Constraints

- Preserve the customer's meaning.
- Do not invent counts when the source has none.
- Keep direct quotes short and anonymous.
`;
const SAMPLE_CONTRACT: ToolContract = {
  name: "read_feedback",
  description: "Returns mocked customer feedback for the test run.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer" } },
    required: ["limit"],
  },
  outputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    },
    required: ["items"],
  },
  mockOutput: {
    items: [
      { text: "Checkout was confusing." },
      { text: "Support answered quickly." },
    ],
  },
};
const RESPONSE_SCHEMA = {
  type: "object",
  properties: { themes: { type: "array", items: { type: "string" } } },
  required: ["themes"],
} as const;

async function readExactUtf8(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  )
    throw new Error(`${file.name} uses an unsupported UTF-8 byte-order mark.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${file.name} is not valid UTF-8.`);
  }
  const encoded = new TextEncoder().encode(text);
  if (
    encoded.length !== bytes.length ||
    encoded.some((byte, index) => byte !== bytes[index])
  )
    throw new Error(`${file.name} cannot be imported byte-exactly.`);
  return text;
}

export function App({
  workspaceService = service,
}: {
  workspaceService?: WorkspaceService;
} = {}) {
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>([]);
  const [source, setSource] = useState("");
  const [view, setView] = useState<"rendered" | "source">(
    (localStorage.getItem("skill-canvas:view") as any) || "rendered",
  );
  const [lint, setLint] = useState<LintArtifact | null>(null);
  const [structure, setStructure] = useState<StructureArtifact | null>(null);
  const [instructionVector, setInstructionVector] =
    useState<InstructionLoadVector | null>(null);
  const [instructionMap, setInstructionMap] = useState<InstructionMap | null>(
    null,
  );
  const [compare, setCompare] = useState<CompareArtifact | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationView | null>(null);
  const [mockRegistrations, setMockRegistrations] = useState<
    Readonly<Record<string, MockRegistrationStatus>>
  >({});
  const [status, setStatus] = useState("Ready");
  const [webMcp, setWebMcp] = useState<"checking" | "available" | "fallback">(
    "checking",
  );
  const [appearanceState, setAppearanceState] = useState<AppearanceState>(() =>
    appearance.readState(),
  );
  // WebMCP appearance changes can land between first render and the
  // subscription effect (the visiting agent does not wait for hydration).
  // Resync once the subscription is in place so a missed change event
  // cannot leave a stale badge or theme in the UI.
  useEffect(() => {
    setAppearanceState(appearance.readState());
    return appearance.subscribe(setAppearanceState);
  }, []);
  const [instructionJson, setInstructionJson] = useState(
    instructionMapDraft(1),
  );
  const [rationale, setRationale] = useState("");
  const [selectedChoice, setSelectedChoice] = useState("");
  const [finalOutput, setFinalOutput] = useState(
    '{"themes":["Checkout","Support"]}',
  );
  const [panel, setPanel] = useState<
    "lint" | "evaluate" | "instructions" | "history"
  >("lint");
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const registrationRef = useRef<Awaited<
    ReturnType<typeof registerWebMcpTools>
  > | null>(null);
  const loadedEvaluationsRef = useRef<readonly EvaluationRecord[]>([]);
  const loadedWorkspaceIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const currentId = sessionStorage.getItem("skill-canvas:open-workspace");
    workspaceService
      .list()
      .then((records) => {
        if (!cancelled) setWorkspaces(records);
      })
      .catch((error) => {
        if (!cancelled)
          setStatus(`Workspace recovery failed: ${message(error)}`);
      });
    if (currentId)
      workspaceService
        .open(currentId)
        .then((result) => {
          if (!cancelled && result.ok) loadBundle(result.value);
        })
        .catch((error) => {
          if (!cancelled)
            setStatus(`Workspace recovery failed: ${message(error)}`);
        });
    const selection = {
      get: () => sessionStorage.getItem("skill-canvas:open-workspace"),
      set: (id: string) =>
        sessionStorage.setItem("skill-canvas:open-workspace", id),
    };
    const mount = webMcpMountChain.then(async () => {
      if (cancelled) return;
      const registration = await registerWebMcpTools(document.modelContext, {
        service: workspaceService,
        appearance,
        selection,
        onWorkspaceChange: loadBundle,
        onMockRegistrationChange: (evaluationId, nextStatus) =>
          setMockRegistrations((current) => ({
            ...current,
            [evaluationId]: nextStatus,
          })),
        download,
      });
      if (cancelled) {
        registration.dispose();
        await Promise.resolve();
        return;
      }
      registrationRef.current = registration;
      registration.reconcileMockRegistrations(
        loadedWorkspaceIdRef.current,
        loadedEvaluationsRef.current,
      );
      setWebMcp(registration.available ? "available" : "fallback");
    });
    webMcpMountChain = mount.catch(() => undefined);
    mount.catch((error) => {
      if (cancelled) return;
      setWebMcp("fallback");
      setStatus(`WebMCP registration failed: ${message(error)}`);
    });
    return () => {
      cancelled = true;
      registrationRef.current?.dispose();
      registrationRef.current = null;
      webMcpMountChain = webMcpMountChain.then(async () => {
        await Promise.resolve();
      });
    };
  }, []);

  function loadBundle(next: WorkspaceBundle) {
    loadedEvaluationsRef.current = next.evaluations;
    loadedWorkspaceIdRef.current = next.workspace.id;
    registrationRef.current?.reconcileMockRegistrations(
      next.workspace.id,
      next.evaluations,
    );
    sessionStorage.setItem("skill-canvas:open-workspace", next.workspace.id);
    setBundle(next);
    setWorkspaces((current) => [
      next.workspace,
      ...current.filter((workspace) => workspace.id !== next.workspace.id),
    ]);
    setSource(next.skillMd);
    const projection = workspaceView(next);
    setLint(projection.lint);
    setStructure(projection.structure);
    setInstructionVector(projection.instructionLoad);
    setInstructionMap(projection.instructionMap);
    setInstructionJson(
      projection.instructionMap
        ? JSON.stringify(projection.instructionMap, null, 2)
        : instructionMapDraft(next.revision.revision),
    );
    setCompare(projection.compare);
    setEvaluation(projection.evaluation);
    setStatus(`Revision ${next.revision.revision} loaded`);
  }
  async function create(skillMd = SAMPLE_SKILL) {
    const result = await workspaceService.create({
      name: "Skill Canvas demo",
      skillMd,
      actor: "human",
    });
    if (result.ok) loadBundle(result.value);
    else setStatus(result.error.message);
  }
  async function openWorkspace(workspaceId: string) {
    const result = await workspaceService.open(workspaceId);
    if (result.ok) loadBundle(result.value);
    else setStatus(result.error.message);
  }
  async function createFromFiles(files: readonly File[]) {
    if (files.length > REFERENCES_MAX + 1) {
      setStatus(
        `Import at most one SKILL.md and ${REFERENCES_MAX} reference files.`,
      );
      return;
    }
    const skillFiles = files.filter(
      (file) =>
        (file.webkitRelativePath || file.name)
          .split("/")
          .at(-1)
          ?.toLowerCase() === "skill.md",
    );
    if (skillFiles.length !== 1) {
      setStatus("Import exactly one SKILL.md with its reference files.");
      return;
    }
    const skillFile = skillFiles[0]!;
    if (skillFile.size > SKILL_MAX_BYTES) {
      setStatus(`SKILL.md exceeds ${SKILL_MAX_BYTES} bytes.`);
      return;
    }
    const oversizedReference = files.find(
      (file) => file !== skillFile && file.size > REFERENCE_MAX_BYTES,
    );
    if (oversizedReference) {
      setStatus(
        `${oversizedReference.name} exceeds ${REFERENCE_MAX_BYTES} bytes.`,
      );
      return;
    }
    const selectedBytes = files.reduce((total, file) => total + file.size, 0);
    if (selectedBytes > SNAPSHOT_MAX_BYTES) {
      setStatus(`Selected files exceed ${SNAPSHOT_MAX_BYTES} bytes.`);
      return;
    }
    const entries: { path: string; content: string }[] = [];
    for (const file of files)
      entries.push({
        path: file.webkitRelativePath || file.name,
        content: await readExactUtf8(file),
      });
    const skill = entries[files.indexOf(skillFile)]!;
    const root = skill.path.slice(0, -"SKILL.md".length);
    const references = entries
      .filter((entry) => entry !== skill && entry.path.startsWith(root))
      .map((entry) => ({
        path: entry.path.slice(root.length),
        content: entry.content,
      }));
    const result = await workspaceService.create({
      skillMd: skill.content,
      referenceFiles: references,
      actor: "human",
    });
    if (result.ok) loadBundle(result.value);
    else setStatus(result.error.message);
  }
  async function save() {
    if (!bundle) return;
    const result = await workspaceService.update({
      workspaceId: bundle.workspace.id,
      baseRevision: bundle.revision.revision,
      skillMd: source,
      actor: "human",
    });
    if (result.ok) {
      loadBundle(result.value);
      setView("rendered");
    } else setStatus(result.error.message);
  }
  async function analyze() {
    if (!bundle) return;
    const result = await workspaceService.analyze(bundle.workspace.id, [
      "lint",
      "structure",
    ]);
    if (result.ok) {
      setLint(result.value.lint ?? null);
      setStructure(result.value.structure ?? null);
      setPanel("lint");
      setStatus(
        `Lint ${result.value.lint?.grade} · ${result.value.lint?.score}/100`,
      );
    } else setStatus(result.error.message);
  }
  async function compareRevisions() {
    if (!bundle || bundle.revision.parentRevision === null) {
      setStatus("Create another revision before comparing.");
      return;
    }
    const result = await workspaceService.compare(
      bundle.workspace.id,
      bundle.revision.parentRevision,
      bundle.revision.revision,
    );
    if (result.ok) {
      setCompare(result.value);
      setPanel("history");
    } else setStatus(result.error.message);
  }
  async function prepareTriggering() {
    if (!bundle) return;
    const result = await workspaceService.prepareEvaluation(
      bundle.workspace.id,
      "triggering",
    );
    if (result.ok) {
      setEvaluation(evaluationView(result.value));
      setPanel("evaluate");
      setSelectedChoice("");
      setRationale("");
    } else setStatus(result.error.message);
  }
  async function submitTriggeringCase() {
    if (!bundle || evaluation?.kind !== "triggering") return;
    const current = evaluation.nextCase;
    if (!current) return;
    const result = await workspaceService.submitEvaluation(
      bundle.workspace.id,
      evaluation.record.id,
      { caseId: current.id, selectedChoiceId: selectedChoice, rationale },
    );
    if (result.ok) {
      setEvaluation(evaluationView(result.value));
      setSelectedChoice("");
      setRationale("");
      setStatus(
        result.value.status === "complete"
          ? "Triggering evaluation complete"
          : "Observation recorded",
      );
    } else setStatus(result.error.message);
  }
  async function prepareMockedRun() {
    if (!bundle) return;
    const result = await workspaceService.prepareEvaluation(
      bundle.workspace.id,
      "test-run",
      { contract: SAMPLE_CONTRACT, responseSchema: RESPONSE_SCHEMA },
    );
    if (!result.ok) {
      setStatus(result.error.message);
      return;
    }
    setEvaluation(evaluationView(result.value));
    setPanel("evaluate");
    if (registrationRef.current?.available) {
      try {
        const toolName = await registrationRef.current.registerMock(
          bundle.workspace.id,
          result.value.id,
          SAMPLE_CONTRACT.name,
        );
        setStatus(`Mock tool registered as ${toolName}`);
      } catch {
        setStatus("WebMCP mock unavailable: use Manual mock invocation below.");
      }
    } else {
      setMockRegistrations((current) => ({
        ...current,
        [result.value.id]: "unavailable",
      }));
      setStatus("WebMCP unavailable: use Manual mock invocation below.");
    }
  }
  async function invokeManualMock() {
    if (!bundle || !evaluation) return;
    const result = await workspaceService.invokeMock(
      bundle.workspace.id,
      evaluation.record.id,
      { limit: 2 },
    );
    if (result.ok) {
      setEvaluation(evaluationView(result.value.evaluation));
      setStatus("Mock call recorded; nothing real was touched.");
    } else setStatus(result.error.message);
  }
  async function submitFinal() {
    if (!bundle || !evaluation) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(finalOutput);
    } catch {
      setStatus("Final output must be valid JSON.");
      return;
    }
    const result = await workspaceService.submitEvaluation(
      bundle.workspace.id,
      evaluation.record.id,
      { finalOutput: parsed },
    );
    if (result.ok) {
      registrationRef.current?.unregisterMockForRun(result.value.id);
      setEvaluation(evaluationView(result.value));
      setStatus("Deterministic contract checks complete.");
    } else setStatus(result.error.message);
  }
  async function submitMap(accept: boolean) {
    if (!bundle) return;
    let map: any;
    try {
      map = JSON.parse(instructionJson);
    } catch {
      setStatus("Instruction map must be valid JSON.");
      return;
    }
    const result = await workspaceService.submitInstructionMap(
      bundle.workspace.id,
      map,
      accept,
    );
    if (result.ok) {
      setInstructionMap(result.value.map);
      setInstructionJson(JSON.stringify(result.value.map, null, 2));
      setInstructionVector(result.value.vector ?? null);
      setStatus(
        accept
          ? `Accepted map: ${result.value.vector?.totalAtomicRequirements ?? 0} atomic requirements.`
          : "Proposal validated; review it before accepting.",
      );
    } else setStatus(result.error.message);
  }
  async function exportSnapshot() {
    if (!bundle) return;
    const result = await workspaceService.exportSnapshot(bundle.workspace.id);
    if (result.ok) {
      download(
        `${bundle.workspace.name}.workbench.json`,
        result.value,
        "application/json",
      );
      setStatus(
        "Evidence-free workbench snapshot exported. Evaluations and comparisons must be regenerated locally after import.",
      );
    } else setStatus(result.error.message);
  }
  async function importWorkbenchSnapshot(file: File) {
    if (file.size > SNAPSHOT_MAX_BYTES) {
      setStatus(`Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`);
      return;
    }
    const json = await readExactUtf8(file);
    const inspection = await workspaceService.inspectSnapshotImport(json);
    if (!inspection.ok) {
      setStatus(inspection.error.message);
      return;
    }
    let result;
    if (inspection.value.collision) {
      const existingName = inspection.value.existingWorkspace?.name;
      if (!existingName) {
        setStatus("Snapshot collision changed; import it again to continue.");
        return;
      }
      const confirmed = window.confirm(
        `Replace saved workspace “${existingName}” with incoming snapshot “${inspection.value.incomingWorkspace.name}”? This will permanently replace the saved workspace's local revisions and locally importable artifacts.`,
      );
      if (!confirmed) {
        setStatus(
          "Snapshot import cancelled; the saved workspace was unchanged.",
        );
        return;
      }
      result = await workspaceService.replaceSnapshot(
        json,
        inspection.value.replacementTarget!,
      );
    } else {
      result = await workspaceService.importSnapshot(json);
    }
    if (result.ok) {
      loadBundle(result.value);
      setStatus("Workbench snapshot imported.");
    } else setStatus(result.error.message);
  }
  function jumpTo(span?: { start: number; end: number }) {
    setView("source");
    requestAnimationFrame(() => {
      if (!span || !sourceRef.current) return;
      sourceRef.current.focus();
      sourceRef.current.setSelectionRange(span.start, span.end);
    });
  }
  const parsed = useMemo(() => parseSkillMd(source), [source]);

  function guarded<Args extends readonly unknown[]>(
    action: (...args: Args) => Promise<void>,
  ): (...args: Args) => void {
    return (...args) => {
      void action(...args).catch((error) => {
        setStatus(`Action failed: ${message(error)}`);
      });
    };
  }

  const safeCreate = guarded(create);
  const safeOpenWorkspace = guarded(openWorkspace);
  const safeCreateFromFiles = guarded(createFromFiles);
  const safeSave = guarded(save);
  const safeAnalyze = guarded(analyze);
  const safeCompareRevisions = guarded(compareRevisions);
  const safePrepareTriggering = guarded(prepareTriggering);
  const safeSubmitTriggeringCase = guarded(submitTriggeringCase);
  const safePrepareMockedRun = guarded(prepareMockedRun);
  const safeInvokeManualMock = guarded(invokeManualMock);
  const safeSubmitFinal = guarded(submitFinal);
  const safeSubmitMap = guarded(submitMap);
  const safeExportSnapshot = guarded(exportSnapshot);
  const safeImportWorkbenchSnapshot = guarded(importWorkbenchSnapshot);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">SC</span>
          <span>Skill Canvas</span>
          <span className="badge">WebMCP workbench</span>
        </div>
        <div className="topbar-actions">
          <span className={`status-dot ${webMcp}`}></span>
          <span className="micro">
            {webMcp === "available"
              ? "WebMCP tools live"
              : webMcp === "fallback"
                ? "Browser fallback"
                : "Detecting WebMCP"}
          </span>
          {appearanceState.agentRationale && (
            <span
              className="badge"
              title="Set by your agent through appearance_set"
            >
              Agent chose {appearanceState.storedChoice}:{" "}
              {appearanceState.agentRationale}
            </span>
          )}
          <label className="theme-picker">
            <span className="sr-only">Appearance</span>
            <select
              aria-label="Appearance"
              value={appearanceState.storedChoice}
              onChange={(event) => {
                // A human picker change is an explicit override: any previous
                // agent rationale no longer describes the current choice.
                appearance.setChoice(event.target.value as any);
              }}
            >
              {appearanceState.choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <aside className="rail" aria-label="Workbench tools">
        {(
          [
            ["lint", "Lint"],
            ["instructions", "Map"],
            ["evaluate", "Evals"],
            ["history", "Compare"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            className={panel === id ? "rail-button active" : "rail-button"}
            onClick={() => setPanel(id)}
          >
            <span className="rail-icon">{label[0]}</span>
            <span>{label}</span>
          </button>
        ))}
      </aside>
      <main className="workspace">
        {!bundle ? (
          <Welcome
            workspaces={workspaces}
            onOpen={safeOpenWorkspace}
            onCreate={() => safeCreate()}
            onEmpty={() =>
              safeCreate(
                `---\nname: untitled-skill\ndescription: Use when the user needs this Skill's workflow.\n---\n\n# Untitled skill\n\nDescribe the workflow here.\n`,
              )
            }
            onFiles={safeCreateFromFiles}
            onSnapshotFile={safeImportWorkbenchSnapshot}
          />
        ) : (
          <>
            <section className="workspace-header">
              <div>
                <p className="eyebrow">Working Skill</p>
                <h1>
                  {parsed.ok
                    ? parsed.value.frontmatter.name
                    : bundle.workspace.name}
                </h1>
                <p>
                  {parsed.ok
                    ? parsed.value.frontmatter.description
                    : parsed.error.message}
                </p>
              </div>
              <div className="revision-cluster">
                <span className="revision-pill">
                  Revision {bundle.revision.revision}
                </span>
                <code>{bundle.revision.contentHash.slice(0, 9)}</code>
              </div>
            </section>
            <section className="action-row">
              <div className="segmented" aria-label="Skill view">
                <button
                  className={view === "rendered" ? "active" : ""}
                  onClick={() => {
                    setView("rendered");
                    localStorage.setItem("skill-canvas:view", "rendered");
                  }}
                >
                  Rendered
                </button>
                <button
                  className={view === "source" ? "active" : ""}
                  onClick={() => {
                    setView("source");
                    localStorage.setItem("skill-canvas:view", "source");
                  }}
                >
                  Source
                </button>
              </div>
              <div className="actions">
                <button onClick={safeAnalyze} data-testid="analyze">
                  Analyze
                </button>
                <button onClick={safeCompareRevisions}>Compare</button>
                <button
                  className="primary"
                  onClick={safeSave}
                  disabled={source === bundle.skillMd}
                  data-testid="save-revision"
                >
                  Save revision
                </button>
              </div>
            </section>
            <section className="hero-card" data-testid="skill-hero">
              {view === "rendered" ? (
                <RenderedSkill
                  source={parsed.ok ? parsed.value : null}
                  raw={source}
                />
              ) : (
                <textarea
                  ref={sourceRef}
                  className="source-editor"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  spellCheck={false}
                  aria-label="SKILL.md source"
                  data-testid="source-editor"
                />
              )}
            </section>
          </>
        )}
      </main>
      <aside className="inspector" aria-label="Analysis and evaluation">
        <div className="inspector-heading">
          <div>
            <p className="eyebrow">Evidence</p>
            <h2>
              {panel === "lint"
                ? "Deterministic analysis"
                : panel === "instructions"
                  ? "Instruction load"
                  : panel === "evaluate"
                    ? "Agent-mediated evals"
                    : "Revision comparison"}
            </h2>
          </div>
          {lint && panel === "lint" && (
            <span className={`grade grade-${lint.grade}`}>{lint.grade}</span>
          )}
        </div>
        {panel === "lint" && (
          <LintPanel
            lint={lint}
            structure={structure}
            onAnalyze={safeAnalyze}
            onJump={jumpTo}
          />
        )}
        {panel === "instructions" && (
          <InstructionPanel
            json={instructionJson}
            map={instructionMap}
            vector={instructionVector}
            onChange={setInstructionJson}
            onSubmit={safeSubmitMap}
          />
        )}
        {panel === "evaluate" && (
          <EvaluationPanel
            evaluation={evaluation}
            selected={selectedChoice}
            setSelected={setSelectedChoice}
            rationale={rationale}
            setRationale={setRationale}
            onPrepareTrigger={safePrepareTriggering}
            onSubmitTrigger={safeSubmitTriggeringCase}
            onPrepareTest={safePrepareMockedRun}
            onInvokeMock={safeInvokeManualMock}
            finalOutput={finalOutput}
            setFinalOutput={setFinalOutput}
            onSubmitFinal={safeSubmitFinal}
            mockStatus={
              evaluation ? mockRegistrations[evaluation.record.id] : undefined
            }
          />
        )}
        {panel === "history" && (
          <HistoryPanel
            compare={compare}
            onCompare={safeCompareRevisions}
            onSnapshot={safeExportSnapshot}
            onImportSnapshot={safeImportWorkbenchSnapshot}
          />
        )}
        <footer className="evidence-boundary">
          <strong>Evidence boundary</strong>
          <p>
            Semantic choices come from the visiting browser agent. This site
            grades only deterministic properties; observations do not prove
            runtime portability.
          </p>
        </footer>
      </aside>
      <div className="statusbar" role="status">
        <span>{status}</span>
        <span>IndexedDB · {appearanceState.resolvedTheme}</span>
      </div>
    </div>
  );
}

function Welcome({
  workspaces,
  onOpen,
  onCreate,
  onEmpty,
  onFiles,
  onSnapshotFile,
}: {
  workspaces: readonly WorkspaceRecord[];
  onOpen(workspaceId: string): void;
  onCreate(): void;
  onEmpty(): void;
  onFiles(files: readonly File[]): void;
  onSnapshotFile(file: File): void;
}) {
  return (
    <section className="welcome">
      <div className="welcome-copy">
        <p className="eyebrow">Make invisible Skills legible</p>
        <h1>See what your agent’s Skills actually do.</h1>
        <p>
          Skills can strongly shape an agent while staying out of sight. Open an
          imported, default, or authored Skill to understand its behavior, judge
          its quality, and iterate with evidence.
        </p>
        <div className="welcome-actions">
          <button
            className="primary"
            onClick={onCreate}
            data-testid="load-sample"
          >
            Load example Skill
          </button>
          <button onClick={onEmpty}>Create empty Skill</button>
          <label className="file-button">
            Import SKILL.md
            <input
              type="file"
              accept=".md,text/markdown"
              multiple
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length > 0) onFiles(files);
              }}
            />
          </label>
          <label className="file-button">
            Import Skill directory
            <input
              type="file"
              multiple
              {...({ webkitdirectory: "" } as Record<string, string>)}
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length > 0) onFiles(files);
              }}
            />
          </label>
          <label className="file-button">
            Import workbench snapshot
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onSnapshotFile(file);
              }}
            />
          </label>
        </div>
        {workspaces.length > 0 && (
          <div className="recent-workspaces">
            <p className="eyebrow">Saved in this browser</p>
            {workspaces.map((workspace) => (
              <button key={workspace.id} onClick={() => onOpen(workspace.id)}>
                <strong>{workspace.name}</strong>
                <span>Revision {workspace.currentRevision}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="thesis-stack">
        <div>
          <span>01</span>
          <strong>Understand what it does</strong>
          <p>Rendered intent, structural anatomy, and traceable source.</p>
        </div>
        <div>
          <span>02</span>
          <strong>See whether it is good</strong>
          <p>Lint, instruction load, and observed evaluation evidence.</p>
        </div>
        <div>
          <span>03</span>
          <strong>Improve without guessing</strong>
          <p>Append-only revisions, comparisons, and portable export.</p>
        </div>
      </div>
    </section>
  );
}
function RenderedSkill({
  source,
  raw,
}: {
  source: ReturnType<typeof parseSkillMd> extends { ok: true; value: infer T }
    ? T
    : any;
  raw: string;
}) {
  if (!source) return <pre className="invalid-source">{raw}</pre>;
  const lines = source.body.split("\n");
  return (
    <article className="rendered-skill">
      <header>
        <h1>{source.frontmatter.name}</h1>
        <p>{source.frontmatter.description}</p>
      </header>
      {lines.map((line: string, index: number) => {
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) return <h2 key={index}>{heading[2]}</h2>;
        if (/^(?:[-*]|\d+\.)\s/.test(line))
          return (
            <ul key={index}>
              <li>{line.replace(/^(?:[-*]|\d+\.)\s+/, "")}</li>
            </ul>
          );
        return line.length === 0 ? (
          <br key={index} />
        ) : (
          <p key={index}>{line}</p>
        );
      })}
    </article>
  );
}
function LintPanel({
  lint,
  structure,
  onAnalyze,
  onJump,
}: {
  lint: LintArtifact | null;
  structure: StructureArtifact | null;
  onAnalyze(): void;
  onJump(span?: { start: number; end: number }): void;
}) {
  if (!lint)
    return (
      <EmptyPanel
        title="No artifact yet"
        body="Run deterministic lint and structure analysis for the current revision."
        action="Analyze current revision"
        onAction={onAnalyze}
      />
    );
  return (
    <div className="panel-stack">
      {structure && (
        <section className="anatomy-card">
          <div className="card-heading">
            <div>
              <span>Skill anatomy</span>
              <strong>{structure.sections.length} source sections</strong>
            </div>
            <code>traceable</code>
          </div>
          <div className="anatomy-tree">
            {structure.sections.map((section, index) => (
              <button
                key={`${section.sourceSpan.start}-${section.title}`}
                style={{ "--depth": section.level - 1 } as CSSProperties}
                onClick={() => onJump(section.sourceSpan)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{section.title}</strong>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="score-card">
        <div>
          <strong>{lint.score}</strong>
          <span>/ 100</span>
        </div>
        <p>
          {lint.counts.error} errors · {lint.counts.warn} warnings ·{" "}
          {lint.counts.info} notes
        </p>
        <code>{lint.rulesetVersion}</code>
      </div>
      <div className="finding-list">
        {lint.findings.length === 0 ? (
          <p className="success-note">
            No findings. The deterministic rules passed.
          </p>
        ) : (
          lint.findings.map((finding) => (
            <button
              key={`${finding.rule}-${finding.message}`}
              className={`finding ${finding.severity}`}
              onClick={() => onJump(finding.sourceSpan)}
            >
              <span>{finding.severity}</span>
              <strong>{finding.rule}</strong>
              <p>{finding.message}</p>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
function InstructionPanel({
  json,
  map,
  vector,
  onChange,
  onSubmit,
}: {
  json: string;
  map: InstructionMap | null;
  vector: InstructionLoadVector | null;
  onChange(value: string): void;
  onSubmit(accept: boolean): void;
}) {
  const requirementsById = new Map(
    map?.requirements.map((requirement) => [requirement.id, requirement]) ?? [],
  );
  return (
    <div className="panel-stack">
      <div className="boundary-card">
        <strong>Visiting-agent proposal</strong>
        <p>
          Atomic requirements are semantic judgments. Every span and graph edge
          is validated in browser code before acceptance.
        </p>
      </div>
      {vector && (
        <section className="load-vector">
          <div className="load-primary">
            <span>Accepted atomic requirements</span>
            <strong>{vector.totalAtomicRequirements}</strong>
            <small>from a visiting-agent map</small>
          </div>
          <div className="load-metrics">
            <Metric
              label="Max active"
              value={vector.maximumSimultaneouslyActive}
            />
            <Metric label="Chain" value={vector.longestDependencyChain} />
            <Metric label="Scope depth" value={vector.maximumScopeDepth} />
            <Metric label="Branches" value={vector.branchCount} />
            <Metric label="Cross-scope" value={vector.crossScopeReferences} />
            <Metric
              label="Deterministic"
              value={`${Math.round(vector.deterministicallyVerifiableFraction * 100)}%`}
            />
          </div>
        </section>
      )}
      {map && (
        <section
          className="instruction-dependencies"
          aria-label="Instruction requirements and dependencies"
        >
          <div className="instruction-dependencies-heading">
            <strong>Requirements and dependencies</strong>
            <span>{map.status}</span>
          </div>
          {map.requirements.length === 0 ? (
            <p>No atomic requirements mapped yet.</p>
          ) : (
            <ol>
              {map.requirements.map((requirement) => (
                <li key={requirement.id}>
                  <strong>{requirement.statement}</strong>
                  <small>
                    {requirement.kind} · {requirement.scopeId} ·{" "}
                    {requirement.id}
                  </small>
                  <p>
                    Depends on:{" "}
                    {requirement.dependencies.length === 0
                      ? "none"
                      : requirement.dependencies
                          .map(
                            (dependencyId) =>
                              requirementsById.get(dependencyId)?.statement ??
                              dependencyId,
                          )
                          .join("; ")}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <textarea
        className="json-editor"
        value={json}
        onChange={(event) => onChange(event.target.value)}
        aria-label="Instruction map JSON"
      />
      <div className="button-grid">
        <button onClick={() => onSubmit(false)}>Validate proposal</button>
        <button className="primary" onClick={() => onSubmit(true)}>
          Accept map
        </button>
      </div>
      <details>
        <summary>Capacity evidence boundary</summary>
        <p>
          IFScale tested 10–500 flat keyword constraints and reported 68% for
          the best evaluated model at 500 in 2025. The benchmark maximum is not
          a universal cap. IFHierBench shows hierarchy depth is a separate
          failure dimension.
        </p>
      </details>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
type EvaluationPanelProps = {
  evaluation: EvaluationView | null;
  selected: string;
  setSelected(value: string): void;
  rationale: string;
  setRationale(value: string): void;
  onPrepareTrigger(): void;
  onSubmitTrigger(): void;
  onPrepareTest(): void;
  onInvokeMock(): void;
  finalOutput: string;
  setFinalOutput(value: string): void;
  onSubmitFinal(): void;
  mockStatus?: MockRegistrationStatus;
};

function EvaluationPanel(props: EvaluationPanelProps) {
  const evaluation = props.evaluation;
  if (!evaluation)
    return (
      <div className="panel-stack">
        <EmptyPanel
          title="No observed run"
          body="Prepare cases here; the visiting agent supplies selections or final output."
        />
        <button className="primary" onClick={props.onPrepareTrigger}>
          Prepare triggering eval
        </button>
        <button onClick={props.onPrepareTest}>Prepare mocked test run</button>
      </div>
    );
  if (evaluation.kind === "triggering") {
    const { data, nextCase: current, passed } = evaluation;
    return (
      <div className="panel-stack">
        <div className="run-meta">
          <span>{evaluation.record.status}</span>
          <code>
            {data.observations.length}/{data.cases.length} cases
          </code>
        </div>
        {current ? (
          <div className="case-card">
            <p className="eyebrow">
              {current.expected === "fire"
                ? "Should fire"
                : "Should stay silent"}
            </p>
            <h3>{current.prompt}</h3>
            <fieldset>
              <legend>Which Skill would you select?</legend>
              {current.choices.map((choice) => (
                <label
                  key={choice.id}
                  className={
                    props.selected === choice.id ? "choice selected" : "choice"
                  }
                >
                  <input
                    type="radio"
                    name="choice"
                    value={choice.id}
                    checked={props.selected === choice.id}
                    onChange={() => props.setSelected(choice.id)}
                  />
                  <span>
                    <strong>{choice.name}</strong>
                    <small>{choice.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>
            <textarea
              placeholder="Short rationale"
              value={props.rationale}
              onChange={(event) => props.setRationale(event.target.value)}
            />
            <button
              className="primary"
              disabled={!props.selected || props.rationale.length < 3}
              onClick={props.onSubmitTrigger}
            >
              Submit observation
            </button>
          </div>
        ) : (
          <div className="score-card">
            <strong>
              {passed}/{data.cases.length} passed
            </strong>
            <p>Submitted agent observations.</p>
          </div>
        )}
        <button onClick={props.onPrepareTrigger}>
          Start new triggering eval
        </button>
      </div>
    );
  }
  const data = evaluation.data;
  const submittedFinalOutput =
    data.finalOutput === undefined ? null : JSON.stringify(data.finalOutput);
  return (
    <div className="panel-stack">
      <div className="run-meta">
        <span>{evaluation.record.status}</span>
        <code>{data.contract.name}</code>
      </div>
      <div className="boundary-card">
        <strong>Mock world only</strong>
        <p>
          {evaluation.record.status === "complete" ||
          props.mockStatus === "completed"
            ? "This run is complete; its run-scoped mock tool is unregistered."
            : props.mockStatus === "registered"
              ? "A run-scoped WebMCP mock tool is registered."
              : "No run-scoped WebMCP mock is registered. Use the manual inspector path below."}
        </p>
      </div>
      <button onClick={props.onInvokeMock}>Manual mock invocation</button>
      <div className="transcript">
        {data.transcript.length === 0 ? (
          <p>No calls recorded.</p>
        ) : (
          data.transcript.map((step, index) => (
            <div key={index}>
              <span>{step.kind}</span>
              <code>
                {JSON.stringify(
                  step.kind === "tool-call" ? step.input : step.output,
                )}
              </code>
            </div>
          ))
        )}
      </div>
      <label>
        Submitted agent final JSON
        <textarea
          className="json-editor short"
          value={submittedFinalOutput ?? props.finalOutput}
          disabled={submittedFinalOutput !== null}
          onChange={(event) => props.setFinalOutput(event.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={submittedFinalOutput !== null}
        onClick={props.onSubmitFinal}
      >
        Submit final output
      </button>
      {data.checks && (
        <div className="checks">
          {data.checks.map((check) => (
            <p key={check.id} className={check.passed ? "pass" : "fail"}>
              {check.passed ? "✓" : "×"} {check.message}
            </p>
          ))}
        </div>
      )}
      <button onClick={props.onPrepareTest}>Start new test run</button>
    </div>
  );
}
function HistoryPanel({
  compare,
  onCompare,
  onSnapshot,
  onImportSnapshot,
}: {
  compare: CompareArtifact | null;
  onCompare(): void;
  onSnapshot(): void;
  onImportSnapshot(file: File): void;
}) {
  return (
    <div className="panel-stack">
      {compare ? (
        <>
          <div className="compare-grid">
            <div>
              <span>Before</span>
              <strong>{compare.lint.before.grade}</strong>
              <small>{compare.lint.before.score}/100</small>
            </div>
            <div>
              <span>After</span>
              <strong>{compare.lint.after.grade}</strong>
              <small>{compare.lint.after.score}/100</small>
            </div>
          </div>
          <div className="diff-card">
            <strong>Source diff metadata</strong>
            <p>
              <ins>+{compare.source.additions}</ins>{" "}
              <del>−{compare.source.deletions}</del>
            </p>
            <small>
              Changed lines: {compare.source.changedLines.join(", ") || "none"}
              {compare.source.approximate
                ? " · approximate for large diff"
                : ""}
            </small>
          </div>
        </>
      ) : (
        <EmptyPanel
          title="No comparison yet"
          body="Compare the current revision with its parent."
          action="Compare revisions"
          onAction={onCompare}
        />
      )}
      <button data-testid="export-snapshot" onClick={onSnapshot}>
        Export workbench snapshot
      </button>
      <label className="file-button">
        Import workbench snapshot
        <input
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImportSnapshot(file);
          }}
        />
      </label>
    </div>
  );
}
function EmptyPanel({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string;
  onAction?(): void;
}) {
  return (
    <div className="empty-panel">
      <span>◇</span>
      <strong>{title}</strong>
      <p>{body}</p>
      {action && <button onClick={onAction}>{action}</button>}
    </div>
  );
}

function download(filename: string, bytes: Uint8Array | string, type: string) {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
