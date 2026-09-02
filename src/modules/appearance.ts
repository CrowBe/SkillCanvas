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
};
export interface AppearanceController {
  readState(): AppearanceState;
  setChoice(choice: AppearanceChoice): AppearanceState;
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
  storage?: Pick<Storage, "getItem" | "setItem">;
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
    setChoice(choice) {
      if (!isChoice(choice))
        throw new Error(`Unknown appearance choice: ${choice}`);
      storedChoice = choice;
      storage.setItem(STORAGE_KEY, choice);
      apply(true);
      return state();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
