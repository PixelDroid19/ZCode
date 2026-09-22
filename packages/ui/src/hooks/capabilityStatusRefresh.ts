import type { ZCodeAgentCapabilitiesChangedEvent } from "@zcode/services";
import type { ZCodeCapabilitiesStatus } from "@zcode/shared";

interface CapabilityStatusRefreshScope {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * Converts only an owning session's completed capability transition into a catalog invalidation.
 * Loading is deliberately ignored: catalog reads themselves may cause it and must not form a loop.
 */
export function capabilityStatusRefreshSignal(
  scope: CapabilityStatusRefreshScope,
  event: ZCodeAgentCapabilitiesChangedEvent,
): string | null {
  const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
  const eventWorkspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
  if (
    eventWorkspaceKey !== workspaceKey ||
    event.remoteSessionId !== scope.remoteSessionId ||
    event.sessionId !== scope.sessionId
  ) {
    return null;
  }

  if (event.status.status === "ready") {
    if (!event.status.revision) return null;
    return `${workspaceKey}\u0000${scope.remoteSessionId ?? ""}\u0000${scope.sessionId}\u0000ready:${event.status.revision}`;
  }
  if (event.status.status === "error") {
    return `${workspaceKey}\u0000${scope.remoteSessionId ?? ""}\u0000${scope.sessionId}\u0000error:${event.status.revision ?? ""}:${event.status.error ?? ""}`;
  }
  return null;
}

/** Reuses the hooks' existing error channel without adding UI-owned capability state. */
export function capabilityStatusError(status: ZCodeCapabilitiesStatus | undefined): string | null {
  return status?.status === "error" ? (status.error ?? null) : null;
}
