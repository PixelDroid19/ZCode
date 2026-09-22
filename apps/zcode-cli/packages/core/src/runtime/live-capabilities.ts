import type { ToolRegistry } from "../tool/registry.js";
import type { ToolEntry } from "../tool/types.js";
import type {
  InheritedRuntimeCapabilities,
  InheritedRuntimeCapabilitySourceOptions,
  PreparedRuntimeCapabilities,
  PreparedRuntimeCapabilitiesConfig,
  RuntimeCapabilitiesStatus,
  RuntimeCapabilityControllerOptions,
  RuntimeCapabilitySource,
  RuntimeCapabilitySourcePrepareInput,
} from "./live-capabilities-types.js";

export type {
  InheritedRuntimeCapabilities,
  InheritedRuntimeCapabilitySourceOptions,
  PreparedRuntimeCapabilities,
  PreparedRuntimeCapabilitiesConfig,
  PreparedRuntimeMcpCapabilities,
  RuntimeCapabilitiesStatus,
  RuntimeCapabilityControllerOptions,
  RuntimeCapabilitySource,
  RuntimeCapabilitySourcePrepareInput,
} from "./live-capabilities-types.js";

const CAPABILITY_REFRESH_ERROR = "Capability refresh failed";

/**
 * Serializes preparation and atomically replaces only the extension-owned portion of a registry.
 * The controller is deliberately source-agnostic so tests can exercise adoption without files,
 * processes, MCP connections, or bootstrap wiring.
 */
export class RuntimeCapabilityController {
  private activeLeases = new Map<PreparedRuntimeCapabilities, number>();
  private current?: PreparedRuntimeCapabilities;
  private dirty = true;
  private disposed = false;
  private extensionToolNames = new Set<string>();
  private idleRefreshScheduled = false;
  private disposePromise?: Promise<void>;
  private refreshTail: Promise<void> = Promise.resolve();
  private retired = new Set<PreparedRuntimeCapabilities>();
  private status: RuntimeCapabilitiesStatus = { status: "ready" };
  private statusListeners = new Set<(status: RuntimeCapabilitiesStatus) => void>();
  private unsubscribeSource?: () => void;
  private disposeWaiters = new Set<() => void>();

  constructor(private readonly options: RuntimeCapabilityControllerOptions) {
    this.unsubscribeSource = options.source?.subscribe?.(() => {
      this.markDirty();
      options.onSourceChange?.();
    });
  }

  getStatus(): RuntimeCapabilitiesStatus {
    return { ...this.status };
  }

  markDirty(): void {
    const wasDirty = this.dirty;
    this.dirty = true;
    // An initial source notification can arrive before the first prepare while `dirty` is already
    // true. It is still meaningful to publish loading once, but repeated watcher bursts must not
    // create a status-notification loop.
    if (!wasDirty || this.status.status !== "loading") {
      this.setStatus({
        ...(this.status.revision === undefined ? {} : { revision: this.status.revision }),
        status: "loading",
      });
    }
  }

  subscribe(listener: (status: RuntimeCapabilitiesStatus) => void): () => void {
    this.statusListeners.add(listener);
    this.notifyStatusListener(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  refresh(input: RuntimeCapabilitySourcePrepareInput): Promise<RuntimeCapabilitiesStatus> {
    return this.enqueueRefresh(input);
  }

  /**
   * Queues a watcher-triggered refresh without allowing a candidate to publish after a turn has
   * started. A model boundary uses `refresh` and is the explicit safe point while a turn is active.
   */
  refreshWhenIdle(
    input: RuntimeCapabilitySourcePrepareInput,
    isIdle: () => boolean,
  ): Promise<RuntimeCapabilitiesStatus> {
    return this.enqueueRefresh(input, isIdle);
  }

  /**
   * Coalesces watcher bursts into the controller's serialized queue. The promise is retained by
   * `refreshTail`, so a following model boundary waits for an in-flight idle read before adopting.
   */
  scheduleRefreshWhenIdle(input: RuntimeCapabilitySourcePrepareInput, isIdle: () => boolean): void {
    if (this.disposed || this.idleRefreshScheduled) return;
    this.idleRefreshScheduled = true;
    queueMicrotask(() => {
      this.idleRefreshScheduled = false;
      if (this.disposed || !isIdle()) return;
      // `enqueueRefresh` retains the work in `refreshTail`; consume only unexpected listener
      // failures so an idle notification cannot become an unhandled process rejection.
      void this.refreshWhenIdle(input, isIdle).catch(() => undefined);
    });
  }

  private enqueueRefresh(
    input: RuntimeCapabilitySourcePrepareInput,
    isIdle?: () => boolean,
  ): Promise<RuntimeCapabilitiesStatus> {
    const work = this.refreshTail.then(async () => {
      await this.refreshNow(input, isIdle);
    });
    this.refreshTail = work.then(
      () => undefined,
      () => undefined,
    );
    return work.then(() => this.getStatus());
  }

  acquireLease(): () => Promise<void> {
    const snapshot = this.current;
    if (!snapshot) return async () => undefined;

    this.activeLeases.set(snapshot, (this.activeLeases.get(snapshot) ?? 0) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const active = (this.activeLeases.get(snapshot) ?? 1) - 1;
      if (active > 0) {
        this.activeLeases.set(snapshot, active);
        return;
      }
      this.activeLeases.delete(snapshot);
      await this.releaseIfDrained(snapshot);
    };
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeNow();
    return this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    this.disposed = true;
    this.unsubscribeSource?.();
    this.unsubscribeSource = undefined;
    // A prepare may still be connecting/staging a candidate. It owns source resources until its
    // normal rejection path releases them, so source.dispose must wait rather than closing below it.
    await this.refreshTail;
    if (this.current) {
      const previous = this.current;
      this.current = undefined;
      await this.retire(previous);
    }
    if (this.retired.size > 0) {
      await new Promise<void>((resolve) => {
        this.disposeWaiters.add(resolve);
      });
    }
    await this.options.source?.dispose?.();
  }

  /**
   * Gives a child runtime an immutable view of the current adopted snapshot and retains the parent
   * generation until that child disposes. The child never commits/releases the parent's resources.
   */
  createInheritedSource(
    options: InheritedRuntimeCapabilitySourceOptions = {},
  ): RuntimeCapabilitySource | undefined {
    const snapshot = this.current;
    if (!snapshot || this.disposed) return undefined;
    // Child runtimes inherit the parent's published extension surface, never the raw source list.
    // Otherwise an explicitly named child profile could resurrect a parent-denied source tool.
    const visibleTools = snapshot.tools.filter((entry) =>
      this.extensionToolNames.has(entry.metadata.name),
    );
    const releaseParentLease = this.acquireLease();
    let disposed = false;
    return {
      ownsMcp: this.options.source?.ownsMcp,
      async prepare(input) {
        input.abortSignal?.throwIfAborted();
        if (disposed || input.revision === snapshot.revision) return undefined;
        const base: InheritedRuntimeCapabilities = {
          instructions: snapshot.instructions,
          mcp: snapshot.mcp,
          pluginReferenceCatalog: snapshot.pluginReferenceCatalog,
          revision: snapshot.revision,
          skillPort: snapshot.skillPort,
          skills: snapshot.skills,
          tools: visibleTools,
          ...(options.inheritRuntimeConfig && snapshot.runtimeConfig
            ? { runtimeConfig: inheritedRuntimeConfig(snapshot.runtimeConfig) }
            : {}),
        };
        return options.transform?.(base) ?? base;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await releaseParentLease();
      },
    };
  }

  private async refreshNow(
    input: RuntimeCapabilitySourcePrepareInput,
    isIdle?: () => boolean,
  ): Promise<void> {
    const source = this.options.source;
    if (!source || this.disposed) return;
    if (isIdle && !isIdle()) {
      this.markDirty();
      return;
    }

    const shouldPublishLoading = this.dirty || this.status.revision === undefined;
    if (shouldPublishLoading) {
      this.setStatus({
        ...(this.status.revision === undefined ? {} : { revision: this.status.revision }),
        status: "loading",
      });
    }
    this.dirty = false;

    let prepared: PreparedRuntimeCapabilities | undefined;
    try {
      prepared = await source.prepare({
        abortSignal: input.abortSignal,
        revision: this.status.revision,
        traceContext: input.traceContext,
      });
      if (this.disposed) {
        await this.safeRelease(prepared);
        return;
      }
      // A source read can span the instant a command starts. Do not publish its catalog in the
      // middle of that turn; release the staged candidate and let the next model boundary prepare
      // against the still-dirty source.
      if (isIdle && !isIdle()) {
        this.markDirty();
        await this.safeRelease(prepared);
        return;
      }
      if (!prepared) {
        // 修复：恢复原始文件后可能没有 watcher 提示；成功读取即应清除旧错误，保留已发布版本。
        if (this.status.status !== "ready") {
          this.setStatus({
            ...(this.current?.revision ? { revision: this.current.revision } : {}),
            status: "ready",
          });
        }
        return;
      }

      if (prepared.revision === this.current?.revision) {
        await this.safeRelease(prepared);
        this.setStatus({ revision: this.current.revision, status: "ready" });
        return;
      }

      await this.adopt(prepared);
    } catch {
      await this.safeRelease(prepared);
      if (input.abortSignal?.aborted) {
        // Cancellation does not invalidate the last complete snapshot. Leave the source dirty so
        // the next safe boundary retries it, but do not present an aborted model turn as a catalog
        // failure in the idle UI.
        this.dirty = true;
        if (this.status.status === "loading") {
          this.setStatus({
            ...(this.current?.revision ? { revision: this.current.revision } : {}),
            status: "ready",
          });
        }
        return;
      }
      this.setStatus({
        ...(this.current?.revision ? { revision: this.current.revision } : {}),
        error: CAPABILITY_REFRESH_ERROR,
        status: "error",
      });
    }
  }

  private async adopt(prepared: PreparedRuntimeCapabilities): Promise<void> {
    const previousEntries = entriesFromRegistry(this.options.registry);
    const effectiveTools = this.options.filterTools?.(prepared.tools) ?? prepared.tools;
    const nextEntries = this.options.buildEntries
      ? this.options.buildEntries({
          currentEntries: previousEntries,
          effectiveTools,
          extensionToolNames: this.extensionToolNames,
          prepared,
        })
      : [
          ...previousEntries.filter((entry) => !this.extensionToolNames.has(entry.metadata.name)),
          ...effectiveTools,
        ];

    this.replaceRegistry(nextEntries);
    let rollbackAdoption: (() => void) | undefined;
    try {
      const adoptionResult = this.options.onAdopt?.(prepared);
      rollbackAdoption = typeof adoptionResult === "function" ? adoptionResult : undefined;
      prepared.commit?.();
    } catch (error) {
      rollbackAdoption?.();
      this.replaceRegistry(previousEntries);
      throw error;
    }

    const previous = this.current;
    this.current = prepared;
    this.extensionToolNames = new Set(effectiveTools.map((entry) => entry.metadata.name));
    this.setStatus({ revision: prepared.revision, status: "ready" });
    if (previous) {
      await this.retire(previous);
    }
  }

  private replaceRegistry(entries: readonly ToolEntry[]): void {
    if (!this.options.registry.replaceAll) {
      // A legacy custom registry can only unregister/register entry by entry. Publishing through
      // that surface would expose a partial catalog (or lose the old catalog on a later failure),
      // which violates the source contract. Refuse adoption and retain the current revision.
      throw new Error("Live capability adoption requires ToolRegistry.replaceAll");
    }
    this.options.registry.replaceAll(entries);
  }

  private async retire(snapshot: PreparedRuntimeCapabilities): Promise<void> {
    this.retired.add(snapshot);
    await this.releaseIfDrained(snapshot);
  }

  private async releaseIfDrained(snapshot: PreparedRuntimeCapabilities): Promise<void> {
    if (!this.retired.has(snapshot) || (this.activeLeases.get(snapshot) ?? 0) > 0) return;
    this.retired.delete(snapshot);
    await this.safeRelease(snapshot);
    if (this.retired.size === 0) {
      for (const resolve of this.disposeWaiters) resolve();
      this.disposeWaiters.clear();
    }
  }

  private async safeRelease(snapshot: PreparedRuntimeCapabilities | undefined): Promise<void> {
    try {
      await snapshot?.release?.();
    } catch {
      // A release failure must not revoke the already published replacement or leak diagnostics.
    }
  }

  private setStatus(status: RuntimeCapabilitiesStatus): void {
    if (sameStatus(this.status, status)) return;
    this.status = status;
    for (const listener of this.statusListeners) this.notifyStatusListener(listener);
  }

  private notifyStatusListener(listener: (status: RuntimeCapabilitiesStatus) => void): void {
    try {
      listener(this.getStatus());
    } catch {
      // Status consumers are observers only. A UI callback must not roll back or release a
      // generation that has already been atomically adopted; remove the broken observer instead.
      this.statusListeners.delete(listener);
    }
  }
}

function inheritedRuntimeConfig(
  config: PreparedRuntimeCapabilitiesConfig,
): PreparedRuntimeCapabilitiesConfig {
  const { subagents: _subagents, ...inherited } = config;
  return inherited;
}

function entriesFromRegistry(registry: ToolRegistry): ToolEntry[] {
  return registry
    .list()
    .map((name) => registry.get(name))
    .filter((entry): entry is ToolEntry => entry !== undefined);
}

function sameStatus(left: RuntimeCapabilitiesStatus, right: RuntimeCapabilitiesStatus): boolean {
  return (
    left.error === right.error && left.revision === right.revision && left.status === right.status
  );
}
