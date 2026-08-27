import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelContextAdapter, WebMcpTool } from "./modules/webmcp";

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
});
