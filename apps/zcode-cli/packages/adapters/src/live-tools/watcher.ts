import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const DEBOUNCE_MS = 75;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "data", "node_modules"]);
const MAX_FALLBACK_DIRECTORIES = 512;

export interface LiveCapabilityWatcher {
  update(paths: readonly string[]): void;
  close(): void;
}

/**
 * A best-effort wake-up source only. Callers must rescan authoritative input after every
 * notification because fs.watch can coalesce, lose, or reorder filesystem events.
 */
export function createLiveCapabilityWatcher(
  paths: readonly string[],
  onChange: () => void,
): LiveCapabilityWatcher {
  let closed = false;
  let generation = 0;
  let notificationTimer: ReturnType<typeof setTimeout> | undefined;
  let watchers: FSWatcher[] = [];
  let watchedPaths = new Set<string>();

  const notify = (): void => {
    if (closed || notificationTimer !== undefined) return;
    notificationTimer = setTimeout(() => {
      notificationTimer = undefined;
      if (closed) return;
      try {
        onChange();
      } catch {
        // A watcher is advisory. Consumer errors must not leave a live FSWatcher throwing.
      }
    }, DEBOUNCE_MS);
  };

  const attach = (path: string): void => {
    if (closed || watchedPaths.has(path)) return;
    try {
      const watcher = watch(path, { persistent: false }, notify);
      watcher.on("error", notify);
      watchers.push(watcher);
      watchedPaths.add(path);
    } catch {
      // The caller will rescan after another watched parent changes.
    }
  };

  const attachNearestExistingParent = (path: string): void => {
    let candidate = resolve(path);
    while (true) {
      const before = watchers.length;
      attach(candidate);
      if (watchers.length > before) return;
      const parent = dirname(candidate);
      if (parent === candidate) return;
      candidate = parent;
    }
  };

  const install = async (
    nextPaths: readonly string[],
    requestedGeneration: number,
  ): Promise<void> => {
    const targets = await collectWatchTargets(nextPaths);
    for (const target of targets) {
      if (closed || generation !== requestedGeneration) break;
      attach(target);
    }
  };

  const update = (nextPaths: readonly string[]): void => {
    if (closed) return;
    generation += 1;
    watchers.forEach((watcher) => watcher.close());
    watchers = [];
    watchedPaths = new Set<string>();
    nextPaths.forEach(attachNearestExistingParent);
    void install(nextPaths, generation);
  };

  update(paths);
  return Object.freeze({
    close: (): void => {
      if (closed) return;
      closed = true;
      generation += 1;
      if (notificationTimer !== undefined) clearTimeout(notificationTimer);
      notificationTimer = undefined;
      watchers.forEach((watcher) => watcher.close());
      watchers = [];
      watchedPaths = new Set<string>();
    },
    update,
  });
}

async function collectWatchTargets(paths: readonly string[]): Promise<string[]> {
  const targets = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || path.trim().length === 0) continue;
    const requestedPath = resolve(path);
    let stat;
    try {
      stat = await lstat(requestedPath);
    } catch {
      const parent = await nearestExistingDirectory(dirname(requestedPath));
      if (parent) targets.add(parent);
      continue;
    }
    if (stat.isDirectory()) {
      for (const directory of await collectFallbackDirectories(requestedPath))
        targets.add(directory);
      continue;
    }
    // A manifest or script gets its own watcher. Do not recursively walk its parent.
    targets.add(requestedPath);
  }
  return [...targets].sort(compareText);
}

async function nearestExistingDirectory(path: string): Promise<string | undefined> {
  let candidate = path;
  while (true) {
    try {
      const stat = await lstat(candidate);
      if (stat.isDirectory()) return candidate;
      return dirname(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

async function collectFallbackDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];
  const pending = [root];
  while (pending.length > 0 && directories.length < MAX_FALLBACK_DIRECTORIES) {
    const directory = pending.shift();
    if (!directory) continue;
    directories.push(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        IGNORED_DIRECTORY_NAMES.has(entry.name)
      ) {
        continue;
      }
      pending.push(resolve(directory, entry.name));
    }
  }
  return directories;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
