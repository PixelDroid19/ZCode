import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LiveToolConfigurationError } from "./errors.js";
import {
  parseLiveToolManifest,
  type ParsedLiveToolDefinition,
  type ParsedLiveToolManifest,
} from "./schema.js";
import {
  createLiveToolSourceRoots,
  resolveLiveToolWorkspacePath,
  type LiveToolSourceRoot,
} from "./source-roots.js";
import type {
  LiveTool,
  LiveToolCommand,
  LiveToolNodeScriptCommand,
  LiveToolSource,
  LoadLiveToolsInput,
  LoadedLiveTools,
} from "./types.js";

const MAX_SCRIPT_BYTES = 256 * 1024;
const NODE_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

interface ReadSourceRootResult {
  tools: LiveTool[];
  watchPaths: string[];
}

interface DigestEntry {
  owner: string;
  manifestPath: string;
  manifestBytes: Uint8Array;
  scripts: Array<{ path: string; bytes: Uint8Array }>;
}

export async function loadLiveTools(input: LoadLiveToolsInput): Promise<LoadedLiveTools> {
  const workspacePath = requireWorkspacePath(input?.workspacePath);
  const resolvedWorkspacePath = resolve(workspacePath);
  const realWorkspacePath = await resolveLiveToolWorkspacePath(
    resolvedWorkspacePath,
    "workspacePath",
  );
  const roots = createLiveToolSourceRoots(input, resolvedWorkspacePath);
  const tools: LiveTool[] = [];
  const watchPaths = new Set<string>();
  const digestEntries: DigestEntry[] = [];
  const manifestIds = new Set<string>();
  const toolNames = new Set<string>();

  for (const root of roots) {
    const result = await readSourceRoot({
      digestEntries,
      manifestIds,
      realWorkspacePath,
      root,
      toolNames,
    });
    tools.push(...result.tools);
    result.watchPaths.forEach((path) => watchPaths.add(path));
  }

  const revision = digestLiveTools(digestEntries);
  return Object.freeze({
    revision,
    tools: Object.freeze(tools),
    watchPaths: Object.freeze([...watchPaths].sort(compareText)),
  });
}

async function readSourceRoot(input: {
  root: LiveToolSourceRoot;
  realWorkspacePath: string;
  manifestIds: Set<string>;
  toolNames: Set<string>;
  digestEntries: DigestEntry[];
}): Promise<ReadSourceRootResult> {
  const rootPath = resolve(input.root.path);
  const watchPaths = [rootPath];
  let initialStat: Stats | undefined;
  try {
    initialStat = await lstatIfExists(rootPath);
  } catch (cause) {
    throw new LiveToolConfigurationError("invalid_root", "Cannot inspect live tool source root", {
      cause,
      path: rootPath,
    });
  }
  if (initialStat === undefined) return { tools: [], watchPaths };
  if (initialStat.isSymbolicLink() || !initialStat.isDirectory()) {
    throw new LiveToolConfigurationError(
      "invalid_root",
      `Live tool source root must be a real directory: ${rootPath}`,
      { path: rootPath },
    );
  }

  let realRootPath: string;
  try {
    realRootPath = await realpath(rootPath);
  } catch (cause) {
    throw new LiveToolConfigurationError(
      "unsafe_path",
      "Live tool source root cannot be resolved",
      {
        cause,
        path: rootPath,
      },
    );
  }
  if (input.root.restrictToWorkspace && !isWithin(input.realWorkspacePath, realRootPath)) {
    throw new LiveToolConfigurationError(
      "unsafe_path",
      "Workspace live tool root resolves outside the workspace",
      { path: rootPath },
    );
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(rootPath, { encoding: "utf8", withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return { tools: [], watchPaths };
    throw new LiveToolConfigurationError("invalid_root", "Cannot read live tool source root", {
      cause,
      path: rootPath,
    });
  }

  const tools: LiveTool[] = [];
  for (const entry of entries
    .filter((entry) => entry.name.endsWith(".json"))
    .sort(compareDirectoryEntry)) {
    const manifestPath = join(rootPath, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new LiveToolConfigurationError(
        "unsafe_path",
        "Live tool manifests must be regular files, not symlinks or directories",
        { path: manifestPath },
      );
    }
    const manifestRealPath = await realpathWithin(manifestPath, realRootPath, "manifest");
    const manifestBytes = await readBoundedFile(manifestRealPath, "manifest", manifestPath);
    const manifest = parseLiveToolManifest(manifestBytes, manifestPath);
    if (input.manifestIds.has(manifest.id)) {
      throw new LiveToolConfigurationError(
        "duplicate_manifest_id",
        `Live tool manifest id ${manifest.id} is declared by more than one source`,
        { path: manifestPath },
      );
    }

    const source: LiveToolSource = Object.freeze({
      manifestId: manifest.id,
      manifestPath,
      owner: input.root.owner,
      rootPath,
    });
    const scriptDigestEntries: Array<{ path: string; bytes: Uint8Array }> = [];
    const manifestTools = await Promise.all(
      manifest.tools.map(async (definition) => {
        if (input.toolNames.has(definition.name)) {
          throw new LiveToolConfigurationError(
            "duplicate_tool_name",
            `Live tool name ${definition.name} is declared by more than one source`,
            { path: manifestPath },
          );
        }
        const tool = await materializeDefinition({
          definition,
          manifest,
          manifestPath,
          realRootPath,
          rootPath,
          source,
        });
        if (tool.command.kind === "node-script") {
          scriptDigestEntries.push({
            bytes: tool.command.contents,
            path: relative(rootPath, tool.command.sourcePath),
          });
          watchPaths.push(tool.command.sourcePath);
        }
        return tool;
      }),
    );

    input.manifestIds.add(manifest.id);
    for (const tool of manifestTools) input.toolNames.add(tool.name);
    tools.push(...manifestTools);
    watchPaths.push(manifestPath);
    input.digestEntries.push({
      manifestBytes,
      manifestPath: relative(rootPath, manifestPath),
      owner: input.root.owner,
      scripts: scriptDigestEntries.sort((left, right) => compareText(left.path, right.path)),
    });
  }

  return { tools, watchPaths };
}

async function materializeDefinition(input: {
  definition: ParsedLiveToolDefinition;
  manifest: ParsedLiveToolManifest;
  manifestPath: string;
  rootPath: string;
  realRootPath: string;
  source: LiveToolSource;
}): Promise<LiveTool> {
  const command = await resolveCommand(input);
  return Object.freeze({
    command,
    description: input.definition.description,
    identity: `${input.manifest.id}:${input.definition.name}`,
    inputSchema: input.definition.inputSchema,
    name: input.definition.name,
    outputSchema: input.definition.outputSchema,
    source: input.source,
  });
}

async function resolveCommand(input: {
  definition: ParsedLiveToolDefinition;
  manifestPath: string;
  rootPath: string;
  realRootPath: string;
}): Promise<LiveToolCommand> {
  const command = input.definition.command;
  if (command.kind === "argv") {
    return Object.freeze({
      args: Object.freeze([...command.args]),
      file: command.file,
      kind: "argv",
    });
  }

  const scriptPath = resolve(dirname(input.manifestPath), command.script);
  if (isAbsolute(command.script) || !isWithin(input.rootPath, scriptPath)) {
    throw new LiveToolConfigurationError(
      "unsafe_path",
      "Live tool script must be a relative path inside its source root",
      { path: input.manifestPath },
    );
  }
  const realScriptPath = await realpathWithin(scriptPath, input.realRootPath, "script");
  const extension = extname(realScriptPath).toLowerCase();
  if (!NODE_SCRIPT_EXTENSIONS.has(extension)) {
    throw new LiveToolConfigurationError(
      "unsupported_script_extension",
      "Live tool scripts must use .js, .cjs, or .mjs",
      { path: scriptPath },
    );
  }
  const contents = await readBoundedFile(realScriptPath, "script", scriptPath, MAX_SCRIPT_BYTES);
  const digest = createHash("sha256").update(contents).digest("hex");
  return Object.freeze({
    args: Object.freeze([...command.args]),
    contents,
    digest,
    extension: extension as LiveToolNodeScriptCommand["extension"],
    kind: "node-script",
    sourcePath: realScriptPath,
  });
}

async function realpathWithin(
  path: string,
  rootPath: string,
  kind: "manifest" | "script",
): Promise<string> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch (cause) {
    throw new LiveToolConfigurationError("unsafe_path", `Live tool ${kind} cannot be resolved`, {
      cause,
      path,
    });
  }
  if (!isWithin(rootPath, resolvedPath)) {
    throw new LiveToolConfigurationError(
      "unsafe_path",
      `Live tool ${kind} resolves outside its source root`,
      {
        path,
      },
    );
  }
  return resolvedPath;
}

async function readBoundedFile(
  path: string,
  kind: "manifest" | "script",
  displayPath: string,
  maximumBytes = kind === "manifest" ? 256 * 1024 : MAX_SCRIPT_BYTES,
): Promise<Uint8Array> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (cause) {
    throw new LiveToolConfigurationError("unsafe_path", `Live tool ${kind} cannot be read`, {
      cause,
      path: displayPath,
    });
  }
  if (!stat.isFile() || stat.size > maximumBytes) {
    throw new LiveToolConfigurationError(
      kind === "manifest" ? "invalid_manifest" : "invalid_command",
      `Live tool ${kind} must be a regular file no larger than ${maximumBytes} bytes`,
      { path: displayPath },
    );
  }
  try {
    return new Uint8Array(await readFile(path));
  } catch (cause) {
    throw new LiveToolConfigurationError(
      kind === "manifest" ? "invalid_manifest" : "invalid_command",
      `Live tool ${kind} cannot be read`,
      { cause, path: displayPath },
    );
  }
}

async function lstatIfExists(path: string) {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
}

function digestLiveTools(entries: readonly DigestEntry[]): string {
  const hash = createHash("sha256");
  writeDigestPart(hash, "zcode-live-tools-v1");
  for (const entry of entries) {
    writeDigestPart(hash, entry.owner);
    writeDigestPart(hash, entry.manifestPath);
    writeDigestPart(hash, entry.manifestBytes);
    for (const script of entry.scripts) {
      writeDigestPart(hash, script.path);
      writeDigestPart(hash, script.bytes);
    }
  }
  return hash.digest("hex");
}

function writeDigestPart(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update(";");
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function requireWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LiveToolConfigurationError("invalid_root", "workspacePath must be a non-empty path");
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function compareDirectoryEntry(left: { name: string }, right: { name: string }): number {
  return compareText(left.name, right.name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
