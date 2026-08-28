import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelContextAdapter, WebMcpTool } from "./modules/webmcp";
import { EMPTY_SKILL } from "./modules/skill";
import { MemoryWorkspaceStore } from "./modules/workspace/memory-store";
import { createWorkspaceService } from "./modules/workspace/service";

afterEach(() => {
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
});
