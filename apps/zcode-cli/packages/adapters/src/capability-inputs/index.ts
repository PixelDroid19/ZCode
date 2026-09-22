import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { SkillContent, SkillLoadOutcome, SkillPort } from "@zcode/contracts";

const SOURCE_EXTENSIONS = new Set([".json", ".md", ".js", ".mjs", ".cjs", ".ts", ".py", ".sh"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "data", ".cache"]);
const MAX_SOURCE_FILES = 12_000;
const MAX_SOURCE_ENTRIES = 24_000;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** Async, content-based reconciliation; filesystem events are only wake-up hints. */
export async function fingerprintCapabilityInputs(paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  const visited = new Set<string>();
  let files = 0;
  let bytes = 0;
  async function visit(path: string): Promise<void> {
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
      await visit(await realpath(fullPath));
    } else if (stat.isDirectory()) {
      hash.update(`directory:${fullPath}\0`);
      const children = await readdir(fullPath, { withFileTypes: true });
      for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!IGNORED_DIRECTORIES.has(child.name)) await visit(join(fullPath, child.name));
      }
    } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(fullPath).toLowerCase())) {
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
