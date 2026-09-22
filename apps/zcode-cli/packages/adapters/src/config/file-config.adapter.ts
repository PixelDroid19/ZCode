// File Config Adapter - Load and patch JSON configuration files

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeConfigPatch, UiLocale } from "@zcode/contracts";
import { z } from "zod";
import {
  CANONICAL_CUA_PLUGIN_ID,
  canonicalizePluginId,
  LEGACY_CUA_PLUGIN_ID,
  parseConfigFileToRuntimePatchWithDiagnostics,
  pluginIdAliases,
  type ConfigDiagnostic,
} from "./schema.js";
import {
  isConfigRecord,
  patchPluginEnabledConfig,
  patchPluginOptionsConfig,
  patchPluginRemovedConfig,
  patchUiLocaleConfig,
} from "./file-config-patches.js";
import { atomicWriteJsonConfig, readJsonConfigFileOrEmpty } from "./file-config-io.js";

interface FileConfigOptions {
  baseDir?: string;
  configFileName?: string;
}

export interface LoadedConfig {
  config: RuntimeConfigPatch;
  diagnostics: ConfigDiagnostic[];
  path: string;
  loaded: boolean;
}

export interface UiLocalePatchResult {
  locale: UiLocale;
  path: string;
}

export interface PluginEnabledPatchResult {
  enabled: boolean;
  path: string;
  pluginId: string;
}

export interface PluginOptionsPatchResult {
  clearedOptionKeys: string[];
  options: Record<string, string | number | boolean>;
  path: string;
  pluginId: string;
}

export interface PluginRemovePatchResult {
  path: string;
  pluginId: string;
  removedEnabled: boolean;
  removedOptions: boolean;
}

const DEFAULT_CONFIG_FILE = "config.json";
const DEFAULT_BASE_DIR = "~/.zcode/cli";

/**
 * Resolve path with ~ expansion
 */
export function resolvePath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return resolve(path);
}

/**
 * Load configuration from a JSON file
 */
export function loadFileConfig(filePath?: string, options: FileConfigOptions = {}): LoadedConfig {
  const resolvedPath = filePath
    ? resolvePath(filePath)
    : join(
        resolvePath(options.baseDir ?? DEFAULT_BASE_DIR),
        options.configFileName ?? DEFAULT_CONFIG_FILE,
      );

  if (!existsSync(resolvedPath)) {
    return {
      config: {},
      diagnostics: [],
      path: resolvedPath,
      loaded: false,
    };
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(content);
    const migrated = migratePluginConfigInFile(parsed);
    if (migrated) {
      // 仅装载态归一化会让旧 key 永久留在磁盘，后续版本无法安全删除迁移逻辑。
      persistPluginConfigMigration(resolvedPath, migrated);
    }
    const result = parseConfigFileToRuntimePatchWithDiagnostics(parsed);

    return {
      config: result.config,
      diagnostics: attachDiagnosticFilePath(result.diagnostics, resolvedPath),
      path: resolvedPath,
      loaded: true,
    };
  } catch (error) {
    return {
      config: {},
      diagnostics: [createConfigFileInvalidDiagnostic(error, resolvedPath)],
      path: resolvedPath,
      loaded: false,
    };
  }
}

function migratePluginConfigInFile(value: unknown): Record<string, unknown> | undefined {
  if (!isConfigRecord(value) || !isConfigRecord(value.plugins)) return undefined;
  const plugins = value.plugins;
  const nextPlugins = { ...plugins };
  let changed = false;

  if (isConfigRecord(plugins.enabledPlugins)) {
    const enabledPlugins = { ...plugins.enabledPlugins };
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (enabledPlugins[canonicalId] === undefined) enabledPlugins[canonicalId] = enabled;
        delete enabledPlugins[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.enabledPlugins = enabledPlugins;
  }

  if (Array.isArray(plugins.suppressedBuiltins)) {
    const suppressedBuiltins = plugins.suppressedBuiltins.map((id) =>
      id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id,
    );
    if (JSON.stringify(suppressedBuiltins) !== JSON.stringify(plugins.suppressedBuiltins)) {
      nextPlugins.suppressedBuiltins = suppressedBuiltins;
      changed = true;
    }
  }

  if (isConfigRecord(plugins.options)) {
    const options = { ...plugins.options };
    for (const [id, pluginOptions] of Object.entries(plugins.options)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (options[canonicalId] === undefined) options[canonicalId] = pluginOptions;
        delete options[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.options = options;
  }

  return changed ? { ...value, plugins: nextPlugins } : undefined;
}

function persistPluginConfigMigration(filePath: string, value: Record<string, unknown>): void {
  const tempPath = `${filePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch {
    // 迁移写回是 best-effort 副作用，失败不能改变合法配置的装载语义。
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不影响当前配置装载。
    }
  }
}

function createConfigFileInvalidDiagnostic(error: unknown, filePath: string): ConfigDiagnostic {
  return {
    code: "config_file_invalid",
    filePath,
    message:
      error instanceof z.ZodError
        ? formatZodError(error)
        : error instanceof Error
          ? error.message
          : "Unable to parse config file.",
    severity: "error",
  };
}

function attachDiagnosticFilePath(
  diagnostics: ConfigDiagnostic[],
  filePath: string,
): ConfigDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    filePath: diagnostic.filePath ?? filePath,
  }));
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<config>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Patch only the UI locale selection in a JSON config file.
 */
export async function updateUiLocaleInFileConfig(
  filePath: string,
  locale: UiLocale,
): Promise<UiLocalePatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchUiLocaleConfig(parsed, locale);

  await atomicWriteJsonConfig(resolvedPath, next);
  return {
    locale,
    path: resolvedPath,
  };
}

/**
 * Patch the user plugin enabled map without touching plugin installation state.
 */
export async function updatePluginEnabledInFileConfig(
  filePath: string,
  pluginId: string,
  enabled: boolean,
): Promise<PluginEnabledPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchPluginEnabledConfig(parsed, pluginId, enabled);

  await atomicWriteJsonConfig(resolvedPath, next);
  return {
    enabled,
    path: resolvedPath,
    pluginId,
  };
}

/**
 * Mark freshly installed plugins as enabled by default, in a single atomic write.
 *
 * 设计：安装即默认启用（仅对本次安装的插件 + 其依赖闭包生效）。这里只对**用户配置里尚未显式声明**
 * 的 id 写入 `true`——若用户先前显式停用过（例如停用后重装），尊重其选择不覆盖；已是 true 的也跳过。
 * 一次性读改写，避免逐个 id 反复读写配置文件。返回真正被新置为启用的 id 列表，便于上层据此决定是否回写。
 */
export async function enablePluginsByDefaultInFileConfig(
  filePath: string,
  pluginIds: readonly string[],
): Promise<{ enabledIds: string[]; path: string }> {
  const resolvedPath = resolvePath(filePath);
  if (pluginIds.length === 0) {
    return { enabledIds: [], path: resolvedPath };
  }
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isConfigRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isConfigRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const enabledIds = pluginIds.filter(
    (id) => !Object.prototype.hasOwnProperty.call(enabledPlugins, id),
  );
  if (enabledIds.length === 0) {
    return { enabledIds: [], path: resolvedPath };
  }
  const next = {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: {
        ...enabledPlugins,
        ...Object.fromEntries(enabledIds.map((id) => [id, true])),
      },
    },
  };
  await atomicWriteJsonConfig(resolvedPath, next);
  return { enabledIds, path: resolvedPath };
}

/**
 * Patch plugin user options without touching plugin installation state.
 */
export async function updatePluginOptionsInFileConfig(
  filePath: string,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[] = [],
): Promise<PluginOptionsPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const next = patchPluginOptionsConfig(parsed, pluginId, options, clearOptionKeys);

  await atomicWriteJsonConfig(resolvedPath, next);
  return {
    clearedOptionKeys: clearOptionKeys,
    options,
    path: resolvedPath,
    pluginId,
  };
}

/**
 * Remove a plugin's user config footprint when it is uninstalled.
 *
 * Uninstall is a thorough teardown, so it
 * must drop both the `plugins.enabledPlugins[id]` flag and any saved
 * `plugins.options[id]`. updatePluginEnabledInFileConfig/...Options can only set
 * values; deleting the keys needs its own patch so a reinstall starts clean.
 */
export async function removePluginFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<PluginRemovePatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const { next, removedEnabled, removedOptions } = patchPluginRemovedConfig(parsed, pluginId);

  if (removedEnabled || removedOptions) {
    await atomicWriteJsonConfig(resolvedPath, next);
  }
  return {
    path: resolvedPath,
    pluginId,
    removedEnabled,
    removedOptions,
  };
}

/**
 * 只删除 Plugin 的启用覆盖并保留 options。
 *
 * Workspace“恢复继承”是配置视图操作，只应删除 Workspace 的启用覆盖，不能误删
 * 单独保存的 Workspace options 或 secret。
 */
export async function removePluginEnabledFromFileConfig(
  filePath: string,
  pluginId: string,
): Promise<{ path: string; pluginId: string; removedEnabled: boolean }> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isConfigRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isConfigRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) =>
    Object.prototype.hasOwnProperty.call(enabledPlugins, id),
  );
  if (!removedEnabled) {
    return { path: resolvedPath, pluginId, removedEnabled: false };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  await atomicWriteJsonConfig(resolvedPath, {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: nextEnabled,
    },
  });
  return { path: resolvedPath, pluginId, removedEnabled: true };
}

export interface SuppressedBuiltinPatchResult {
  path: string;
  pluginId: string;
  suppressed: boolean;
}

/**
 * Persist that a built-in (official) plugin is uninstalled, so seeding skips it
 * across restarts and app upgrades. Idempotent. Stored in user config beside
 * enabledPlugins so it survives bundle re-seeds.
 */
export async function addSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isConfigRecord(parsed.plugins) ? parsed.plugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const current = Array.isArray(plugins.suppressedBuiltins)
    ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const retained = current.filter((id) => !aliases.includes(id));
  if (retained.length === current.length && current.includes(canonicalPluginId)) {
    return { path: resolvedPath, pluginId, suppressed: true };
  }
  const next = {
    ...parsed,
    plugins: { ...plugins, suppressedBuiltins: [...retained, canonicalPluginId] },
  };
  await atomicWriteJsonConfig(resolvedPath, next);
  return { path: resolvedPath, pluginId, suppressed: true };
}

/**
 * Reverse of addSuppressedBuiltinInFileConfig: restore a built-in by dropping its
 * suppression marker. The seeder re-materializes it on the next resolve.
 */
export async function removeSuppressedBuiltinInFileConfig(
  filePath: string,
  pluginId: string,
): Promise<SuppressedBuiltinPatchResult> {
  const resolvedPath = resolvePath(filePath);
  const parsed = await readJsonConfigFileOrEmpty(resolvedPath);
  const plugins = isConfigRecord(parsed.plugins) ? parsed.plugins : {};
  const aliases = pluginIdAliases(pluginId);
  const current = Array.isArray(plugins.suppressedBuiltins)
    ? (plugins.suppressedBuiltins as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const nextSuppressedBuiltins = current.filter((id) => !aliases.includes(id));
  if (nextSuppressedBuiltins.length === current.length) {
    return { path: resolvedPath, pluginId, suppressed: false };
  }
  const next = {
    ...parsed,
    plugins: { ...plugins, suppressedBuiltins: nextSuppressedBuiltins },
  };
  await atomicWriteJsonConfig(resolvedPath, next);
  return { path: resolvedPath, pluginId, suppressed: false };
}

/**
 * Get default config file path
 */
export function getDefaultConfigPath(): string {
  return join(resolvePath(DEFAULT_BASE_DIR), DEFAULT_CONFIG_FILE);
}

/**
 * Check if config file exists at default location
 */
export function hasDefaultConfigFile(): boolean {
  return existsSync(getDefaultConfigPath());
}
