export type AppearanceChoice =
  "system" | "light" | "dark" | "tuxedo" | "cardigan" | "terminal";
export type ConcreteTheme = Exclude<AppearanceChoice, "system">;
export type AppearanceEntry = {
  readonly id: AppearanceChoice;
  readonly label: string;
  readonly scheme: "light" | "dark";
  readonly kind: "system" | "custom";
  readonly tokens: Readonly<Record<string, string>>;
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

const baseLight = {
  background: "#fbfbfd",
  surface: "#ffffff",
  surfaceHigh: "#f1f3f9",
  onSurface: "#141a24",
  onSurfaceVariant: "#4b5366",
  outline: "#737686",
  outlineVariant: "#dcdfe8",
  primary: "#004ac6",
  onPrimary: "#ffffff",
  secondary: "#006a61",
  tertiary: "#b8730a",
  error: "#ba1a1a",
  display: "Hanken Grotesk",
  radius: "12px",
};
export const APPEARANCE_REGISTRY: readonly AppearanceEntry[] = [
  {
    id: "system",
    label: "System",
    scheme: "light",
    kind: "system",
    tokens: {},
  },
  {
    id: "light",
    label: "Light",
    scheme: "light",
    kind: "system",
    tokens: baseLight,
  },
  {
    id: "dark",
    label: "Dark",
    scheme: "dark",
    kind: "system",
    tokens: {
      ...baseLight,
      background: "#0f172a",
      surface: "#1e293b",
      surfaceHigh: "#222a3d",
      onSurface: "#dae2fd",
      onSurfaceVariant: "#94a3b8",
      outline: "#475569",
      outlineVariant: "#334155",
      primary: "#2563eb",
    },
  },
  {
    id: "tuxedo",
    label: "Tuxedo",
    scheme: "dark",
    kind: "custom",
    tokens: {
      ...baseLight,
      background: "#0b0d12",
      surface: "#12151d",
      surfaceHigh: "#1a1e29",
      onSurface: "#ece7da",
      onSurfaceVariant: "#a39c8a",
      outline: "#6b6350",
      outlineVariant: "#2a2e3a",
      primary: "#c9a227",
      display: "Playfair Display",
      radius: "6px",
    },
  },
  {
    id: "cardigan",
    label: "Cardigan",
    scheme: "light",
    kind: "custom",
    tokens: {
      ...baseLight,
      background: "#f5efe4",
      surface: "#fdfaf2",
      surfaceHigh: "#ece3d1",
      onSurface: "#332a1d",
      onSurfaceVariant: "#6d5f4b",
      outline: "#8b7b63",
      outlineVariant: "#ddd1bb",
      primary: "#a6501f",
      display: "Fraunces",
      radius: "14px",
    },
  },
  {
    id: "terminal",
    label: "Terminal",
    scheme: "dark",
    kind: "custom",
    tokens: {
      ...baseLight,
      background: "#050807",
      surface: "#0b110d",
      surfaceHigh: "#121b14",
      onSurface: "#a8f0b8",
      onSurfaceVariant: "#5f9973",
      outline: "#3c7a53",
      outlineVariant: "#1c2f22",
      primary: "#35e06d",
      display: "JetBrains Mono",
      radius: "0px",
    },
  },
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
