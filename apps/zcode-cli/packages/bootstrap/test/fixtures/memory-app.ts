import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model, ModelRequest, ModelTextResult } from "@zcode/contracts";
import { createZCodeApp } from "../../src/app/create-app.js";

const PROVIDER = "memory-integration";
const MODEL = "scripted";
const properties = {
  contextWindow: 128_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: false,
    supportsPdf: false,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: false,
  supportsMidConversationSystem: false,
  supportsNativeWebSearch: false,
};
const optionSpecs = { maxOutputTokens: { max: 2_048 }, reasoningLevel: { values: ["low"] } };

export type MemoryApp = Awaited<ReturnType<typeof createZCodeApp>>;
export type MemoryScript = (request: ModelRequest) => ModelTextResult | Promise<ModelTextResult>;

export function response(text = "Done", input?: unknown, toolName = "Memory"): ModelTextResult {
  return {
    text,
    finishReason: input ? "tool_calls" : "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    ...(input
      ? { toolCalls: [{ id: `memory-${crypto.randomUUID()}`, name: toolName, input }] }
      : {}),
  };
}

export async function openMemoryApp(input: {
  root: string;
  project: string;
  script: MemoryScript;
  extraction?: boolean;
  enabled?: boolean;
  profile?: string;
  workspaceIdentity?: string;
  subagents?: boolean;
  dynamicWorkflow?: boolean;
  skillsEnabled?: boolean;
}): Promise<MemoryApp> {
  const profileRoot = join(input.root, input.profile ?? "profile");
  const workspace = join(input.root, input.project);
  const userConfigPath = join(profileRoot, "config.json");
  const projectConfigPath = join(workspace, ".zcode", "config.json");
  await mkdir(profileRoot, { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  await writeFile(userConfigPath, "{}\n");
  await writeFile(
    projectConfigPath,
    JSON.stringify(
      input.skillsEnabled === undefined ? {} : { skills: { enabled: input.skillsEnabled } },
    ),
  );
  const model: Model = {
    providerId: PROVIDER as Model["providerId"],
    modelId: MODEL as Model["modelId"],
    properties: properties as Model["properties"],
    optionSpecs: optionSpecs as Model["optionSpecs"],
    options: { reasoningLevel: "low" },
    bind() {
      return model;
    },
    generateText: input.script,
    streamText: async function* () {
      throw new Error("Streaming is disabled in this fixture");
    },
  };
  const registryModel = { modelId: MODEL, config: { properties, optionSpecs } };
  const provider = {
    providerId: PROVIDER,
    providerName: "Memory integration fixture",
    config: { access: { type: "api-key" } },
    models: [registryModel],
  };
  return createZCodeApp({
    env: {
      HOME: profileRoot,
      USERPROFILE: profileRoot,
      PATH: process.env.PATH,
      ZCODE_STORAGE_DIR: profileRoot,
      ZCODE_SESSION_DB_PATH: join(profileRoot, "cli", "db", "session.sqlite"),
    },
    userConfigPath,
    projectConfigPath,
    modelAdapter: {
      addStatusSink() {},
      createModel: () => model,
      setModelIoFullRetentionEnabled() {},
    } as never,
    providerRegistry: {
      getModel: () => registryModel,
      getProvider: () => provider,
      getView: () => ({ providers: [provider], revision: 1 }),
      onDidChange: () => () => undefined,
      validateSelection: () => ({ ok: true }),
    } as never,
    runtimeConfig: {
      dynamicWorkflowEnabled: input.dynamicWorkflow ?? false,
      mcp: { enabled: false },
      memory: {
        enabled: input.enabled ?? true,
        extractionEnabled: input.extraction ?? false,
        workspaceIdentity: input.workspaceIdentity,
      },
      mode: "yolo",
      modelSelection: { providerId: PROVIDER, modelId: MODEL, options: { reasoningLevel: "low" } },
      modelStreaming: "off",
      subagents: { enabled: input.subagents ?? false },
      titleGeneration: { enabled: false },
      toolConcurrency: { maxConcurrency: 1 },
      workingDirectory: workspace,
    },
    version: "memory-integration",
  });
}

export async function prompt(app: MemoryApp, text: string): Promise<void> {
  const admission = await app.sendInput(text);
  if (admission.kind !== "started_turn") throw new Error(`Unexpected admission: ${admission.kind}`);
  await admission.completion;
}
