import { SNAPSHOT_MAX_BYTES, byteLength, type DomainError } from "../shared";
import type { WorkspaceSnapshot } from "./types";

export function portableSnapshotJson(snapshot: WorkspaceSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export function portableSnapshotSizeError(
  snapshot: WorkspaceSnapshot,
): DomainError | null {
  const bytes = byteLength(portableSnapshotJson(snapshot));
  return bytes > SNAPSHOT_MAX_BYTES
    ? {
        code: "size_limit",
        message: `Snapshot exceeds ${SNAPSHOT_MAX_BYTES} bytes.`,
        details: { bytes, maximumBytes: SNAPSHOT_MAX_BYTES },
      }
    : null;
}

export class PortableSnapshotSizeError extends Error {
  constructor(readonly domainError: DomainError) {
    super(domainError.message);
  }
}
