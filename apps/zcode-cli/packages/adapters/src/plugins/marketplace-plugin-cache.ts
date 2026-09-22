import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { activateDirectoryAtomically, type AtomicDirectoryActivation } from "./atomic-directory.js";
import { cleanupPluginSourceBestEffort } from "./helpers.js";
import { isZipPluginUrlSource } from "./zip-source.js";

import { getPluginCacheDir, writeJsonFile } from "./marketplace-files.js";
import {
  createManifestFromMarketplaceEntry,
  findPluginManifestPath,
  readPluginManifestFromRoot,
  resolveInstalledPluginVersion,
} from "./marketplace-manifests.js";
import { resolvePluginSourceRoot } from "./marketplace-plugin-source.js";
import {
  type CachedMarketplacePluginResult,
  type InstalledPluginRecord,
  type InstalledPluginsState,
  type PluginMarketplaceEntry,
} from "./marketplace-types.js";
import { INSTALLED_PLUGINS_FILE, throwIfPluginOperationAborted } from "./marketplace-values.js";

export async function cacheMarketplacePlugin(input: {
  entry: PluginMarketplaceEntry;
  marketplace: string;
  signal?: AbortSignal;
  scope: "user" | "workspace";
  state: InstalledPluginsState;
  storageRoot: string;
}): Promise<CachedMarketplacePluginResult> {
  throwIfPluginOperationAborted(input.signal);
  const sourceRoot = await resolvePluginSourceRoot({
    entry: input.entry,
    marketplace: input.marketplace,
    signal: input.signal,
    storageRoot: input.storageRoot,
  });
  let version: string;
  let target: string;
  let activation: AtomicDirectoryActivation | undefined;
  try {
    // 多顶层 ZIP 未显式 path 时 resolver 会回退到 extract root，
    // 原安装流程未在删除旧 cache 前校验 manifest，仍会写 installed record 并默认启用，最终 runtime
    // 无法 discover。ZIP 源必须先确认根目录可形成合法插件；strict:false 继续复用 synthetic manifest。
    if (isZipPluginUrlSource(input.entry.source)) {
      assertZipPluginInstallRoot(sourceRoot.path, input.entry, input.marketplace);
    }
    // 缓存目录的版本段与安装记录的 version 不能取自 marketplace 条目的
    // version 字段：git/url 源插件的条目通常不带 version，取了也只会兜底成
    // "0.0.0"，导致 Root path 落到 .../<name>/0.0.0；而 UI 展示读的是插件自带 plugin.json 里的
    // 真实版本，两者割裂。因此在 clone/拷贝后的源根目录上按加载器同样的规则解析真实
    // 版本（详见 resolveInstalledPluginVersion），让缓存路径段与安装记录、UI 展示版本一致。
    version = resolveInstalledPluginVersion(sourceRoot.path, input.entry);
    target = getPluginCacheDir(input.storageRoot, input.marketplace, input.entry.name, version);
    // 内置 filesystem/sea 插件的 cachePath 即缓存目录本身，源根目录可能与 target 相同；
    // 此时无需（也不能）先 rm 再自我拷贝，否则会把源删掉。
    if (resolve(sourceRoot.path) !== resolve(target)) {
      throwIfPluginOperationAborted(input.signal);
      activation = await activateDirectoryAtomically({
        authorityPath: join(input.storageRoot, INSTALLED_PLUGINS_FILE),
        prepare: async (stagedPath) => {
          await ensureMarketplaceEntryManifest({ entry: input.entry, target: stagedPath });
        },
        signal: input.signal,
        sourcePath: sourceRoot.path,
        targetPath: target,
      });
    }
    if (resolve(sourceRoot.path) === resolve(target)) {
      await ensureMarketplaceEntryManifest({ entry: input.entry, target });
    }
  } finally {
    // cache 已复制成功后，临时目录 cleanup 失败不能阻断 installed record 落盘。
    await cleanupPluginSourceBestEffort(sourceRoot.cleanup);
  }

  const now = new Date().toISOString();
  const record: InstalledPluginRecord = {
    id: `${input.entry.name}@${input.marketplace}`,
    name: input.entry.name,
    marketplace: input.marketplace,
    version,
    installPath: target,
    installedAt: now,
    updatedAt: now,
    scope: input.scope,
    ...(input.entry.dependencies ? { dependencies: input.entry.dependencies } : {}),
    ...(input.entry.source !== undefined ? { source: input.entry.source } : {}),
    ...(activation ? { cacheTransactionId: activation.transactionId } : {}),
  };
  const existingIndex = input.state.plugins.findIndex((plugin) => plugin.id === record.id);
  if (existingIndex >= 0) {
    const { cacheTransactionId: _previousCacheTransactionId, ...previousRecord } =
      input.state.plugins[existingIndex] ?? record;
    input.state.plugins[existingIndex] = {
      ...previousRecord,
      ...record,
      installedAt: previousRecord.installedAt ?? record.installedAt,
    };
  } else {
    input.state.plugins.push(record);
  }
  return { ...(activation ? { activation } : {}), record };
}

async function ensureMarketplaceEntryManifest(input: {
  entry: PluginMarketplaceEntry;
  target: string;
}): Promise<void> {
  if (findPluginManifestPath(input.target)) return;
  if (input.entry.strict !== false) return;
  const manifestDir = join(input.target, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeJsonFile(
    join(manifestDir, "plugin.json"),
    createManifestFromMarketplaceEntry(input.entry),
  );
}

function assertZipPluginInstallRoot(
  rootPath: string,
  entry: PluginMarketplaceEntry,
  marketplace: string,
): void {
  const loaded = readPluginManifestFromRoot(rootPath, entry);
  const pluginId = `${entry.name}@${marketplace}`;
  if (!loaded) {
    throw new Error(`Plugin manifest not found: ${pluginId}`);
  }
  if (loaded.manifest.name !== entry.name) {
    throw new Error(
      `Plugin manifest name '${loaded.manifest.name}' does not match marketplace entry '${entry.name}'`,
    );
  }
}
