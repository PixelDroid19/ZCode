import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { McpServerConfig } from "@zcode/contracts";
import { ZCodeConfigFileSchema } from "../config/schema.js";

export interface LoadDirectoryMcpServersInput {
  /** Absolute or relative home directory whose configured MCP files are read. */
  homeDirectory: string;
  /** Absolute or relative workspace directory whose MCP files override user entries. */
  workspacePath: string;
}

export interface LoadedDirectoryMcpServers {
  /** Effective enabled configurations after directory and workspace precedence. */
  servers: Record<string, McpServerConfig>;
  /** All canonical, absolute source files, including files that do not exist yet. */
  watchPaths: readonly string[];
}

export type DirectoryMcpConfigurationErrorCode =
  | "invalid_input"
  | "invalid_config"
  | "unreadable_config";

export class DirectoryMcpConfigurationError extends Error {
  readonly code: DirectoryMcpConfigurationErrorCode;
  readonly path?: string;

  constructor(
    code: DirectoryMcpConfigurationErrorCode,
    message: string,
    options: { cause?: unknown; path?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DirectoryMcpConfigurationError";
    this.code = code;
    this.path = options.path;
  }
}

type DirectoryMcpSource = "zcode" | "agents";
type DirectoryMcpScope = "user" | "workspace";

interface DirectoryMcpPaths {
  agents: string;
  zcode: string;
}

interface DirectoryMcpInputPaths {
  user: DirectoryMcpPaths;
  workspace: DirectoryMcpPaths;
}

/**
 * Resolve the Desktop directory-MCP projection without importing Desktop code.
 *
 * For each scope, non-empty `.zcode` entries take precedence over `.agents`.
 * Workspace entries then replace user entries by name. Disabled workspace entries
 * deliberately remain until the merge so that they act as user-entry tombstones;
 * only enabled entries are returned to a runtime caller.
 */
export async function loadDirectoryMcpServers(
  input: LoadDirectoryMcpServersInput,
): Promise<LoadedDirectoryMcpServers> {
  const homeDirectory = resolveRequiredDirectory(input?.homeDirectory, "homeDirectory");
  const workspacePath = resolveRequiredDirectory(input?.workspacePath, "workspacePath");
  const paths = buildDirectoryMcpPaths(homeDirectory, workspacePath);

  const userServers = await readPreferredScope("user", paths.user);
  const workspaceServers = await readPreferredScope("workspace", paths.workspace);
  const merged = { ...userServers, ...workspaceServers };

  const servers = Object.fromEntries(
    Object.entries(merged)
      .filter(([, config]) => config.enabled !== false)
      .sort(([left], [right]) => compareNames(left, right)),
  );

  return {
    servers,
    watchPaths: Object.freeze([
      paths.user.zcode,
      paths.user.agents,
      paths.workspace.zcode,
      paths.workspace.agents,
    ]),
  };
}

function resolveRequiredDirectory(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DirectoryMcpConfigurationError("invalid_input", `${name} must be a non-empty path`);
  }
  return resolve(value.trim());
}

function buildDirectoryMcpPaths(
  homeDirectory: string,
  workspacePath: string,
): DirectoryMcpInputPaths {
  return {
    user: {
      zcode: resolve(homeDirectory, ".zcode", "cli", "config.json"),
      agents: resolve(homeDirectory, ".agents", "mcp.json"),
    },
    workspace: {
      zcode: resolve(workspacePath, ".zcode", "config.json"),
      agents: resolve(workspacePath, ".agents", "mcp.json"),
    },
  };
}

async function readPreferredScope(
  scope: DirectoryMcpScope,
  paths: DirectoryMcpPaths,
): Promise<Record<string, McpServerConfig>> {
  const zcodeServers = await readDirectoryMcpFile(paths.zcode, "zcode", scope);
  // A disabled entry is still an entry: it intentionally blocks same-scope `.agents`.
  if (Object.keys(zcodeServers).length > 0) {
    return zcodeServers;
  }
  return readDirectoryMcpFile(paths.agents, "agents", scope);
}

async function readDirectoryMcpFile(
  filePath: string,
  source: DirectoryMcpSource,
  scope: DirectoryMcpScope,
): Promise<Record<string, McpServerConfig>> {
  const text = await readDirectoryMcpText(filePath, source, scope);
  if (text === undefined) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw invalidConfig(filePath, `Unable to parse ${scope} ${source} MCP config as JSON`, cause);
  }

  if (!isRecord(parsed)) {
    throw invalidConfig(filePath, `${scope} ${source} MCP config must contain a JSON object`);
  }

  try {
    const config = ZCodeConfigFileSchema.parse(toZCodeConfigShape(parsed, source));
    return config.mcp?.servers ?? {};
  } catch (cause) {
    throw invalidConfig(filePath, `${scope} ${source} MCP config is invalid`, cause);
  }
}

async function readDirectoryMcpText(
  filePath: string,
  source: DirectoryMcpSource,
  scope: DirectoryMcpScope,
): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      return undefined;
    }
    throw new DirectoryMcpConfigurationError(
      "unreadable_config",
      `Unable to read ${scope} ${source} MCP config: ${filePath}`,
      { cause, path: filePath },
    );
  }
}

function toZCodeConfigShape(
  parsed: Record<string, unknown>,
  source: DirectoryMcpSource,
): Record<string, unknown> {
  if (source === "zcode") {
    return "mcp" in parsed ? { mcp: parsed.mcp } : {};
  }
  return "mcpServers" in parsed ? { mcp: { servers: parsed.mcpServers } } : {};
}

function invalidConfig(
  filePath: string,
  message: string,
  cause?: unknown,
): DirectoryMcpConfigurationError {
  return new DirectoryMcpConfigurationError("invalid_config", `${message}: ${filePath}`, {
    cause,
    path: filePath,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
