export const PROTOCOL_VERSION = "skill-canvas/1" as const;
export const RULESET_VERSION = "skill-canvas-rules/1" as const;
export const SNAPSHOT_VERSION = 1 as const;
export const SKILL_MAX_BYTES = 256 * 1024;
export const REFERENCE_MAX_BYTES = 512 * 1024;
export const REFERENCES_MAX = 24;
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

export type SourceSpan = { readonly start: number; readonly end: number };
export type DomainError = {
  readonly code:
    | "invalid_skill"
    | "invalid_path"
    | "duplicate_path"
    | "size_limit"
    | "workspace_not_found"
    | "revision_not_found"
    | "revision_conflict"
    | "invalid_instruction_map"
    | "evaluation_not_found"
    | "evaluation_complete"
    | "invalid_submission"
    | "unsupported_webmcp"
    | "invalid_appearance"
    | "invalid_snapshot"
    | "internal_error";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export class DomainMutationError extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message);
  }
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError };
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = (
  code: DomainError["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): Result<never> => ({
  ok: false,
  error: { code, message, ...(details ? { details } : {}) },
});

export type ToolEnvelope<T> = {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly ok: boolean;
  readonly workspaceId: string | null;
  readonly revision: number | null;
  readonly contentHash: string | null;
  readonly data?: T;
  readonly error?: DomainError;
};

export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/** True when `value` has the exact shape `makeId(prefix)` produces. */
export function hasCanonicalPrefixedId(
  value: unknown,
  prefix: string,
): boolean {
  return (
    typeof value === "string" &&
    new RegExp(
      `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "i",
    ).test(value)
  );
}

/** True when `value` is an ISO instant in the exact form `toISOString` emits. */
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
}

/** True for a plain JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural equality over JSON values, insensitive to key order. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(left[key], right[key]),
    )
  );
}

export function normalizeReferencePath(path: string): Result<string> {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    parts.some((part) => part === "" || part === "." || part === "..") ||
    normalized === "SKILL.md"
  ) {
    return err("invalid_path", `Reference path is unsafe: ${path}`);
  }
  return ok(normalized);
}
