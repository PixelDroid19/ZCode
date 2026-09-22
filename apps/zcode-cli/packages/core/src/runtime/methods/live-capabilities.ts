import type { SkillLoadOutcome, TraceContext } from "../deps.js";
import type { PluginReferenceCatalog } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { createToolRuleNameSet, normalizeToolNameAlias } from "../../tool/tool-visibility.js";
import type { ToolEntry } from "../../tool/types.js";
import { builtInTools } from "../../tool/handlers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { RuntimeCapabilityController } from "../live-capabilities.js";
import type {
  PreparedRuntimeCapabilities,
  RuntimeCapabilitiesStatus,
} from "../live-capabilities.js";
import type { AgentRuntimeDeps } from "../types.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { resolveRuntimeDisallowedTools } from "../helpers/tool-allowlist.js";
import { collectRuntimeBuiltInTools, createRuntimeHookRunner } from "../helpers/runtime-tools.js";

/**
 * Creates the source bridge after core's built-in registry exists. The source cannot access this
 * runtime directly: it only returns a complete staged candidate and core publishes it here.
 */
export function createRuntimeCapabilityController(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): RuntimeCapabilityController | undefined {
  const source = deps.capabilitySource;
  if (!source) return undefined;

  let controller: RuntimeCapabilityController | undefined;
  controller = new RuntimeCapabilityController({
    buildEntries: (input) => buildCapabilityRegistryEntries(runtime, deps, input),
    filterTools: (tools) => filterPreparedTools(runtime, tools),
    onAdopt: (prepared) => applyPreparedCapabilities(runtime, deps, prepared),
    onSourceChange: () => {
      // Watchers are only a prompt to stage a new revision. The controller owns the queued work,
      // and rechecks idleness after asynchronous preparation so no catalog can publish mid-turn.
      controller?.scheduleRefreshWhenIdle({ traceContext: runtime.rootTraceContext }, () =>
        isRuntimeCapabilityIdle(runtime),
      );
    },
    registry: runtime.registry,
    source,
  });
  // A source is permitted to synchronously report an already-dirty watcher while `subscribe` is
  // being installed. At that point the closure above has not received the controller yet.
  if (controller.getStatus().status === "loading") {
    controller.scheduleRefreshWhenIdle({ traceContext: runtime.rootTraceContext }, () =>
      isRuntimeCapabilityIdle(runtime),
    );
  }
  return controller;
}

/**
 * Public refreshes only publish while the runtime is idle. An active turn performs the refresh at
 * its explicit model boundary, preserving one coherent catalog for each completed model/tool step.
 */
export async function refreshCapabilities(
  this: AgentRuntimeInternal,
  options: { abortSignal?: AbortSignal; traceContext?: TraceContext } = {},
): Promise<RuntimeCapabilitiesStatus> {
  const controller = this.capabilityController;
  if (!controller) return { status: "ready" };
  if (!isRuntimeCapabilityIdle(this)) {
    controller.markDirty();
    return controller.getStatus();
  }

  const status = await controller.refreshWhenIdle(
    {
      abortSignal: options.abortSignal,
      revision: controller.getStatus().revision,
      traceContext: options.traceContext ?? this.rootTraceContext,
    },
    () => isRuntimeCapabilityIdle(this),
  );
  if (isRuntimeCapabilityIdle(this)) {
    rebuildContextForCapabilityRevision(this, status.revision);
  }
  return status;
}

export function getCapabilitiesStatus(this: AgentRuntimeInternal): RuntimeCapabilitiesStatus {
  return this.capabilityController?.getStatus() ?? { status: "ready" };
}

export function subscribeCapabilities(
  this: AgentRuntimeInternal,
  listener: (status: RuntimeCapabilitiesStatus) => void,
): () => void {
  if (!this.capabilityController) {
    try {
      listener({ status: "ready" });
    } catch {
      // The no-source path still exposes an observer API; a consumer callback cannot interrupt
      // runtime construction or a caller's catalog read.
    }
    return () => undefined;
  }
  return this.capabilityController.subscribe(listener);
}

export function getPluginReferenceCatalog(
  this: AgentRuntimeInternal,
): PluginReferenceCatalog | undefined {
  return (
    this.config.pluginReferenceCatalog &&
    clonePluginReferenceCatalog(this.config.pluginReferenceCatalog)
  );
}

export function createInheritedCapabilitySource(
  this: AgentRuntimeInternal,
  options?: import("../live-capabilities.js").InheritedRuntimeCapabilitySourceOptions,
): import("../live-capabilities.js").RuntimeCapabilitySource | undefined {
  return this.capabilityController?.createInheritedSource(options);
}

export function disposeCapabilities(this: AgentRuntimeInternal): Promise<void> {
  const controller = this.capabilityController;
  if (!controller) return Promise.resolve();
  this.capabilityDisposePromise ??= disposeRuntimeCapabilities(this, controller);
  return this.capabilityDisposePromise;
}

/** Always probes at a model boundary, even if the filesystem watcher has not fired yet. */
export async function refreshCapabilitiesAtModelBoundary(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    model?: import("@zcode/contracts").Model;
    traceContext: TraceContext;
    turnRequestEntries?: readonly RuntimeMessageEntry[];
  },
): Promise<readonly RuntimeMessageEntry[] | undefined> {
  const controller = this.capabilityController;
  if (!controller) return undefined;

  const status = await controller.refresh({
    abortSignal: options.abortSignal,
    revision: controller.getStatus().revision,
    traceContext: options.traceContext,
  });
  return rebuildContextForCapabilityRevision(this, status.revision, {
    model: options.model,
    turnRequestEntries: options.turnRequestEntries,
  });
}

export function acquireCapabilitiesLease(this: AgentRuntimeInternal): () => Promise<void> {
  return this.capabilityController?.acquireLease() ?? (async () => undefined);
}

async function disposeRuntimeCapabilities(
  runtime: AgentRuntimeInternal,
  controller: RuntimeCapabilityController,
): Promise<void> {
  // A detached local agent holds an inherited source lease until its child runtime unwinds. Stop
  // it before draining the controller, rather than timing out and closing a port under its handler.
  await Promise.all([
    cancelCapabilityBackgroundChildren(runtime),
    runtime.cancelRunningRuntimeBackgroundTasks({
      reason: "subagent_cancelled",
      traceContext: runtime.rootTraceContext,
    }),
  ]);
  await controller.dispose();
}

async function cancelCapabilityBackgroundChildren(runtime: AgentRuntimeInternal): Promise<void> {
  const tasks = Object.values(runtime.runtimeTaskRegistry.all()).filter(
    (task) =>
      task.type === "local_agent" && task.isBackgrounded === true && task.status === "running",
  );
  for (const task of tasks) {
    const result = await runtime.stopBackgroundTask(task.taskId, {
      traceContext: runtime.rootTraceContext,
    });
    if (!result.ok) {
      throw new Error(
        `Could not stop capability-dependent background agent ${task.taskId}: ${result.reason}`,
      );
    }
  }
}

function applyPreparedCapabilities(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  prepared: PreparedRuntimeCapabilities,
): () => void {
  const previous = {
    hookRunner: runtime.hookRunner,
    mcp: runtime.config.mcp,
    mcpInitialized: runtime.mcpInitialized,
    mcpPort: runtime.mcpPort,
    mcpStartupPromise: runtime.mcpStartupPromise,
    mcpToolsRegistered: runtime.mcpToolsRegistered,
    builtInToolNames: new Set(runtime.builtInToolNames),
    capabilityContextRevision: runtime.capabilityContextRevision,
    capabilityInstructions: runtime.capabilityInstructions,
    pluginReferenceCatalog: runtime.config.pluginReferenceCatalog,
    runtimeFeatures: runtime.config.runtimeFeatures,
    skillLoadOutcome: runtime.skillLoadOutcome,
    skillMetadataBudget: runtime.config.skillMetadataBudget,
    skillPort: runtime.skillPort,
    subagents: runtime.config.subagents,
    hooks: runtime.config.hooks,
  };
  const restore = (): void => {
    runtime.hookRunner = previous.hookRunner;
    runtime.skillPort = previous.skillPort;
    runtime.capabilityContextRevision = previous.capabilityContextRevision;
    runtime.capabilityInstructions = previous.capabilityInstructions;
    runtime.skillLoadOutcome = previous.skillLoadOutcome;
    runtime.config.pluginReferenceCatalog = previous.pluginReferenceCatalog;
    runtime.config.runtimeFeatures = previous.runtimeFeatures;
    runtime.config.skillMetadataBudget = previous.skillMetadataBudget;
    runtime.config.subagents = previous.subagents;
    runtime.config.hooks = previous.hooks;
    runtime.config.mcp = previous.mcp;
    runtime.mcpPort = previous.mcpPort;
    runtime.mcpStartupPromise = previous.mcpStartupPromise;
    runtime.mcpInitialized = previous.mcpInitialized;
    runtime.mcpToolsRegistered = previous.mcpToolsRegistered;
    runtime.builtInToolNames = previous.builtInToolNames;
    runtime.invalidateToolCache();
  };

  try {
    runtime.skillPort = prepared.skillPort;
    // Context entries are immutable history prefix messages. Mark it stale now; the next idle
    // refresh or model boundary rebuilds it from this atomic capability snapshot.
    runtime.capabilityContextRevision = undefined;
    runtime.capabilityInstructions = normalizeCapabilityInstructions(prepared.instructions);
    runtime.skillLoadOutcome = cloneSkillLoadOutcome(prepared.skills);
    runtime.config.pluginReferenceCatalog = clonePluginReferenceCatalog(
      prepared.pluginReferenceCatalog,
    );

    if (prepared.runtimeConfig) {
      Object.assign(runtime.config, prepared.runtimeConfig);
      // The default subagent port resolves profiles through a live getter. Keeping that port stable
      // preserves existing task/message registries rather than orphaning a running child.
      if (!deps.hookRunner) {
        runtime.hookRunner = createRuntimeHookRunner(runtime, deps, runtime.sessionId);
      }
    }

    if (runtime.capabilitySource?.ownsMcp) {
      const snapshot = prepared.mcp?.snapshot ?? { statuses: {}, tools: [] };
      runtime.config.mcp = prepared.mcp?.config ?? { enabled: false };
      runtime.mcpPort = prepared.mcp?.port;
      runtime.mcpStartupPromise = Promise.resolve(snapshot);
      runtime.mcpInitialized = true;
      runtime.mcpToolsRegistered = true;
    }

    runtime.builtInToolNames = new Set(
      collectRuntimeBuiltInTools(runtime, deps).map((entry) => entry.metadata.name),
    );
    runtime.invalidateToolCache();
    return restore;
  } catch (error) {
    restore();
    throw error;
  }
}

function buildCapabilityRegistryEntries(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  input: {
    currentEntries: readonly ToolEntry[];
    effectiveTools: readonly ToolEntry[];
    extensionToolNames: ReadonlySet<string>;
    prepared: PreparedRuntimeCapabilities;
  },
): readonly ToolEntry[] {
  rejectReservedBuiltInToolIdentities(input.effectiveTools);
  const config = input.prepared.runtimeConfig
    ? { ...runtime.config, ...input.prepared.runtimeConfig }
    : runtime.config;
  const builtIns = collectRuntimeBuiltInTools(runtime, deps, {
    config,
    skillPort: input.prepared.skillPort,
    subagentPort: config.subagents?.enabled === false ? undefined : runtime.subagentPort,
  });
  const preserved = input.currentEntries.filter(
    (entry) =>
      !input.extensionToolNames.has(entry.metadata.name) &&
      !runtime.builtInToolNames.has(entry.metadata.name) &&
      // A source that owns MCP must replace a seeded legacy MCP catalog during its first
      // adoption as well. Keeping it would publish duplicate handlers from two connection owners.
      (!runtime.capabilitySource?.ownsMcp || entry.metadata.mcpPresentation === undefined),
  );
  return [...builtIns, ...preserved, ...input.effectiveTools];
}

function rejectReservedBuiltInToolIdentities(entries: readonly ToolEntry[]): void {
  const reserved = new Set<string>();
  for (const entry of builtInTools) {
    reserved.add(entry.metadata.name);
    for (const alias of entry.aliases ?? []) reserved.add(alias);
  }
  for (const entry of entries) {
    for (const name of [entry.metadata.name, ...(entry.aliases ?? [])]) {
      if (reserved.has(name)) {
        throw new Error(`Extension capability cannot replace reserved built-in tool: ${name}`);
      }
    }
  }
}

function filterPreparedTools(
  runtime: AgentRuntimeInternal,
  tools: readonly ToolEntry[],
): readonly ToolEntry[] {
  const allowed = runtime.config.toolAllowlist
    ? new Set(runtime.config.toolAllowlist.map(normalizeToolNameAlias))
    : undefined;
  const disallowed = createToolRuleNameSet(resolveRuntimeDisallowedTools(runtime.config));

  return tools.filter((entry) => {
    const names = [entry.metadata.name, ...(entry.aliases ?? [])].map(normalizeToolNameAlias);
    if (names.some((name) => disallowed?.has(name))) return false;
    return !allowed || names.some((name) => allowed.has(name));
  });
}

function rebuildContextForCapabilityRevision(
  runtime: AgentRuntimeInternal,
  revision: string | undefined,
  options: {
    model?: import("@zcode/contracts").Model;
    turnRequestEntries?: readonly RuntimeMessageEntry[];
  } = {},
): readonly RuntimeMessageEntry[] | undefined {
  if (!runtime.contextInitialized || runtime.capabilityContextRevision === revision)
    return undefined;
  const entries = rebuildContextPrefix(runtime, options);
  runtime.capabilityContextRevision = revision;
  return entries;
}

function cloneSkillLoadOutcome(outcome: SkillLoadOutcome): SkillLoadOutcome {
  return {
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    skills: outcome.skills.map((skill) => ({ ...skill })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

function normalizeCapabilityInstructions(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function clonePluginReferenceCatalog(catalog: PluginReferenceCatalog): PluginReferenceCatalog {
  return {
    plugins: catalog.plugins.map((plugin) => ({
      ...plugin,
      conflictingPluginIds: [...plugin.conflictingPluginIds],
      mcpServerNames: [...plugin.mcpServerNames],
      skillQualifiedNames: [...plugin.skillQualifiedNames],
      subagentNames: [...plugin.subagentNames],
    })),
  };
}

function isRuntimeCapabilityIdle(runtime: AgentRuntimeInternal): boolean {
  // A turn reserves admission before context initialization. Treat that reservation as active so
  // an idle watcher cannot publish while the first model request is assembling its context.
  return runtime.activeTurn === undefined && runtime.activeTurnStartReservation === undefined;
}
