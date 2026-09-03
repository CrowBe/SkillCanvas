import { describe, expect, it, vi } from "vitest";
import { createBrowserAppearanceController } from "./appearance";

function fixture(initial: Record<string, string> = {}, dark = false) {
  const values = new Map(Object.entries(initial));
  let listener: (() => void) | undefined;
  const media = {
    matches: dark,
    addEventListener: vi.fn((_type: string, fn: () => void) => {
      listener = fn;
    }),
    removeEventListener: vi.fn(),
  };
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const root = document.createElement("html");
  const eventTarget = new EventTarget();
  return {
    controller: createBrowserAppearanceController({
      storage,
      media,
      root,
      eventTarget,
    }),
    media,
    root,
    values,
    trigger: () => listener?.(),
  };
}

describe("AppearanceController", () => {
  it("persists explicit choices and rejects invalid choices", () => {
    const { controller, root, values } = fixture();
    expect(controller.setChoice("cardigan").resolvedTheme).toBe("cardigan");
    expect(root.dataset.theme).toBe("cardigan");
    expect(values.get("skill-canvas:appearance")).toBe("cardigan");
    expect(() => controller.setChoice("bogus" as any)).toThrow(
      "Unknown appearance choice",
    );
  });

  it("follows later OS changes only in system mode and notifies human/tool parity", () => {
    const { controller, media, root, trigger } = fixture({}, false);
    const listener = vi.fn();
    controller.subscribe(listener);
    expect(controller.readState().resolvedTheme).toBe("light");
    (media as any).matches = true;
    trigger();
    expect(root.dataset.theme).toBe("dark");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        storedChoice: "system",
        resolvedTheme: "dark",
      }),
    );
    controller.setChoice("light");
    (media as any).matches = true;
    trigger();
    expect(controller.readState().resolvedTheme).toBe("light");
  });

  it("carries an agent rationale until a human picker change clears it", () => {
    const { controller, values } = fixture();
    const state = controller.setChoice("terminal", {
      agentRationale: "  The Skill is a CLI workflow aid; Terminal suits it.  ",
    });
    expect(state.agentRationale).toBe(
      "The Skill is a CLI workflow aid; Terminal suits it.",
    );
    expect(values.get("skill-canvas:appearance-rationale")).toBe(
      "The Skill is a CLI workflow aid; Terminal suits it.",
    );
    // Persisted note survives a fresh controller over the same storage.
    expect(
      fixture(Object.fromEntries(values)).controller.readState().agentRationale,
    ).toBe("The Skill is a CLI workflow aid; Terminal suits it.");
    // An empty rationale stores nothing.
    const empty = controller.setChoice("dark", { agentRationale: "   " });
    expect(empty.agentRationale).toBeNull();
    // A human picker change without options clears any prior agent note.
    const human = controller.setChoice("tuxedo", { agentRationale: "x" });
    expect(human.agentRationale).toBe("x");
    const override = controller.setChoice("cardigan");
    expect(override.agentRationale).toBeNull();
    expect(values.has("skill-canvas:appearance-rationale")).toBe(false);
    // System mode never carries a rationale.
    const sys = controller.setChoice("terminal", { agentRationale: "why" });
    expect(sys.agentRationale).toBe("why");
    const toSystem = controller.setChoice("system");
    expect(toSystem.agentRationale).toBeNull();
  });
});
