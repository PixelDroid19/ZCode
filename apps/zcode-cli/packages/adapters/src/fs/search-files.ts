import { stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  createFileSystemError,
  type FileSystemSearchFilesRequest,
  type FileSystemSearchFilesResult,
} from "@zcode/contracts";
import {
  createGlobMatcher,
  DEFAULT_GLOB_MAX_RESULTS,
  toPosixRelative,
  walkFiles,
} from "./file-search-support.js";
import {
  resolveAbsoluteRequestPath,
  throwIfAborted,
  toFileSystemError,
} from "./file-system-utils.js";

export async function searchFilesFromNode(
  request: FileSystemSearchFilesRequest,
  signal?: AbortSignal,
): Promise<FileSystemSearchFilesResult> {
  const path = resolveAbsoluteRequestPath(request.path);
  const pattern = request.pattern.trim();
  const startedAt = Date.now();

  if (pattern.length === 0) {
    throw createFileSystemError({
      code: "invalid_pattern",
      path,
      message: "Glob pattern must not be empty",
    });
  }

  try {
    throwIfAborted(signal);
    const rootInfo = await stat(path);
    if (!rootInfo.isDirectory()) {
      throw createFileSystemError({
        code: "not_file",
        path,
        message: `Glob search path must be a directory: ${path}`,
      });
    }

    const matcher = createGlobMatcher(pattern);
    const matches: Array<{ path: string; mtimeMs: number }> = [];

    await walkFiles(path, signal, async (filePath, info) => {
      const relativePath = toPosixRelative(path, filePath);
      if (matcher(relativePath, basename(filePath))) {
        matches.push({ path: filePath, mtimeMs: Number(info.mtimeMs) });
      }
    });

    matches.sort((left, right) => {
      const timeComparison = right.mtimeMs - left.mtimeMs;
      return timeComparison === 0 ? left.path.localeCompare(right.path) : timeComparison;
    });

    const offset = request.offset ?? 0;
    const maxResults = request.maxResults ?? DEFAULT_GLOB_MAX_RESULTS;
    const files = matches.slice(offset, offset + maxResults).map((match) => match.path);

    return {
      path,
      pattern,
      durationMs: Math.max(0, Date.now() - startedAt),
      files,
      numFiles: files.length,
      truncated: matches.length > offset + maxResults,
    };
  } catch (error) {
    throw toFileSystemError(error, path);
  }
}
