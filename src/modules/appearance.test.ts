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
});
