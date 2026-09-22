import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  modelMessageContentToText,
  type Model,
  type ModelEvent,
  type ModelRequest,
  type ModelTextResult,
  type PermissionBrokerPort,
} from "@zcode/contracts";
import { createZCodeApp } from "../src/app/create-app.js";

const PROVIDER_ID = "live-runtime-test";
const MODEL_ID = "deterministic";
const LIVE_TOOL = "live_word_count";
const PLUGIN_LIVE_TOOL = "plugin_live_probe";
const PLUGIN_NAME = "live-runtime-plugin";
const PLUGIN_MARKETPLACE = "local-fixture";
const PLUGIN_ID = `${PLUGIN_NAME}@${PLUGIN_MARKETPLACE}`;

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: { text: { type: "string" } },
  required: ["text"],
  type: "object",
};

const OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    count: { type: "integer" },
    revision: { type: "string" },
  },
  required: ["count", "revision"],
  type: "object",
};

type ZCodeApp = Awaited<ReturnType<typeof createZCodeApp>>;
type CapabilityStatus = ReturnType<ZCodeApp["getCapabilitiesStatus"]>;

function fixtureStoragePath(root: string, workspace: string): string {
  return join(root, "storage", workspace.split("/").at(-1) ?? "workspace");
}

class DeterministicModel implements Model {
  readonly providerId = PROVIDER_ID as Model["providerId"];
  readonly modelId = MODEL_ID as Model["modelId"];
  readonly properties = {
    contextWindow: 128_000,
    inputFormat: {
      supportsAudio: false,
      supportsImage: false,
      supportsPdf: false,
      supportsText: true,
      supportsVideo: false,
    },
    outputFormat: { supportsText: true },
    supportsJsonSchemaOutput: false,
    supportsMidConversationSystem: false,
    supportsNativeWebSearch: false,
    supportsToolCall: true,
  } as Model["properties"];
  readonly optionSpecs = {
    maxOutputTokens: { max: 1_024 },
    reasoningLevel: { values: ["low"] },
  } as Model["optionSpecs"];
  readonly options = { reasoningLevel: "low" } as Model["options"];

  constructor(private readonly driver: ScriptedModelDriver) {}

  bind(): Model {
    return this;
  }

  async generateText(request: ModelRequest): Promise<ModelTextResult> {
    return await this.driver.respond(request);
  }

  streamText(_request: ModelRequest): AsyncIterable<ModelEvent> {
    return (async function* (): AsyncIterable<ModelEvent> {
      throw new Error("The live runtime acceptance fixture requires non-streaming model execution");
    })();
  }
}

class ScriptedModelDriver {
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly script: (
      request: ModelRequest,
      call: number,
    ) => ModelTextResult | Promise<ModelTextResult>,
  ) {}

  async respond(request: ModelRequest): Promise<ModelTextResult> {
    this.requests.push(request);
    return await this.script(request, this.requests.length);
  }
}

function modelResult(input: {
  text: string;
  toolCalls?: ModelTextResult["toolCalls"];
}): ModelTextResult {
  return {
    finishReason: input.toolCalls?.length ? "tool_calls" : "stop",
    text: input.text,
    toolCalls: input.toolCalls,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function createProviderRegistry(): object {
  const model = {
    config: {
      optionSpecs: {
        maxOutputTokens: { max: 1_024 },
        reasoningLevel: { values: ["low"] },
      },
      properties: {
        contextWindow: 128_000,
        inputFormat: {
          supportsAudio: false,
          supportsImage: false,
          supportsPdf: false,
          supportsText: true,
          supportsVideo: false,
        },
        outputFormat: { supportsText: true },
        supportsJsonSchemaOutput: false,
        supportsMidConversationSystem: false,
        supportsNativeWebSearch: false,
        supportsToolCall: true,
      },
    },
    modelId: MODEL_ID,
  };
  const provider = {
    config: { access: { type: "api-key" } },
    models: [model],
    providerId: PROVIDER_ID,
    providerName: "Deterministic integration fixture",
  };
  return {
    getModel(providerId: string, modelId: string) {
      return providerId === PROVIDER_ID && modelId === MODEL_ID ? model : undefined;
    },
    getProvider(providerId: string) {
      return providerId === PROVIDER_ID ? provider : undefined;
    },
    getView() {
      return { providers: [provider], revision: 1 };
    },
    onDidChange() {
      return () => undefined;
    },
    validateSelection(selection: {
      modelId?: string;
      options?: { reasoningLevel?: string };
      providerId?: string;
    }) {
      if (selection.providerId !== PROVIDER_ID) {
        return { code: "provider-not-found", ok: false as const, providerId: selection.providerId };
      }
      if (selection.modelId !== MODEL_ID) {
        return {
          code: "model-not-found",
          modelId: selection.modelId,
          ok: false as const,
          providerId: PROVIDER_ID,
        };
      }
      if (selection.options?.reasoningLevel !== "low") {
        return {
          code: "reasoning-level-missing",
          modelId: MODEL_ID,
          ok: false as const,
          providerId: PROVIDER_ID,
        };
      }
      return { ok: true as const };
    },
  };
}

async function createFixture(input: {
  root: string;
  userHome: string;
  workspace: string;
  driver: ScriptedModelDriver;
  mode?: "build" | "yolo";
  permissionBroker?: PermissionBrokerPort;
  toolAllowlist?: string[];
}): Promise<ZCodeApp> {
  const storage = fixtureStoragePath(input.root, input.workspace);
  const sessionDbPath = join(storage, "cli", "db", "session.sqlite");
  const userConfigPath = join(input.userHome, ".zcode", "cli", "config.json");
  const projectConfigPath = join(input.workspace, ".zcode", "config.json");
  await mkdir(dirname(userConfigPath), { recursive: true });
  await mkdir(dirname(projectConfigPath), { recursive: true });
  try {
    await writeFile(userConfigPath, "{}\n", { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST")
      throw error;
  }
  await writeFile(projectConfigPath, "{}\n", "utf8");

  return await createZCodeApp({
    env: {
      HOME: input.userHome,
      PATH: process.env.PATH,
      USERPROFILE: input.userHome,
      ZCODE_SESSION_DB_PATH: sessionDbPath,
      ZCODE_STORAGE_DIR: storage,
    },
    modelAdapter: {
      addStatusSink() {},
      createModel() {
        return new DeterministicModel(input.driver);
      },
      setModelIoFullRetentionEnabled() {},
    } as never,
    ...(input.permissionBroker === undefined ? {} : { permissionBroker: input.permissionBroker }),
    providerRegistry: createProviderRegistry() as never,
    projectConfigPath,
    runtimeConfig: {
      dynamicWorkflowEnabled: false,
      maxTurns: 8,
      mcp: { enabled: false },
      memory: { enabled: false, extractionEnabled: false },
      mode: input.mode ?? "yolo",
      modelSelection: {
        modelId: MODEL_ID,
        options: { reasoningLevel: "low" },
        providerId: PROVIDER_ID,
      },
      modelStreaming: "off",
      subagents: { enabled: false },
      titleGeneration: { enabled: false },
      toolConcurrency: { maxConcurrency: 1 },
      ...(input.toolAllowlist === undefined ? {} : { toolAllowlist: input.toolAllowlist }),
      workingDirectory: input.workspace,
    },
    userConfigPath,
    version: "live-runtime-acceptance",
  });
}

async function runPrompt(app: ZCodeApp, text: string): Promise<void> {
  const admission = await app.sendInput(text);
  if (admission.kind !== "started_turn") {
    throw new Error(`Expected a started turn, received ${admission.kind}`);
  }
  await admission.completion;
}

function liveManifest(name = LIVE_TOOL): string {
  return JSON.stringify({
    id: `acceptance.${name}`,
    tools: [
      {
        command: { script: "./word-count.mjs" },
        description: "Count words through the live programmable-tool runtime.",
        inputSchema: INPUT_SCHEMA,
        name,
        outputSchema: OUTPUT_SCHEMA,
      },
    ],
    version: 1,
  });
}

function liveScript(revision: string): string {
  return [
    'let input = "";',
    "for await (const chunk of process.stdin) input += chunk;",
    "const { text } = JSON.parse(input);",
    "const count = text.trim().length === 0 ? 0 : text.trim().split(/\\s+/).length;",
    `process.stdout.write(JSON.stringify({ count, revision: ${JSON.stringify(revision)} }));`,
    "",
  ].join("\n");
}

function toolNames(request: ModelRequest): Set<string> {
  return new Set(request.tools?.map((tool) => tool.name));
}

function modelRequestText(request: ModelRequest): string {
  return request.messages.map((message) => modelMessageContentToText(message.content)).join("\n");
}

function hasTool(app: ZCodeApp, name: string): boolean {
  return app.runtime.getToolRegistry().list().includes(name);
}

function assertLiveToolResult(
  request: ModelRequest,
  expected: { count?: number; revision: string },
): void {
  assertToolResult(request, LIVE_TOOL, expected);
}

function assertToolResult(
  request: ModelRequest,
  toolName: string,
  expected: { count?: number; revision: string },
): void {
  const result = request.messages.findLast(
    (message) => message.role === "tool" && message.toolName === toolName,
  );
  assert.ok(result, `the next model request must include the ${toolName} result`);
  assert.equal(result.isError, false);
  assert.deepEqual(JSON.parse(modelMessageContentToText(result.content)), expected);
}

function assertDeniedLiveToolResult(request: ModelRequest, reason: string): void {
  const result = request.messages.findLast(
    (message) => message.role === "tool" && message.toolName === LIVE_TOOL,
  );
  assert.ok(result, "the next model request must include the denied live tool result");
  assert.equal(result.isError, true);
  assert.match(modelMessageContentToText(result.content), new RegExp(reason));
}

function waitForCapabilityStatus(
  app: ZCodeApp,
  description: string,
  predicate: (status: CapabilityStatus) => boolean,
  timeoutMs = 2_000,
): Promise<CapabilityStatus> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let latest: CapabilityStatus | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe?.();
      callback();
    };
    const listener = (status: CapabilityStatus): void => {
      latest = status;
      try {
        if (predicate(status)) finish(() => resolve(status));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    timeout = setTimeout(() => {
      finish(() => {
        reject(
          new Error(`Timed out waiting for ${description}; last status: ${JSON.stringify(latest)}`),
        );
      });
    }, timeoutMs);
    unsubscribe = app.subscribeCapabilities(listener);
    if (settled) unsubscribe();
  });
}

function assertReady(status: CapabilityStatus): asserts status is {
  revision: string;
  status: "ready";
} {
  assert.equal(status.status, "ready");
  assert.ok(typeof status.revision === "string" && status.revision.length > 0);
}

test("real app/runtime adopts a Write-created tool in the same turn and retains the last valid snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-acceptance-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const toolRoot = join(workspace, ".zcode", "tools");
  const manifestPath = join(toolRoot, "word-count.json");
  const scriptPath = join(toolRoot, "word-count.mjs");
  await mkdir(toolRoot, { recursive: true });

  const driver = new ScriptedModelDriver((request, call) => {
    const names = toolNames(request);
    switch (call) {
      case 1:
        assert.equal(
          names.has(LIVE_TOOL),
          false,
          "the first request must not invent the live tool",
        );
        assert.equal(
          names.has("Write"),
          true,
          "the model must use the real Write tool to add files",
        );
        assert.match(
          modelRequestText(request),
          /\.zcode\/tools/u,
          "the first model request must explain where to add live-tool manifests",
        );
        return modelResult({
          text: "",
          toolCalls: [
            {
              id: "write-live-manifest",
              input: { content: liveManifest(), file_path: manifestPath },
              name: "Write",
            },
            {
              id: "write-live-script",
              input: { content: liveScript("v1"), file_path: scriptPath },
              name: "Write",
            },
          ],
        });
      case 2:
        assert.equal(
          names.has(LIVE_TOOL),
          true,
          "the next model request in the same turn must receive the live tool contract",
        );
        return modelResult({
          text: "",
          toolCalls: [{ id: "run-live-v1", input: { text: "one two three" }, name: LIVE_TOOL }],
        });
      case 3:
        assertLiveToolResult(request, { count: 3, revision: "v1" });
        return modelResult({ text: "The first live tool execution completed." });
      case 4:
        assert.equal(names.has(LIVE_TOOL), true, "an edited script must keep its adopted contract");
        return modelResult({
          text: "",
          toolCalls: [{ id: "run-live-v2", input: { text: "four five" }, name: LIVE_TOOL }],
        });
      case 5:
        assertLiveToolResult(request, { count: 2, revision: "v2" });
        return modelResult({ text: "The edited live tool execution completed." });
      case 6:
        assert.equal(
          names.has(LIVE_TOOL),
          true,
          "an invalid replacement must leave the previously adopted live tool callable",
        );
        return modelResult({
          text: "",
          toolCalls: [{ id: "run-retained-v2", input: { text: "six seven" }, name: LIVE_TOOL }],
        });
      case 7:
        assertLiveToolResult(request, { count: 2, revision: "v2" });
        return modelResult({ text: "The retained live tool execution completed." });
      case 8:
        assert.equal(names.has(LIVE_TOOL), false, "deleted manifests must remove their live tool");
        return modelResult({ text: "The deleted live tool is absent." });
      default:
        throw new Error(`Unexpected model request ${call}`);
    }
  });

  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({ driver, root, userHome, workspace });
    const capabilityStatuses: ReturnType<ZCodeApp["getCapabilitiesStatus"]>[] = [];
    const unsubscribe = app.subscribeCapabilities((status) => capabilityStatuses.push(status));
    try {
      const emptyCatalogStatus = await app.refreshCapabilities();
      assertReady(emptyCatalogStatus);
      assert.equal(hasTool(app, LIVE_TOOL), false);

      await runPrompt(app, "Create and use the live word-count tool.");
      const firstStatus = app.getCapabilitiesStatus();
      assertReady(firstStatus);
      assert.notEqual(firstStatus.revision, emptyCatalogStatus.revision);
      assert.equal(hasTool(app, LIVE_TOOL), true);

      const editedStatusPromise = waitForCapabilityStatus(
        app,
        "the idle live-tool script edit to publish a new ready revision",
        (status) => status.status === "ready" && status.revision !== firstStatus.revision,
      );
      await writeFile(scriptPath, liveScript("v2"), "utf8");
      const editedStatus = await editedStatusPromise;
      assertReady(editedStatus);
      assert.notEqual(editedStatus.revision, firstStatus.revision);
      assert.equal(hasTool(app, LIVE_TOOL), true);
      await runPrompt(app, "Run the edited live word-count tool.");

      const skillPath = join(workspace, ".agents", "skills", "live-runtime-skill", "SKILL.md");
      const skillStatusPromise = waitForCapabilityStatus(
        app,
        "the idle skill addition to publish a new ready revision",
        (status) => status.status === "ready" && status.revision !== editedStatus.revision,
      );
      await mkdir(dirname(skillPath), { recursive: true });
      await writeFile(
        skillPath,
        "---\nname: live-runtime-skill\ndescription: A skill added while the session is idle.\n---\nUse the live runtime test fixture.\n",
        "utf8",
      );
      const skillStatus = await skillStatusPromise;
      assertReady(skillStatus);
      assert.notEqual(skillStatus.revision, editedStatus.revision);
      const skillCatalog = await app.getSkillCatalog();
      assert.equal(
        skillCatalog.skills.some((skill) => skill.name === "live-runtime-skill"),
        true,
      );
      assert.equal(
        capabilityStatuses.some(
          (status) => status.status === "ready" && status.revision === skillStatus.revision,
        ),
        true,
        "the status subscription must report the revision reflected by the idle skill catalog",
      );

      const invalidStatusPromise = waitForCapabilityStatus(
        app,
        "the invalid manifest to publish an error while retaining the prior revision",
        (status) => status.status === "error" && status.revision === skillStatus.revision,
      );
      await writeFile(manifestPath, "{ invalid manifest", "utf8");
      const invalidStatus = await invalidStatusPromise;
      assert.equal(invalidStatus.status, "error");
      assert.equal(invalidStatus.revision, skillStatus.revision);
      assert.equal(hasTool(app, LIVE_TOOL), true);
      await runPrompt(app, "Run the still-valid live tool after the failed replacement.");

      const deletedStatusPromise = waitForCapabilityStatus(
        app,
        "the manifest deletion to publish a new ready revision",
        (status) => status.status === "ready" && status.revision !== skillStatus.revision,
      );
      await unlink(manifestPath);
      const deletedStatus = await deletedStatusPromise;
      assertReady(deletedStatus);
      assert.notEqual(deletedStatus.revision, skillStatus.revision);
      assert.equal(hasTool(app, LIVE_TOOL), false);
      await runPrompt(app, "Confirm that the deleted live tool cannot be selected.");
      assert.equal(driver.requests.length, 8);
    } finally {
      unsubscribe();
    }
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("skill feature gates retract and restore the live skill catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-skill-gates-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const projectConfigPath = join(workspace, ".zcode", "config.json");
  const skillName = "live-gated-skill";
  const skillPath = join(workspace, ".agents", "skills", skillName, "SKILL.md");
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(
    skillPath,
    `---\nname: ${skillName}\ndescription: Skill gate acceptance fixture.\n---\nUse the live gate fixture.\n`,
    "utf8",
  );

  const noRequests = new ScriptedModelDriver(() => {
    throw new Error("skill gate acceptance only refreshes the idle capability catalog");
  });
  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({ driver: noRequests, root, userHome, workspace });
    let status = await app.refreshCapabilities();
    assertReady(status);
    assert.equal(hasTool(app, "Skill"), true);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === skillName),
      true,
    );

    const setProjectConfig = async (
      config: Record<string, unknown>,
      description: string,
    ): Promise<void> => {
      const previousRevision = status.revision;
      const nextStatusPromise = waitForCapabilityStatus(
        app!,
        description,
        (next) => next.status === "ready" && next.revision !== previousRevision,
      );
      await writeFile(projectConfigPath, `${JSON.stringify(config)}\n`, "utf8");
      status = await nextStatusPromise;
      assertReady(status);
    };

    await setProjectConfig(
      { features: { skill: false } },
      "features.skill=false to retract the active skill capability",
    );
    assert.equal(hasTool(app, "Skill"), false);
    assert.equal((await app.getSkillCatalog()).skills.length, 0);

    await setProjectConfig({}, "features.skill restore to republish the active skill capability");
    assert.equal(hasTool(app, "Skill"), true);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === skillName),
      true,
    );

    await setProjectConfig(
      { skills: { enabled: false } },
      "skills.enabled=false to retract the active skill capability",
    );
    assert.equal(hasTool(app, "Skill"), false);
    assert.equal((await app.getSkillCatalog()).skills.length, 0);

    await setProjectConfig({}, "skills.enabled restore to republish the active skill capability");
    assert.equal(hasTool(app, "Skill"), true);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === skillName),
      true,
    );
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("an installed local plugin's live tool and skill follow its enable toggle", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-plugin-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const projectConfigPath = join(workspace, ".zcode", "config.json");
  const pluginRoot = join(root, "installed-local-plugin");
  const pluginSkillName = "plugin-live-skill";
  const pluginStorageRoot = join(fixtureStoragePath(root, workspace), "cli", "plugins");

  await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", pluginSkillName), { recursive: true });
  await mkdir(join(pluginRoot, "tools"), { recursive: true });
  await mkdir(pluginStorageRoot, { recursive: true });
  await writeFile(
    join(pluginRoot, ".zcode-plugin", "plugin.json"),
    JSON.stringify({
      description: "Installed local plugin acceptance fixture.",
      name: PLUGIN_NAME,
      skills: ["skills"],
      version: "1.0.0",
    }),
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "skills", pluginSkillName, "SKILL.md"),
    `---\nname: ${pluginSkillName}\ndescription: Installed plugin skill fixture.\n---\nUse the plugin fixture.\n`,
    "utf8",
  );
  await writeFile(
    join(pluginRoot, "tools", "plugin-tool.json"),
    liveManifest(PLUGIN_LIVE_TOOL),
    "utf8",
  );
  await writeFile(join(pluginRoot, "tools", "word-count.mjs"), liveScript("plugin"), "utf8");
  await writeFile(
    join(pluginStorageRoot, "installed_plugins.json"),
    `${JSON.stringify({
      plugins: [
        {
          id: PLUGIN_ID,
          installPath: pluginRoot,
          installedAt: "2026-01-01T00:00:00.000Z",
          marketplace: PLUGIN_MARKETPLACE,
          name: PLUGIN_NAME,
          scope: "workspace",
          version: "1.0.0",
        },
      ],
      version: 1,
    })}\n`,
    "utf8",
  );

  const driver = new ScriptedModelDriver((request, call) => {
    switch (call) {
      case 1:
        assert.equal(
          toolNames(request).has(PLUGIN_LIVE_TOOL),
          true,
          "the enabled installed plugin tool must be supplied to the model",
        );
        return modelResult({
          text: "",
          toolCalls: [
            {
              id: "run-plugin-live-tool",
              input: { text: "plugin tool" },
              name: PLUGIN_LIVE_TOOL,
            },
          ],
        });
      case 2:
        assertToolResult(request, PLUGIN_LIVE_TOOL, { count: 2, revision: "plugin" });
        return modelResult({ text: "The enabled plugin live tool ran." });
      default:
        throw new Error(`Unexpected model request ${call}`);
    }
  });

  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({ driver, root, userHome, workspace });
    let status = await app.refreshCapabilities();
    assertReady(status);
    assert.equal(hasTool(app, PLUGIN_LIVE_TOOL), false);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === pluginSkillName),
      false,
    );

    const enabledStatusPromise = waitForCapabilityStatus(
      app,
      "the installed plugin enable toggle to publish a new ready revision",
      (next) => next.status === "ready" && next.revision !== status.revision,
    );
    await writeFile(
      projectConfigPath,
      `${JSON.stringify({ plugins: { enabledPlugins: { [PLUGIN_ID]: true } } })}\n`,
      "utf8",
    );
    status = await enabledStatusPromise;
    assertReady(status);
    assert.equal(hasTool(app, PLUGIN_LIVE_TOOL), true);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === pluginSkillName),
      true,
    );
    await runPrompt(app, "Use the enabled local plugin tool.");
    assert.equal(driver.requests.length, 2);

    const disabledStatusPromise = waitForCapabilityStatus(
      app,
      "the installed plugin disable toggle to publish a new ready revision",
      (next) => next.status === "ready" && next.revision !== status.revision,
    );
    await writeFile(
      projectConfigPath,
      `${JSON.stringify({ plugins: { enabledPlugins: { [PLUGIN_ID]: false } } })}\n`,
      "utf8",
    );
    status = await disabledStatusPromise;
    assertReady(status);
    assert.equal(hasTool(app, PLUGIN_LIVE_TOOL), false);
    assert.equal(
      (await app.getSkillCatalog()).skills.some((skill) => skill.name === pluginSkillName),
      false,
    );
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("live capabilities remain bound to their workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-isolation-"));
  const userHome = join(root, "user");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const toolA = "workspace_a_only";
  const toolB = "workspace_b_only";
  await mkdir(join(workspaceA, ".zcode", "tools"), { recursive: true });
  await mkdir(join(workspaceB, ".zcode", "tools"), { recursive: true });
  await writeFile(join(workspaceA, ".zcode", "tools", "tool.json"), liveManifest(toolA), "utf8");
  await writeFile(
    join(workspaceA, ".zcode", "tools", "word-count.mjs"),
    liveScript("workspace-a"),
    "utf8",
  );

  const noRequests = new ScriptedModelDriver(() => {
    throw new Error("workspace-isolation only refreshes idle catalogs");
  });
  let appA: ZCodeApp | undefined;
  let appB: ZCodeApp | undefined;
  try {
    appA = await createFixture({ driver: noRequests, root, userHome, workspace: workspaceA });
    appB = await createFixture({ driver: noRequests, root, userHome, workspace: workspaceB });

    const firstA = await appA.refreshCapabilities();
    const firstB = await appB.refreshCapabilities();
    assertReady(firstA);
    assertReady(firstB);
    assert.equal(hasTool(appA, toolA), true);
    assert.equal(hasTool(appB, toolA), false);

    await writeFile(join(workspaceB, ".zcode", "tools", "tool.json"), liveManifest(toolB), "utf8");
    await writeFile(
      join(workspaceB, ".zcode", "tools", "word-count.mjs"),
      liveScript("workspace-b"),
      "utf8",
    );
    const refreshedB = await appB.refreshCapabilities();
    const refreshedA = await appA.refreshCapabilities();
    assertReady(refreshedB);
    assertReady(refreshedA);
    assert.equal(hasTool(appA, toolA), true);
    assert.equal(hasTool(appA, toolB), false);
    assert.equal(hasTool(appB, toolA), false);
    assert.equal(hasTool(appB, toolB), true);
  } finally {
    await appA?.close?.();
    await appB?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("live tools respect the runtime tool allowlist before reaching the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-allowlist-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const toolRoot = join(workspace, ".zcode", "tools");
  await mkdir(toolRoot, { recursive: true });
  await writeFile(join(toolRoot, "tool.json"), liveManifest(), "utf8");
  await writeFile(join(toolRoot, "word-count.mjs"), liveScript("allowlist"), "utf8");

  const driver = new ScriptedModelDriver((request, call) => {
    assert.equal(call, 1);
    assert.equal(
      toolNames(request).has(LIVE_TOOL),
      false,
      "a live tool outside the allowlist must not be exposed to the model",
    );
    return modelResult({ text: "The allowlisted catalog excludes the live tool." });
  });
  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({
      driver,
      root,
      toolAllowlist: ["Read"],
      userHome,
      workspace,
    });
    await runPrompt(app, "Confirm the available tools.");
    assertReady(app.getCapabilitiesStatus());
    assert.equal(hasTool(app, LIVE_TOOL), false);
    assert.equal(driver.requests.length, 1);
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("an allowlisted live tool stays registered and model-visible", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-allowlisted-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const toolRoot = join(workspace, ".zcode", "tools");
  await mkdir(toolRoot, { recursive: true });
  await writeFile(join(toolRoot, "tool.json"), liveManifest(), "utf8");
  await writeFile(join(toolRoot, "word-count.mjs"), liveScript("allowlisted"), "utf8");

  const driver = new ScriptedModelDriver((request, call) => {
    switch (call) {
      case 1:
        assert.equal(toolNames(request).has(LIVE_TOOL), true);
        return modelResult({
          text: "",
          toolCalls: [
            { id: "run-allowlisted-live-tool", input: { text: "one two" }, name: LIVE_TOOL },
          ],
        });
      case 2:
        assertLiveToolResult(request, { count: 2, revision: "allowlisted" });
        return modelResult({ text: "The allowlisted live tool ran." });
      default:
        throw new Error(`Unexpected model request ${call}`);
    }
  });
  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({
      driver,
      root,
      toolAllowlist: [LIVE_TOOL],
      userHome,
      workspace,
    });
    await runPrompt(app, "Run the allowlisted live tool.");
    assertReady(app.getCapabilitiesStatus());
    assert.equal(hasTool(app, LIVE_TOOL), true);
    assert.equal(driver.requests.length, 2);
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});

test("a denied live tool call does not execute its configured script", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-live-runtime-permission-"));
  const workspace = join(root, "workspace");
  const userHome = join(root, "user");
  const toolRoot = join(workspace, ".zcode", "tools");
  const markerPath = join(root, "live-tool-was-executed");
  const denialReason = "fixture denied the live tool";
  await mkdir(toolRoot, { recursive: true });
  await writeFile(join(toolRoot, "tool.json"), liveManifest(), "utf8");
  await writeFile(
    join(toolRoot, "word-count.mjs"),
    [
      `await (await import("node:fs/promises")).writeFile(${JSON.stringify(markerPath)}, "executed", "utf8");`,
      'process.stdout.write(JSON.stringify({ count: 0, revision: "denied" }));',
      "",
    ].join("\n"),
    "utf8",
  );

  const requestedTools: string[] = [];
  const permissionBroker: PermissionBrokerPort = {
    async requestPermission(request) {
      requestedTools.push(request.toolName);
      return { decision: "deny", reason: denialReason };
    },
  };
  const driver = new ScriptedModelDriver((request, call) => {
    switch (call) {
      case 1:
        assert.equal(toolNames(request).has(LIVE_TOOL), true);
        return modelResult({
          text: "",
          toolCalls: [{ id: "deny-live-tool", input: { text: "must not run" }, name: LIVE_TOOL }],
        });
      case 2:
        assertDeniedLiveToolResult(request, denialReason);
        return modelResult({ text: "The live tool was denied." });
      default:
        throw new Error(`Unexpected model request ${call}`);
    }
  });
  let app: ZCodeApp | undefined;
  try {
    app = await createFixture({
      driver,
      mode: "build",
      permissionBroker,
      root,
      userHome,
      workspace,
    });
    await runPrompt(app, "Attempt the protected live tool.");
    assert.deepEqual(requestedTools, [LIVE_TOOL]);
    await assert.rejects(access(markerPath), /ENOENT/u);
    assert.equal(driver.requests.length, 2);
  } finally {
    await app?.close?.();
    await rm(root, { force: true, recursive: true });
  }
});
