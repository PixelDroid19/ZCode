import { LiveToolConfigurationError } from "./errors.js";
import { parseLiveToolJsonSchema } from "./json-schema.js";
import { TextDecoder } from "node:util";
import type { LiveToolJsonSchema } from "./types.js";

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TEXT_LENGTH = 4_096;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/u;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ParsedLiveToolArgvCommand {
  kind: "argv";
  file: string;
  args: string[];
}

export interface ParsedLiveToolScriptCommand {
  kind: "node-script";
  script: string;
  args: string[];
}

export type ParsedLiveToolCommand = ParsedLiveToolArgvCommand | ParsedLiveToolScriptCommand;

export interface ParsedLiveToolDefinition {
  name: string;
  description: string;
  inputSchema: LiveToolJsonSchema;
  outputSchema: LiveToolJsonSchema;
  command: ParsedLiveToolCommand;
}

export interface ParsedLiveToolManifest {
  id: string;
  tools: ParsedLiveToolDefinition[];
}

export function parseLiveToolManifest(
  bytes: Uint8Array,
  manifestPath: string,
): ParsedLiveToolManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw invalidManifest(`Live tool manifest exceeds ${MAX_MANIFEST_BYTES} bytes`, manifestPath);
  }

  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw invalidManifest("Live tool manifest is not valid UTF-8 JSON", manifestPath, cause);
  }

  const manifest = requireRecord(value, "manifest", manifestPath);
  assertExactKeys(manifest, ["id", "tools", "version"], "manifest", manifestPath);
  if (manifest.version !== 1) {
    throw invalidManifest("Live tool manifest version must be 1", manifestPath);
  }

  const id = requireIdentifier(manifest.id, "manifest.id", manifestPath);
  const rawTools = requireArray(manifest.tools, "manifest.tools", manifestPath);
  if (rawTools.length === 0) {
    throw invalidManifest("Live tool manifest.tools must contain at least one tool", manifestPath);
  }

  const names = new Set<string>();
  const tools = rawTools.map((value, index) => {
    const path = `manifest.tools[${index}]`;
    const tool = requireRecord(value, path, manifestPath);
    assertExactKeys(
      tool,
      ["command", "description", "inputSchema", "name", "outputSchema"],
      path,
      manifestPath,
    );
    const name = requireIdentifier(tool.name, `${path}.name`, manifestPath);
    if (names.has(name)) {
      throw invalidManifest(`Live tool manifest repeats tool name ${name}`, manifestPath);
    }
    names.add(name);
    return {
      command: parseCommand(tool.command, `${path}.command`, manifestPath),
      description: requireText(tool.description, `${path}.description`, manifestPath),
      inputSchema: parseLiveToolJsonSchema(tool.inputSchema, `${path}.inputSchema`, manifestPath, {
        requireObjectRoot: true,
      }),
      name,
      outputSchema: parseLiveToolJsonSchema(
        tool.outputSchema,
        `${path}.outputSchema`,
        manifestPath,
        {
          requireObjectRoot: false,
        },
      ),
    } satisfies ParsedLiveToolDefinition;
  });

  return { id, tools };
}

function parseCommand(value: unknown, label: string, manifestPath: string): ParsedLiveToolCommand {
  const command = requireRecord(value, label, manifestPath, "invalid_command");
  const hasArgv = Object.hasOwn(command, "argv");
  const hasScript = Object.hasOwn(command, "script");
  if (hasArgv === hasScript) {
    throw invalidCommand(`${label} must have exactly one of argv or script`, manifestPath);
  }

  if (hasArgv) {
    assertExactKeys(command, ["argv"], label, manifestPath, "invalid_command");
    const argv = requireStringArray(command.argv, `${label}.argv`, manifestPath, "invalid_command");
    if (argv.length === 0) {
      throw invalidCommand(`${label}.argv must have an executable`, manifestPath);
    }
    const [file, ...args] = argv;
    if (!file || !isBareExecutableName(file)) {
      throw invalidCommand(`${label}.argv[0] must be a bare executable name`, manifestPath);
    }
    return { args, file, kind: "argv" };
  }

  assertExactKeys(command, ["args", "script"], label, manifestPath, "invalid_command");
  const script = requireText(command.script, `${label}.script`, manifestPath, "invalid_command");
  const args =
    command.args === undefined
      ? []
      : requireStringArray(command.args, `${label}.args`, manifestPath, "invalid_command");
  return { args, kind: "node-script", script };
}

function requireRecord(
  value: unknown,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): Record<string, unknown> {
  if (!isRecord(value)) throw createError(code, `${label} must be an object`, manifestPath);
  for (const key of Object.keys(value)) assertSafeObjectKey(key, label, manifestPath, code);
  return value;
}

function requireArray(
  value: unknown,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): unknown[] {
  if (!Array.isArray(value)) throw createError(code, `${label} must be an array`, manifestPath);
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): string[] {
  const values = requireArray(value, label, manifestPath, code);
  return values.map((entry, index) =>
    requireCommandArgument(entry, `${label}[${index}]`, manifestPath, code),
  );
}

function requireCommandArgument(
  value: unknown,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema",
): string {
  if (typeof value !== "string" || value.includes("\u0000") || value.length > MAX_TEXT_LENGTH) {
    throw createError(
      code,
      `${label} must be text up to ${MAX_TEXT_LENGTH} characters`,
      manifestPath,
    );
  }
  return value;
}

function requireIdentifier(value: unknown, label: string, manifestPath: string): string {
  const text = requireText(value, label, manifestPath);
  if (!IDENTIFIER_PATTERN.test(text)) {
    throw invalidManifest(
      `${label} must be an ASCII identifier starting with a letter`,
      manifestPath,
    );
  }
  return text;
}

function requireText(
  value: unknown,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw createError(
      code,
      `${label} must be non-empty text up to ${MAX_TEXT_LENGTH} characters`,
      manifestPath,
    );
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[] | Set<string>,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): void {
  const allowedKeys: Set<string> = allowed instanceof Set ? allowed : new Set<string>(allowed);
  for (const key of Object.keys(value)) {
    assertSafeObjectKey(key, label, manifestPath, code);
    if (!allowedKeys.has(key))
      throw createError(code, `${label} has unsupported field ${key}`, manifestPath);
  }
}

function assertSafeObjectKey(
  key: string,
  label: string,
  manifestPath: string,
  code: "invalid_command" | "invalid_manifest" | "invalid_schema" = "invalid_manifest",
): void {
  if (FORBIDDEN_OBJECT_KEYS.has(key)) {
    throw createError(code, `${label} has unsafe field ${key}`, manifestPath);
  }
}

function isBareExecutableName(value: string): boolean {
  return (
    !value.includes("\u0000") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createError(
  code: "invalid_command" | "invalid_manifest" | "invalid_schema",
  message: string,
  manifestPath: string,
): LiveToolConfigurationError {
  return new LiveToolConfigurationError(code, message, { path: manifestPath });
}

function invalidManifest(
  message: string,
  manifestPath: string,
  cause?: unknown,
): LiveToolConfigurationError {
  return new LiveToolConfigurationError("invalid_manifest", message, { cause, path: manifestPath });
}

function invalidCommand(message: string, manifestPath: string): LiveToolConfigurationError {
  return new LiveToolConfigurationError("invalid_command", message, { path: manifestPath });
}
