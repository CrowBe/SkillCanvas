export type AppearanceChoice =
  "system" | "light" | "dark" | "tuxedo" | "cardigan" | "terminal";
export type ConcreteTheme = Exclude<AppearanceChoice, "system">;
/**
 * One selectable appearance. The palette itself lives in styles.css under the
 * matching `[data-theme]` rule; this module only decides which theme is
 * current and stamps it on the root element.
 */
export type AppearanceEntry = {
  readonly id: AppearanceChoice;
  readonly label: string;
  readonly scheme: "light" | "dark";
};
export type AppearanceState = {
  readonly choices: readonly AppearanceEntry[];
  readonly storedChoice: AppearanceChoice;
  readonly resolvedTheme: ConcreteTheme;
  readonly source: "system" | "explicit";
  /**
   * Why the current choice was set, when the setter explained itself.
   * Human picker changes clear it; agent-supplied rationales are shown in the
   * UI as a visible collaboration note. Browser preference metadata only:
   * never Skill content, evidence, or snapshot payload.
   */
  readonly agentRationale: string | null;
};
export interface AppearanceController {
  readState(): AppearanceState;
  setChoice(
    choice: AppearanceChoice,
    options?: { agentRationale?: string },
  ): AppearanceState;
  subscribe(listener: (state: AppearanceState) => void): () => void;
}

export const APPEARANCE_REGISTRY: readonly AppearanceEntry[] = [
  { id: "system", label: "System", scheme: "light" },
  { id: "light", label: "Light", scheme: "light" },
  { id: "dark", label: "Dark", scheme: "dark" },
  { id: "tuxedo", label: "Tuxedo", scheme: "dark" },
  { id: "cardigan", label: "Cardigan", scheme: "light" },
  { id: "terminal", label: "Terminal", scheme: "dark" },
] as const;

const STORAGE_KEY = "skill-canvas:appearance";
const CHANGE_EVENT = "skill-canvas:appearance-change";
const isChoice = (value: string | null): value is AppearanceChoice =>
  APPEARANCE_REGISTRY.some((item) => item.id === value);

export function createBrowserAppearanceController(options?: {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  media?: Pick<
    MediaQueryList,
    "matches" | "addEventListener" | "removeEventListener"
  >;
  root?: HTMLElement;
  eventTarget?: EventTarget;
}): AppearanceController {
  const storage = options?.storage ?? localStorage;
  const media = options?.media ?? matchMedia("(prefers-color-scheme: dark)");
  const root = options?.root ?? document.documentElement;
  const events = options?.eventTarget ?? window;
  const listeners = new Set<(state: AppearanceState) => void>();
  let storedChoice: AppearanceChoice = isChoice(storage.getItem(STORAGE_KEY))
    ? (storage.getItem(STORAGE_KEY)! as AppearanceChoice)
    : "system";
  let agentRationale: string | null = null;
  const RATIONALE_KEY = "skill-canvas:appearance-rationale";
  if (storedChoice !== "system") {
    const stored = storage.getItem(RATIONALE_KEY);
    agentRationale =
      typeof stored === "string" && stored.trim() !== "" ? stored : null;
  }
  const resolve = (): ConcreteTheme =>
    storedChoice === "system"
      ? media.matches
        ? "dark"
        : "light"
      : storedChoice;
  const state = (): AppearanceState => ({
    choices: APPEARANCE_REGISTRY,
    storedChoice,
    resolvedTheme: resolve(),
    source: storedChoice === "system" ? "system" : "explicit",
    agentRationale,
  });
  const apply = (emit: boolean) => {
    root.dataset.theme = resolve();
    root.style.colorScheme =
      APPEARANCE_REGISTRY.find((entry) => entry.id === resolve())?.scheme ??
      "light";
    if (emit) {
      const next = state();
      listeners.forEach((listener) => listener(next));
      events.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
    }
  };
  const mediaChange = () => {
    if (storedChoice === "system") apply(true);
  };
  media.addEventListener("change", mediaChange);
  apply(false);
  return {
    readState: state,
    setChoice(choice, options) {
      if (!isChoice(choice))
        throw new Error(`Unknown appearance choice: ${choice}`);
      storedChoice = choice;
      storage.setItem(STORAGE_KEY, choice);
      if (choice === "system" || options?.agentRationale === undefined) {
        // A plain picker change clears any prior agent note; system mode has
        // no explicit choice for an agent to have explained.
        agentRationale = null;
        storage.removeItem(RATIONALE_KEY);
      } else {
        const note = options!.agentRationale!.trim();
        agentRationale = note === "" ? null : note.slice(0, 280);
        if (agentRationale === null) storage.removeItem(RATIONALE_KEY);
        else storage.setItem(RATIONALE_KEY, agentRationale);
      }
      apply(true);
      return state();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
