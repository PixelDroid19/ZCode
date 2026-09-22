import { copyFile, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SqliteMemoryStore } from "@zcode/adapters/storage";
import type { ModelSelection } from "@zcode/contracts";
import { createZCodeApp, startProcessProviderRegistryRuntime } from "../../src/index.js";
import type { Arm } from "./cases.js";
import { ObservedAdapter, safeError, usage } from "./observer.js";

export type ProviderRuntime = Awaited<ReturnType<typeof startProcessProviderRegistryRuntime>>;

export interface TurnInput {
  root: string;
  profile: string;
  projectKey: string;
  arm: Arm;
  learning: boolean;
  prompt: string;
  registry: ProviderRuntime;
  selection: ModelSelection;
}

export async function runTurn(input: TurnInput) {
  const workspace = join(input.root, "workspaces", input.projectKey);
  const profile = join(input.root, input.profile);
  const userConfigPath = join(profile, "config.json");
  const projectConfigPath = join(workspace, ".zcode", "config.json");
  await mkdir(profile, { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await Promise.all([writeFile(userConfigPath, "{}\n"), writeFile(projectConfigPath, "{}\n")]);
  const env = {
    HOME: profile,
    USERPROFILE: profile,
    PATH: process.env.PATH,
    ZCODE_STORAGE_DIR: profile,
    ZCODE_SESSION_DB_PATH: join(profile, "cli", "db", "session.sqlite"),
  };
  const turnSignal = AbortSignal.timeout(120_000);
  const adapter = new ObservedAdapter(env, 12, 45_000, turnSignal);
  const started = performance.now();
  let foregroundMs: number | undefined;
  let drainWaitMs: number | undefined;
  let response = "";
  let error: ReturnType<typeof safeError> | undefined;
  let app: Awaited<ReturnType<typeof createZCodeApp>> | undefined;
  try {
    app = await createZCodeApp({
      env,
      userConfigPath,
      projectConfigPath,
      officialPluginRoots: [],
      pluginStorageRoot: join(profile, "plugins"),
      modelAdapter: adapter,
      providerRegistry: input.registry.runtime.registryService,
      runtimeConfig: {
        workingDirectory: workspace,
        dynamicWorkflowEnabled: false,
        mcp: { enabled: false },
        memory: {
          enabled: input.arm === "on",
          extractionEnabled: input.learning,
          workspaceIdentity: input.projectKey,
        },
        mode: "yolo",
        modelSelection: input.selection,
        modelStreaming: "off",
        subagents: { enabled: false },
        titleGeneration: { enabled: false },
        toolAllowlist: ["Memory"],
        toolConcurrency: { maxConcurrency: 1 },
      },
      version: "memory-utility-benchmark-v1",
    });
    const admission = await app.sendInput(input.prompt, {
      abortSignal: turnSignal,
      ...(input.learning ? { toolDisallowlist: ["Memory"] } : {}),
    });
    if (admission.kind !== "started_turn") throw new Error("Benchmark turn was not started");
    const result = await admission.completion;
    response = result.response;
    foregroundMs = Math.round(performance.now() - started);
    const runtime = app.runtime;
    if (!runtime.drainMemoryExtractions) throw new Error("Memory drain API is unavailable");
    const drainStarted = performance.now();
    await runtime.drainMemoryExtractions(null);
    drainWaitMs = Math.round(performance.now() - drainStarted);
  } catch (cause) {
    error = safeError(cause);
  } finally {
    try {
      if (app && !app.close) error ??= safeError({ name: "BenchmarkCloseUnavailable" });
      await app?.close?.();
    } catch (cause) {
      error ??= safeError(cause);
    }
  }
  const extraction = adapter.calls.filter((call) => call.operation === "project_memory_extract");
  const foreground = adapter.calls.filter((call) => call.operation === "agent_step");
  const unexpectedOperations = adapter.calls
    .filter((call) => !["agent_step", "project_memory_extract"].includes(call.operation))
    .map((call) => call.operation);
  const mutatingCalls = foreground
    .flatMap((call) => call.toolCalls ?? [])
    .filter((call) => {
      const action = (call.input as { action?: string })?.action;
      return call.name === "Memory" && ["save", "update", "forget"].includes(action ?? "");
    });
  return {
    response,
    error,
    foregroundMs,
    drainWaitMs,
    extractionModelMs: extraction.reduce((sum, call) => sum + call.durationMs, 0),
    unexpectedOperations,
    elapsedMs: Math.round(performance.now() - started),
    foregroundUsage: usage(foreground),
    extractionUsage: usage(extraction),
    totalUsage: usage(adapter.calls),
    calls: adapter.calls,
    attempts: adapter.attempts,
    physicalUsage: usage(adapter.attempts),
    mutatingForegroundCalls: mutatingCalls.length,
  };
}

export async function copyMemory(root: string, source: string, target: string): Promise<void> {
  const directory = join(root, target, "cli", "memories");
  await mkdir(directory, { recursive: true });
  // All apps are closed first, so no WAL writer can race with the snapshot.
  const sourceDigest = await memoryDigest(root, source);
  await copyFile(
    join(root, source, "cli", "memories", "experience.sqlite"),
    join(directory, "experience.sqlite"),
  );
  if (sourceDigest !== (await memoryDigest(root, target)))
    throw new Error("Memory snapshot digest mismatch");
}

export async function snapshot(root: string, profile: string, projectKey: string) {
  const store = await SqliteMemoryStore.open({
    dbPath: join(root, profile, "cli", "memories", "experience.sqlite"),
  });
  try {
    const access = { projectKey, sessionId: "benchmark-observer" };
    const records = await store.search(access, { scope: "all", includeInactive: true, limit: 20 });
    const revisions = await Promise.all(
      records.map((record) => store.history(access, record.id, 100)),
    );
    return { records, revisions, truncated: records.length === 20 };
  } finally {
    await store.close();
  }
}

export async function memoryDigest(root: string, profile: string): Promise<string> {
  const path = join(root, profile, "cli", "memories", "experience.sqlite");
  const wal = await stat(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (wal && wal.size > 0) throw new Error("Memory database still has an uncheckpointed WAL");
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
