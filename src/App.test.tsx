import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelContextAdapter, WebMcpTool } from "./modules/webmcp";
import { EMPTY_SKILL } from "./modules/skill";
import { MemoryWorkspaceStore } from "./modules/workspace/memory-store";
import { createWorkspaceService } from "./modules/workspace/service";

afterEach(() => {
  cleanup();
  delete document.modelContext;
  sessionStorage.clear();
});

describe("App WebMCP registration lifecycle", () => {
  it("leaves exactly one live registration per tool under StrictMode", async () => {
    const live = new Map<string, number>();
    const context: ModelContextAdapter = {
      async registerTool(tool: WebMcpTool, options) {
        live.set(tool.name, (live.get(tool.name) ?? 0) + 1);
        options?.signal?.addEventListener("abort", () =>
          live.set(tool.name, (live.get(tool.name) ?? 0) - 1),
        );
        return undefined;
      },
    };
    document.modelContext = context;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const { App } = await import("./App");
    await act(async () => {
      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
    });
    expect(live.size).toBeGreaterThan(0);
    expect([...live.values()].every((count) => count === 1)).toBe(true);
  });

  it("reopens a durable workspace without a session selection", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({
      name: "Recovered Skill",
      skillMd: EMPTY_SKILL,
    });
    if (!created.ok) throw new Error(created.error.message);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const reopen = await screen.findByRole("button", {
      name: /Recovered Skill Revision 1/,
    });
    fireEvent.click(reopen);
    expect(await screen.findByTestId("skill-hero")).toBeInTheDocument();
    expect(sessionStorage.getItem("skill-canvas:open-workspace")).toBe(
      created.value.workspace.id,
    );
  });

  it("imports an exported workbench snapshot from the welcome screen", async () => {
    const source = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await source.create({ name: "Imported Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await source.exportSnapshot(created.value.workspace.id);
    if (!exported.ok) throw new Error(exported.error.message);
    const target = createWorkspaceService(new MemoryWorkspaceStore());
    const { App } = await import("./App");
    render(<App workspaceService={target} />);
    const file = Object.assign(
      new File([exported.value], "workspace.json", {
        type: "application/json",
      }),
      { text: async () => exported.value },
    );
    fireEvent.change(screen.getByLabelText("Import workbench snapshot"), {
      target: { files: [file] },
    });
    expect(await screen.findByTestId("skill-hero")).toBeInTheDocument();
    expect(sessionStorage.getItem("skill-canvas:open-workspace")).toBe(
      created.value.workspace.id,
    );
  });

  it("warns before replacing a saved workspace snapshot", async () => {
    const workspaceService = createWorkspaceService(new MemoryWorkspaceStore());
    const created = await workspaceService.create({ name: "Saved Workspace" });
    if (!created.ok) throw new Error(created.error.message);
    const exported = await workspaceService.exportSnapshot(
      created.value.workspace.id,
    );
    if (!exported.ok) throw new Error(exported.error.message);
    const incoming = JSON.parse(exported.value);
    incoming.workspace.name = "Incoming Snapshot";
    const incomingJson = JSON.stringify(incoming);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { App } = await import("./App");
    render(<App workspaceService={workspaceService} />);
    const file = Object.assign(
      new File([exported.value], "workspace.json", {
        type: "application/json",
      }),
      { text: async () => incomingJson },
    );
    fireEvent.change(screen.getByLabelText("Import workbench snapshot"), {
      target: { files: [file] },
    });
    expect(
      await screen.findByText(/Snapshot import cancelled/),
    ).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringMatching(
        /Replace saved workspace “Saved Workspace” with incoming snapshot “Incoming Snapshot”.*permanently/,
      ),
    );
    expect(await workspaceService.list()).toHaveLength(1);
    confirm.mockRestore();
  });
});
