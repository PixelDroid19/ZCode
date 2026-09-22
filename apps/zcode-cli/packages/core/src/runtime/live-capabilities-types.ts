import type {
  McpConnectionSnapshot,
  McpPort,
  PluginReferenceCatalog,
  SkillLoadOutcome,
  SkillPort,
  TraceContext,
} from "@zcode/contracts";
import type { ToolRegistry } from "../tool/registry.js";
import type { ToolEntry } from "../tool/types.js";
import type { AgentRuntimeConfig } from "./types.js";

/** A coherent MCP projection staged by bootstrap before a capability revision is published. */
export interface PreparedRuntimeMcpCapabilities {
  config: NonNullable<AgentRuntimeConfig["mcp"]>;
  port?: McpPort;
  snapshot: McpConnectionSnapshot;
}

/**
 * Optional configuration that belongs to the live capability snapshot rather than to a caller's
 * persisted session preference. The source resolves precedence before it reaches core.
 */
export type PreparedRuntimeCapabilitiesConfig = Pick<
  AgentRuntimeConfig,
  "hooks" | "runtimeFeatures" | "skillMetadataBudget" | "subagents"
>;

/** A fully staged set of extension-owned capabilities. */
export interface PreparedRuntimeCapabilities {
  revision: string;
  tools: readonly ToolEntry[];
  skills: SkillLoadOutcome;
  skillPort?: SkillPort;
  pluginReferenceCatalog: PluginReferenceCatalog;
  /** Source-authored, stable guidance for a capability surface (for example live tool manifests). */
  instructions?: string;
  mcp?: PreparedRuntimeMcpCapabilities;
  runtimeConfig?: PreparedRuntimeCapabilitiesConfig;
  /** Publishes source-owned staged resources after core has accepted the complete candidate. */
  commit?(): void;
  /** Releases a rejected, superseded, or shutdown candidate after its active calls drain. */
  release?(): Promise<void> | void;
}

export interface RuntimeCapabilitySourcePrepareInput {
  abortSignal?: AbortSignal;
  revision?: string;
  traceContext: TraceContext;
}

/**
 * Bootstrap owns I/O, validation, and resource staging. Core only asks for a prepared snapshot
 * and never discovers extension files or opens replacement connections itself.
 */
export interface RuntimeCapabilitySource {
  /** The source stages the complete MCP inventory and disables legacy core MCP startup. */
  ownsMcp?: boolean;
  prepare(
    input: RuntimeCapabilitySourcePrepareInput,
  ): Promise<PreparedRuntimeCapabilities | undefined>;
  /** Signals that a later safe boundary should prepare again. It must not mutate core directly. */
  subscribe?(onChange: () => void): () => void;
  dispose?(): Promise<void> | void;
}

export interface RuntimeCapabilitiesStatus {
  error?: string;
  revision?: string;
  status: "ready" | "loading" | "error";
}

/** A leased child view deliberately excludes source lifecycle callbacks. */
export type InheritedRuntimeCapabilities = Omit<
  PreparedRuntimeCapabilities,
  "commit" | "release" | "runtimeConfig"
> & {
  /** Child factories may explicitly provide a narrowed configuration snapshot when safe. */
  runtimeConfig?: PreparedRuntimeCapabilitiesConfig;
};

export interface InheritedRuntimeCapabilitySourceOptions {
  /**
   * Adapts the current source snapshot for a child (for example, scoped MCP handlers). The default
   * omits parent runtimeConfig so a child keeps its own subagent/hook/feature policy.
   */
  transform?(capabilities: Readonly<InheritedRuntimeCapabilities>): InheritedRuntimeCapabilities;
  /**
   * Workflow factories can inherit updated hooks/features/skill budget while preserving their own
   * subagent policy. Normal subagents leave this false so they remain non-recursive.
   */
  inheritRuntimeConfig?: boolean;
}

export interface RuntimeCapabilityControllerOptions {
  /**
   * Produces the complete next registry before publication. It allows core-owned feature gates to
   * change in the same synchronous registry swap as a source candidate.
   */
  buildEntries?(input: {
    currentEntries: readonly ToolEntry[];
    effectiveTools: readonly ToolEntry[];
    extensionToolNames: ReadonlySet<string>;
    prepared: PreparedRuntimeCapabilities;
  }): readonly ToolEntry[];
  filterTools?(tools: readonly ToolEntry[]): readonly ToolEntry[];
  /** Return a synchronous rollback for state that is published alongside the registry. */
  onAdopt?(prepared: PreparedRuntimeCapabilities): void | (() => void);
  onSourceChange?(): void;
  registry: ToolRegistry;
  source?: RuntimeCapabilitySource;
}
