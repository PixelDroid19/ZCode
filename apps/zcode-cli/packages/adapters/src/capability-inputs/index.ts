import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { SkillContent, SkillLoadOutcome, SkillPort } from "@zcode/contracts";

const SOURCE_EXTENSIONS = new Set([".json", ".md", ".js", ".mjs", ".cjs", ".ts", ".py", ".sh"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "data", ".cache"]);
const MAX_SOURCE_FILES = 12_000;
const MAX_SOURCE_ENTRIES = 24_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_EXPLICIT_CAPABILITY_FILE_BYTES = 256 * 1024 * 1024;
const MAX_EXPLICIT_CAPABILITY_TOTAL_BYTES = 512 * 1024 * 1024;

export interface FingerprintCapabilityInputsOptions {
  /** Files covered by a separate fingerprint should not be read again by the recursive scan. */
  skipContentsForPaths?: readonly string[];
}

/** Async, content-based reconciliation; filesystem events are only wake-up hints. */
export async function fingerprintCapabilityInputs(
  paths: readonly string[],
  options: FingerprintCapabilityInputsOptions = {},
): Promise<string> {
  const hash = createHash("sha256");
  const visited = new Set<string>();
  const skipContentsForPaths = new Set(
    (options.skipContentsForPaths ?? []).map((path) => resolve(path)),
  );
  let files = 0;
  let bytes = 0;
  async function visit(path: string, originalPath = resolve(path)): Promise<void> {
    const fullPath = resolve(path);
    if (visited.has(fullPath)) return;
    visited.add(fullPath);
    if (visited.size > MAX_SOURCE_ENTRIES) {
      throw new Error("Capability sources exceed the supported scan budget");
    }
    let stat;
    try {
      stat = await lstat(fullPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update(`missing:${fullPath}\0`);
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      // 别名只参与一次；禁止 symlink 环造成不受限扫描。
      await visit(await realpath(fullPath), originalPath);
    } else if (stat.isDirectory()) {
      hash.update(`directory:${fullPath}\0`);
      const children = await readdir(fullPath, { withFileTypes: true });
      for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!IGNORED_DIRECTORIES.has(child.name)) await visit(join(fullPath, child.name));
      }
    } else if (
      stat.isFile() &&
      SOURCE_EXTENSIONS.has(extname(fullPath).toLowerCase()) &&
      !skipContentsForPaths.has(originalPath) &&
      !skipContentsForPaths.has(fullPath)
    ) {
      if (++files > MAX_SOURCE_FILES || (bytes += stat.size) > MAX_SOURCE_BYTES) {
        throw new Error("Capability sources exceed the supported scan budget");
      }
      const content = await readFile(fullPath);
      hash.update(fullPath).update("\0").update(content).update("\0");
    }
  }
  for (const path of [...new Set(paths)].sort()) await visit(path);
  return hash.digest("hex");
}

/** Fingerprint explicitly configured executable files without buffering their contents. */
export async function fingerprintExplicitCapabilityFiles(
  paths: readonly string[],
): Promise<string> {
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path).update("\0");
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("missing\0");
        continue;
      }
      throw error;
    }
    if (!fileStat.isFile()) {
      hash.update(`not-file:${fileStat.mode}\0`);
      continue;
    }
    if (
      fileStat.size > MAX_EXPLICIT_CAPABILITY_FILE_BYTES ||
      totalBytes + fileStat.size > MAX_EXPLICIT_CAPABILITY_TOTAL_BYTES
    ) {
      throw new Error("Explicit capability files exceed the supported fingerprint budget");
    }
    // 显式命令可能是无扩展名脚本或大型可执行文件；流式读取避免整文件驻留内存。
    // 执行位或 symlink 目标变化也会改变 spawn/相对资源解析；仅比较字节会漏掉这些有效更新。
    hash.update(`file:${await realpath(path)}:${fileStat.mode & 0o111}:${fileStat.size}\0`);
    let streamedBytes = 0;
    for await (const chunk of createReadStream(path)) {
      streamedBytes += chunk.length;
      if (
        streamedBytes > MAX_EXPLICIT_CAPABILITY_FILE_BYTES ||
        totalBytes + streamedBytes > MAX_EXPLICIT_CAPABILITY_TOTAL_BYTES
      ) {
        throw new Error("Explicit capability file changed beyond the supported fingerprint budget");
      }
      hash.update(chunk);
    }
    if (streamedBytes !== fileStat.size) {
      throw new Error("Explicit capability file changed while being fingerprinted");
    }
    totalBytes += streamedBytes;
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Pin skill bodies together with their catalog so edits cannot change an active step. */
export async function captureSkillPort(outcome: SkillLoadOutcome): Promise<SkillPort> {
  const contents: SkillContent[] = [];
  for (const metadata of outcome.skills) {
    // Read directly through the adapter after discovery; avoid O(n²) rediscovery in loadSkill.
    const rawContent = await readFile(metadata.path, "utf8");
    const sizeBytes = Buffer.byteLength(rawContent);
    if (sizeBytes > 100_000) throw new Error("Skill content exceeds the live snapshot budget");
    const content = rawContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    contents.push({
      metadata: structuredClone(metadata),
      content,
      baseDirectory: metadata.directory,
      bytesRead: sizeBytes,
      sizeBytes,
      truncated: false,
    });
  }
  return {
    async discoverSkills(_request, options) {
      options?.signal?.throwIfAborted();
      return structuredClone(outcome);
    },
    async loadSkill(request, options) {
      options?.signal?.throwIfAborted();
      const selected = contents.find(({ metadata }) =>
        [metadata.name, metadata.qualifiedName, metadata.path].includes(request.name),
      );
      if (!selected) throw new Error("Skill is unavailable in the adopted capability revision");
      const result = structuredClone(selected);
      if (request.maxBytes !== undefined && result.bytesRead > request.maxBytes) {
        const bytes = Buffer.from(result.content).subarray(0, Math.max(0, request.maxBytes));
        result.content = bytes.toString("utf8");
        result.bytesRead = bytes.length;
        result.truncated = true;
      }
      return result;
    },
  };
}
