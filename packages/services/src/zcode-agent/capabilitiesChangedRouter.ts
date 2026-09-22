import { Emitter, type Event } from "@zcode/rpc";
import {
  resolveWorkspaceKey,
  type ZCodeSessionCapabilitiesChangedNotification,
} from "@zcode/shared";
import type { ZCodeAgentCapabilitiesChangedEvent } from "./zcodeAgent.js";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgentPluginParams.js";

function capabilityScopeKey(workspace: ZCodeAgentWorkspaceTarget): string {
  // `workspaceIdentity` establishes the workspace boundary; remote attachment identity keeps
  // two routed connections to the same workspace from sharing a sideband notification stream.
  return `${resolveWorkspaceKey(workspace)}\u0000${workspace.remoteSessionId ?? ""}`;
}

function eventWorkspace(workspace: ZCodeAgentWorkspaceTarget): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: workspace.workspacePath,
    ...(workspace.workspaceIdentity ? { workspaceIdentity: workspace.workspaceIdentity } : {}),
    ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
  };
}

/**
 * Owns the short-lived sideband fan-out for runtime capability status. The catalog remains
 * runtime-owned; subscribers receive only invalidation facts scoped to their routed workspace.
 */
export function createCapabilitiesChangedRouter(): {
  emit(
    workspace: ZCodeAgentWorkspaceTarget,
    notification: ZCodeSessionCapabilitiesChangedNotification,
  ): void;
  on(workspace: ZCodeAgentWorkspaceTarget): Event<ZCodeAgentCapabilitiesChangedEvent>;
  dispose(): void;
} {
  const emitters = new Map<string, Emitter<ZCodeAgentCapabilitiesChangedEvent>>();

  const getEmitter = (workspace: ZCodeAgentWorkspaceTarget) => {
    const key = capabilityScopeKey(workspace);
    const existing = emitters.get(key);
    if (existing) return existing;

    let created: Emitter<ZCodeAgentCapabilitiesChangedEvent>;
    created = new Emitter({
      onDidRemoveLastListener: () => {
        if (emitters.get(key) !== created) return;
        emitters.delete(key);
        created.dispose();
      },
    });
    emitters.set(key, created);
    return created;
  };

  return {
    emit(workspace, notification) {
      const emitter = emitters.get(capabilityScopeKey(workspace));
      if (!emitter) return;
      emitter.fire({
        ...eventWorkspace(workspace),
        sessionId: notification.sessionId,
        status: notification.status,
      });
    },
    on(workspace) {
      return getEmitter(workspace).event;
    },
    dispose() {
      for (const emitter of emitters.values()) emitter.dispose();
      emitters.clear();
    },
  };
}
