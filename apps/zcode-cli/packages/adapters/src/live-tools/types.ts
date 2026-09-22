/** Declarative JSON Schema accepted at the live tool boundary. */
export type LiveToolJsonSchema = Record<string, unknown>;

export interface LiveToolSource {
  /** Deterministic discovery owner, such as `workspace:.zcode` or `plugin:example`. */
  owner: string;
  /** Globally unique manifest identity declared by the author. */
  manifestId: string;
  /** Absolute manifest path used for diagnostics and watcher registration. */
  manifestPath: string;
  /** Absolute source-root boundary used when the manifest was resolved. */
  rootPath: string;
}

export interface LiveToolArgvCommand {
  kind: "argv";
  /** A bare executable name. Local executable paths use the node-script form. */
  file: string;
  args: readonly string[];
}

export interface LiveToolNodeScriptCommand {
  kind: "node-script";
  args: readonly string[];
  /** Bytes captured during validation; they are not reread from the mutable source path. */
  contents: Uint8Array;
  /** SHA-256 over `contents`, verified again before snapshot materialization. */
  digest: string;
  extension: ".cjs" | ".js" | ".mjs";
  /** Absolute source path retained only for diagnostics and watcher registration. */
  sourcePath: string;
}

export type LiveToolCommand = LiveToolArgvCommand | LiveToolNodeScriptCommand;

export interface LiveTool {
  /** `${manifestId}:${name}`; stable inside a loaded snapshot. */
  identity: string;
  name: string;
  description: string;
  inputSchema: LiveToolJsonSchema;
  outputSchema: LiveToolJsonSchema;
  source: LiveToolSource;
  command: LiveToolCommand;
}

export interface LiveToolPluginRoot {
  /** Stable enabled-plugin identifier; no plugin code is imported by this adapter. */
  id: string;
  /** Plugin package root; the loader scans its direct `tools/*.json` child manifests. */
  path: string;
}

export interface LoadLiveToolsInput {
  workspacePath: string;
  /** Additional directories containing direct `*.json` live-tool manifests. */
  userRoots?: readonly string[];
  /** Plugin package roots supplied by the enabled-plugin resolver, not by plugin JavaScript. */
  pluginRoots?: readonly LiveToolPluginRoot[];
}

export interface LoadedLiveTools {
  /** Stable SHA-256 content revision for this complete contribution set. */
  revision: string;
  tools: readonly LiveTool[];
  /** Roots, manifests, and scripts suitable for best-effort watcher registration. */
  watchPaths: readonly string[];
}

export type LiveToolConfigurationErrorCode =
  | "duplicate_manifest_id"
  | "duplicate_plugin_root"
  | "duplicate_tool_name"
  | "invalid_command"
  | "invalid_manifest"
  | "invalid_root"
  | "invalid_schema"
  | "script_digest_mismatch"
  | "unsupported_script_extension"
  | "unsafe_path";

export interface LiveToolScriptLease {
  path: string;
  dispose(): Promise<void>;
}
