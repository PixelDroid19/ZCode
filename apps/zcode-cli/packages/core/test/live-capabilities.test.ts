import assert from "node:assert/strict";
import test from "node:test";
import { createInMemorySessionEventStore, type ExecutionShellSelection } from "@zcode/contracts";

import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import {
  RuntimeCapabilityController,
  type PreparedRuntimeCapabilities,
  type RuntimeCapabilitySource,
} from "../src/runtime/live-capabilities.js";

const TRACE_CONTEXT = { traceId: "trace-live-capabilities" } as const;

test("adopts a complete extension snapshot without replacing built-ins", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const committed: string[] = [];
  const source = sourceFrom([prepared("revision-1", [tool("Extension")], { committed })]);
  const controller = new RuntimeCapabilityController({ registry, source });

  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(registry.list(), ["BuiltIn", "Extension"]);
  assert.equal(status.status, "ready");
  assert.equal(status.revision, "revision-1");
  assert.deepEqual(committed, ["revision-1"]);
});

test("isolates throwing capability observers from an accepted adoption", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  const controller = new RuntimeCapabilityController({
    registry,
    source: sourceFrom([prepared("revision-1", [tool("Extension")], { released })]),
  });

  controller.subscribe(() => {
    throw new Error("initial observer failure");
  });
  controller.subscribe((status) => {
    if (status.revision === "revision-1" && status.status === "ready") {
      throw new Error("accepted observer failure");
    }
  });

  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(status, { revision: "revision-1", status: "ready" });
  assert.deepEqual(registry.list(), ["BuiltIn", "Extension"]);
  assert.deepEqual(released, []);

  await controller.dispose();
  assert.deepEqual(released, ["revision-1"]);
});

test("retains the adopted snapshot when a later candidate duplicates a built-in identity", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  const source = sourceFrom([
    prepared("revision-1", [tool("Extension")], { released }),
    prepared("revision-2", [tool("BuiltIn")], { released }),
  ]);
  const controller = new RuntimeCapabilityController({ registry, source });

  await controller.refresh({ traceContext: TRACE_CONTEXT });
  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(registry.list(), ["BuiltIn", "Extension"]);
  assert.equal(status.status, "error");
  assert.equal(status.revision, "revision-1");
  assert.equal(status.error, "Capability refresh failed");
  assert.deepEqual(released, ["revision-2"]);
});

test("rolls back companion runtime state when a candidate commit fails", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  let companionState = "previous";
  const candidate: PreparedRuntimeCapabilities = {
    ...prepared("revision-1", [tool("Extension")], { released }),
    commit() {
      throw new Error("commit failed");
    },
  };
  const controller = new RuntimeCapabilityController({
    onAdopt() {
      companionState = "candidate";
      return () => {
        companionState = "previous";
      };
    },
    registry,
    source: sourceFrom([candidate]),
  });

  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(status, { error: "Capability refresh failed", status: "error" });
  assert.equal(companionState, "previous");
  assert.deepEqual(registry.list(), ["BuiltIn"]);
  assert.deepEqual(released, ["revision-1"]);
});

test("rejects a non-atomic custom registry without changing its current catalog", async () => {
  const atomicRegistry = createToolRegistry();
  atomicRegistry.register(tool("BuiltIn"));
  const registry = {
    get: atomicRegistry.get.bind(atomicRegistry),
    getMetadata: atomicRegistry.getMetadata.bind(atomicRegistry),
    has: atomicRegistry.has.bind(atomicRegistry),
    list: atomicRegistry.list.bind(atomicRegistry),
    register: atomicRegistry.register.bind(atomicRegistry),
    toContracts: atomicRegistry.toContracts.bind(atomicRegistry),
    unregister: atomicRegistry.unregister.bind(atomicRegistry),
  };
  const controller = new RuntimeCapabilityController({
    registry,
    source: sourceFrom([prepared("revision-1", [tool("Extension")])]),
  });

  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(atomicRegistry.list(), ["BuiltIn"]);
  assert.deepEqual(status, { error: "Capability refresh failed", status: "error" });
});

test("removes extension-owned tools when the next adopted snapshot deletes them", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  const source = sourceFrom([
    prepared("revision-1", [tool("Extension")], { released }),
    prepared("revision-2", [], { released }),
  ]);
  const controller = new RuntimeCapabilityController({ registry, source });

  await controller.refresh({ traceContext: TRACE_CONTEXT });
  await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(registry.list(), ["BuiltIn"]);
  assert.deepEqual(released, ["revision-1"]);
});

test("serializes overlapping refreshes and passes the adopted revision to the next prepare", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const firstPrepare = deferred<PreparedRuntimeCapabilities | undefined>();
  const revisions: Array<string | undefined> = [];
  let calls = 0;
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      revisions.push(input.revision);
      calls += 1;
      return calls === 1 ? firstPrepare.promise : prepared("revision-2", [tool("Second")]);
    },
  };
  const controller = new RuntimeCapabilityController({ registry, source });

  const first = controller.refresh({ traceContext: TRACE_CONTEXT });
  const second = controller.refresh({ traceContext: TRACE_CONTEXT });
  firstPrepare.resolve(prepared("revision-1", [tool("First")]));
  await Promise.all([first, second]);

  assert.deepEqual(revisions, [undefined, "revision-1"]);
  assert.deepEqual(registry.list(), ["BuiltIn", "Second"]);
  assert.equal(controller.getStatus().revision, "revision-2");
});

test("drains a superseded prepared resource before releasing it", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  const source = sourceFrom([
    prepared("revision-1", [tool("Extension")], { released }),
    prepared("revision-2", [tool("Replacement")], { released }),
  ]);
  const controller = new RuntimeCapabilityController({ registry, source });

  await controller.refresh({ traceContext: TRACE_CONTEXT });
  const releaseLease = controller.acquireLease();
  await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(released, []);
  await releaseLease();
  assert.deepEqual(released, ["revision-1"]);
});

test("concurrent capability disposal shares the same drain and source cleanup", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  let sourceDisposals = 0;
  const controller = new RuntimeCapabilityController({
    registry,
    source: {
      async prepare() {
        return prepared("revision-1", [tool("Extension")], { released });
      },
      dispose() {
        sourceDisposals += 1;
      },
    },
  });
  await controller.refresh({ traceContext: TRACE_CONTEXT });
  const releaseLease = controller.acquireLease();

  const firstDispose = controller.dispose();
  const secondDispose = controller.dispose();
  assert.strictEqual(firstDispose, secondDispose);
  await releaseLease();
  await firstDispose;

  assert.deepEqual(released, ["revision-1"]);
  assert.equal(sourceDisposals, 1);
});

test("runtime disposal stops leased background children before releasing its source", async () => {
  const runtimeTaskRegistry = new InMemoryRuntimeTaskRegistry();
  let sourceDisposals = 0;
  let stoppedTasks = 0;
  let inherited: ReturnType<AgentRuntime["createInheritedCapabilitySource"]>;
  const runtime = new AgentRuntime(
    "session-background-disposal" as never,
    { workingDirectory: process.cwd() },
    {
      capabilitySource: {
        async prepare(input) {
          return input.revision === undefined
            ? prepared("revision-1", [tool("Extension")])
            : undefined;
        },
        dispose() {
          sourceDisposals += 1;
        },
      },
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
      runtimeTaskRegistry,
      subagentPort: {
        async stopTask(taskId) {
          stoppedTasks += 1;
          runtimeTaskRegistry.update(taskId, (task) => ({ ...task, status: "killed" }));
          await inherited?.dispose?.();
          return runtimeTaskRegistry.get(taskId) as never;
        },
      } as never,
    },
  );
  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  inherited = runtime.createInheritedCapabilitySource();
  assert.ok(inherited);
  runtimeTaskRegistry.register({
    agentId: "background-child",
    agentType: "test",
    description: "leased child",
    isBackgrounded: true,
    startedAt: new Date(),
    status: "running",
    taskId: "background-child",
    type: "local_agent",
  } as never);

  const firstDispose = runtime.disposeCapabilities();
  const secondDispose = runtime.disposeCapabilities();
  assert.strictEqual(firstDispose, secondDispose);
  await firstDispose;

  assert.equal(stoppedTasks, 1);
  assert.equal(sourceDisposals, 1);
});

test("returns to ready when a dirty source reports no new candidate", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const controller = new RuntimeCapabilityController({
    registry,
    source: sourceFrom([prepared("revision-1", [tool("Extension")]), undefined]),
  });

  await controller.refresh({ traceContext: TRACE_CONTEXT });
  controller.markDirty();
  assert.equal(controller.getStatus().status, "loading");
  const status = await controller.refresh({ traceContext: TRACE_CONTEXT });

  assert.deepEqual(status, { revision: "revision-1", status: "ready" });
});

test("keeps the last accepted status when preparation is aborted", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      if (input.revision === undefined) {
        return prepared("revision-1", [tool("Extension")]);
      }
      input.abortSignal?.throwIfAborted();
      return undefined;
    },
  };
  const controller = new RuntimeCapabilityController({ registry, source });
  await controller.refresh({ traceContext: TRACE_CONTEXT });
  const abortController = new AbortController();
  abortController.abort();

  const status = await controller.refresh({
    abortSignal: abortController.signal,
    traceContext: TRACE_CONTEXT,
  });

  assert.deepEqual(status, { revision: "revision-1", status: "ready" });
  assert.deepEqual(registry.list(), ["BuiltIn", "Extension"]);
});

test("inherited source retains the parent snapshot until the child source closes", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const released: string[] = [];
  const controller = new RuntimeCapabilityController({
    registry,
    source: sourceFrom([
      prepared("revision-1", [tool("First")], { released }),
      prepared("revision-2", [tool("Second")], { released }),
    ]),
  });

  await controller.refresh({ traceContext: TRACE_CONTEXT });
  const inherited = controller.createInheritedSource();
  assert.ok(inherited);
  await controller.refresh({ traceContext: TRACE_CONTEXT });
  assert.deepEqual(released, []);

  const inheritedPrepared = await inherited.prepare({ traceContext: TRACE_CONTEXT });
  assert.equal(inheritedPrepared?.revision, "revision-1");
  assert.deepEqual(
    inheritedPrepared?.tools.map((entry) => entry.metadata.name),
    ["First"],
  );
  await inherited.dispose?.();
  assert.deepEqual(released, ["revision-1"]);
});

test("workflow inheritance excludes parent subagent policy unless explicitly requested", async () => {
  const registry = createToolRegistry();
  registry.register(tool("BuiltIn"));
  const controller = new RuntimeCapabilityController({
    registry,
    source: sourceFrom([
      {
        ...prepared("revision-1", [tool("Extension")]),
        runtimeConfig: {
          hooks: { enabled: true, events: {}, maxOutputBytes: 1_024, timeoutMs: 1_000 },
          runtimeFeatures: { nodeRepl: true },
          skillMetadataBudget: 12_345,
          subagents: { enabled: true },
        },
      },
    ]),
  });
  await controller.refresh({ traceContext: TRACE_CONTEXT });

  const defaultChild = controller.createInheritedSource();
  const workflowChild = controller.createInheritedSource({ inheritRuntimeConfig: true });
  assert.ok(defaultChild);
  assert.ok(workflowChild);
  const defaultPrepared = await defaultChild.prepare({ traceContext: TRACE_CONTEXT });
  const workflowPrepared = await workflowChild.prepare({ traceContext: TRACE_CONTEXT });

  assert.equal(defaultPrepared?.runtimeConfig, undefined);
  assert.deepEqual(workflowPrepared?.runtimeConfig, {
    hooks: { enabled: true, events: {}, maxOutputBytes: 1_024, timeoutMs: 1_000 },
    runtimeFeatures: { nodeRepl: true },
    skillMetadataBudget: 12_345,
  });
  await defaultChild.dispose?.();
  await workflowChild.dispose?.();
});

test("runtime adopts idle source snapshots and exposes a defensive catalog status", async () => {
  const revisions: Array<string | undefined> = [];
  const statuses: string[] = [];
  let notifyChange: (() => void) | undefined;
  let disposed = 0;
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      revisions.push(input.revision);
      if (input.revision === undefined) {
        return {
          ...prepared("revision-1", [tool("Extension")]),
          pluginReferenceCatalog: catalog("one"),
        };
      }
      if (input.revision === "revision-1") {
        return {
          ...prepared("revision-2", []),
          pluginReferenceCatalog: catalog("two"),
        };
      }
      if (input.revision === "revision-2") {
        return {
          ...prepared("revision-3", [tool("Skill")]),
          pluginReferenceCatalog: catalog("rejected"),
        };
      }
      return undefined;
    },
    subscribe(listener) {
      notifyChange = listener;
      return () => {
        notifyChange = undefined;
      };
    },
    dispose() {
      disposed += 1;
    },
  };
  const runtime = new AgentRuntime(
    "session-live-capabilities" as never,
    { subagents: { enabled: false }, workingDirectory: process.cwd() },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
    },
  );
  const unsubscribe = runtime.subscribeCapabilities((status) => statuses.push(status.status));

  const initial = await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  assert.equal(initial.revision, "revision-1");
  assert.ok(runtime.getTools().some((entry) => entry.name === "Extension"));
  const firstCatalog = runtime.getPluginReferenceCatalog();
  assert.equal(firstCatalog?.plugins[0]?.name, "one");
  firstCatalog?.plugins.splice(0, 1);
  assert.equal(runtime.getPluginReferenceCatalog()?.plugins.length, 1);

  let stopUpdatedSubscription = () => undefined;
  const updated = new Promise<ReturnType<typeof runtime.getCapabilitiesStatus>>((resolve) => {
    stopUpdatedSubscription = runtime.subscribeCapabilities((status) => {
      if (status.revision === "revision-2" && status.status === "ready") {
        stopUpdatedSubscription();
        resolve(status);
      }
    });
  });
  notifyChange?.();
  assert.equal(runtime.getCapabilitiesStatus().status, "loading");
  const updatedStatus = await updated;
  assert.equal(updatedStatus.revision, "revision-2");
  assert.ok(!runtime.getTools().some((entry) => entry.name === "Extension"));
  assert.equal(runtime.getPluginReferenceCatalog()?.plugins[0]?.name, "two");
  assert.deepEqual(revisions, [undefined, "revision-1"]);
  assert.ok(statuses.includes("loading"));

  const rejected = await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  assert.deepEqual(rejected, {
    error: "Capability refresh failed",
    revision: "revision-2",
    status: "error",
  });
  assert.equal(runtime.getPluginReferenceCatalog()?.plugins[0]?.name, "two");
  assert.ok(!runtime.getTools().some((entry) => entry.name === "Skill"));

  unsubscribe();
  await runtime.disposeCapabilities();
  assert.equal(disposed, 1);
});

test("shell initialization does not restore Agent after a live snapshot disables subagents", async () => {
  const runtime = new AgentRuntime(
    "session-disabled-live-subagents" as never,
    { subagents: { enabled: true }, workingDirectory: process.cwd() },
    {
      capabilitySource: sourceFrom([
        {
          ...prepared("revision-1", [tool("Extension")]),
          runtimeConfig: { subagents: { enabled: false } },
        },
      ]),
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
    },
  );
  const shell: ExecutionShellSelection = {
    dialect: "posix",
    display: { name: "bash" },
    source: "auto-detected",
  };

  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  assert.ok(!runtime.getTools().some((entry) => entry.name === "Agent"));

  assert.equal(runtime.initializeSessionShellEnvironmentIfNeeded(shell), true);
  assert.ok(!runtime.getTools().some((entry) => entry.name === "Agent"));

  await runtime.disposeCapabilities();
});

test("a source-owned MCP snapshot atomically replaces seeded legacy MCP tools", async () => {
  const registry = createToolRegistry();
  registry.register(mcpTool("mcp__legacy__read"));
  const runtime = new AgentRuntime(
    "session-source-owned-mcp" as never,
    { workingDirectory: process.cwd() },
    {
      capabilitySource: {
        ownsMcp: true,
        async prepare(input) {
          return input.revision === undefined
            ? prepared("revision-1", [mcpTool("mcp__live__read")])
            : undefined;
        },
      },
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
      toolRegistry: registry,
    },
  );

  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });

  assert.ok(!runtime.getTools().some((entry) => entry.name === "mcp__legacy__read"));
  assert.ok(runtime.getTools().some((entry) => entry.name === "mcp__live__read"));
  await runtime.disposeCapabilities();
});

test("a disabled live browser-use feature removes the browser port from tool execution", async () => {
  let receivedBrowserControlPort: unknown = "not-called";
  const probe: ToolEntry = {
    ...tool("BrowserPortProbe"),
    handler: async (_input, context) => {
      receivedBrowserControlPort = context.browserControlPort;
      return {};
    },
  };
  const runtime = new AgentRuntime(
    "session-live-browser-port" as never,
    {
      runtimeFeatures: { browserUse: true, nodeRepl: true },
      workingDirectory: process.cwd(),
    },
    {
      browserControlPort: {} as never,
      capabilitySource: sourceFrom([
        {
          ...prepared("revision-1", [probe]),
          runtimeConfig: { runtimeFeatures: { browserUse: false, nodeRepl: true } },
        },
      ]),
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
    },
  );
  const calls = [{ id: "browser-port-probe", input: {}, name: "BrowserPortProbe" }] as never;

  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  const schedule = await runtime.scheduleTools(calls);
  const result = await runtime.executeTools(calls, schedule, { traceContext: TRACE_CONTEXT });

  assert.equal(result.results[0]?.success, true);
  assert.equal(receivedBrowserControlPort, undefined);
  await runtime.disposeCapabilities();
});

test("a source watcher refreshes an idle runtime without a manual catalog read", async () => {
  let notifyChange: (() => void) | undefined;
  const revisions: Array<string | undefined> = [];
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      revisions.push(input.revision);
      return input.revision === undefined
        ? prepared("revision-1", [tool("First")])
        : prepared("revision-2", [tool("Second")]);
    },
    subscribe(listener) {
      notifyChange = listener;
      return () => {
        notifyChange = undefined;
      };
    },
  };
  const runtime = new AgentRuntime(
    "session-idle-watcher" as never,
    { subagents: { enabled: false }, workingDirectory: process.cwd() },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
    },
  );
  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });

  let unsubscribe = () => undefined;
  const adopted = new Promise<void>((resolve) => {
    unsubscribe = runtime.subscribeCapabilities((status) => {
      if (status.revision === "revision-2" && status.status === "ready") {
        unsubscribe();
        resolve();
      }
    });
  });
  notifyChange?.();
  await adopted;

  assert.deepEqual(revisions, [undefined, "revision-1"]);
  assert.ok(runtime.getTools().some((entry) => entry.name === "Second"));
  assert.ok(!runtime.getTools().some((entry) => entry.name === "First"));
  await runtime.disposeCapabilities();
});

test("the next model request rebuilds idle-adopted skill and instruction context", async () => {
  let notifyChange: (() => void) | undefined;
  let generation = 1;
  const requestBodies: string[] = [];
  const model = {
    bind() {
      return model;
    },
    displayName: "Test model",
    generateText: async (request: { messages: unknown[] }) => {
      requestBodies.push(JSON.stringify(request.messages));
      return { finishReason: "stop", text: `response-${requestBodies.length}`, usage: {} };
    },
    modelId: "test-model",
    optionSpecs: {
      maxOutputTokens: { max: 4_096 },
      reasoningLevel: { values: [] },
    },
    options: {},
    properties: { contextWindow: 32_768, inputFormat: "text" },
    providerId: "test-provider",
    streamText: async function* () {
      throw new Error("streaming is disabled for this test");
    },
  };
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      if (input.revision === undefined) {
        return {
          ...prepared("revision-1", [tool("Extension")]),
          instructions: "Create new tools in .zcode/tools using the live manifest format.",
          skillPort: {} as never,
          skills: skillOutcome("first-skill", "first live skill description"),
        };
      }
      if (input.revision === "revision-1" && generation === 2) {
        return {
          ...prepared("revision-2", [tool("Extension")]),
          instructions: "Use the updated .zcode/tools manifest format.",
          skillPort: {} as never,
          skills: skillOutcome("second-skill", "second live skill description"),
        };
      }
      return undefined;
    },
    subscribe(listener) {
      notifyChange = listener;
      return () => {
        notifyChange = undefined;
      };
    },
  };
  const runtime = new AgentRuntime(
    "session-context-revision" as never,
    {
      modelSelection: { modelId: "test-model", providerId: "test-provider" },
      modelStreaming: "off",
      subagents: { enabled: false },
      workingDirectory: process.cwd(),
    },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model as never,
    },
  );
  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });
  await runtime.executeTurn("build initial context");
  assert.match(requestBodies[0] ?? "", /first live skill description/);
  assert.match(requestBodies[0] ?? "", /live manifest format/);

  let unsubscribe = () => undefined;
  const adopted = new Promise<void>((resolve) => {
    unsubscribe = runtime.subscribeCapabilities((status) => {
      if (status.revision === "revision-2" && status.status === "ready") {
        unsubscribe();
        resolve();
      }
    });
  });
  generation = 2;
  notifyChange?.();
  await adopted;

  await runtime.executeTurn("use the updated context");
  const updatedRequest = requestBodies[1] ?? "";
  assert.match(updatedRequest, /second live skill description/);
  assert.match(updatedRequest, /updated .zcode\/tools manifest format/);
  assert.doesNotMatch(updatedRequest, /first live skill description/);
  await runtime.disposeCapabilities();
});

test("a model boundary waits for a watcher read that lost idleness before adopting", async () => {
  const watchedCandidate = deferred<PreparedRuntimeCapabilities>();
  const watcherPrepareStarted = deferred<void>();
  const released: string[] = [];
  const observedTools: string[][] = [];
  let notifyChange: (() => void) | undefined;
  let changed = false;
  let changedPrepares = 0;
  const model = {
    bind() {
      return model;
    },
    displayName: "Test model",
    generateText: async (request: { tools?: Array<{ name: string }> }) => {
      observedTools.push((request.tools ?? []).map((tool) => tool.name));
      return { finishReason: "stop", text: "done", usage: {} };
    },
    modelId: "test-model",
    optionSpecs: {
      maxOutputTokens: { max: 4_096 },
      reasoningLevel: { values: [] },
    },
    options: {},
    properties: { contextWindow: 32_768, inputFormat: "text" },
    providerId: "test-provider",
    streamText: async function* () {
      throw new Error("streaming is disabled for this test");
    },
  };
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      if (input.revision === undefined) return prepared("revision-1", [tool("ToolA")]);
      if (!changed) return undefined;
      if (changedPrepares++ === 0) {
        watcherPrepareStarted.resolve();
        return watchedCandidate.promise;
      }
      return prepared("revision-2", [tool("ToolB")]);
    },
    subscribe(listener) {
      notifyChange = listener;
      return () => {
        notifyChange = undefined;
      };
    },
  };
  const runtime = new AgentRuntime(
    "session-watcher-race" as never,
    {
      modelSelection: { modelId: "test-model", providerId: "test-provider" },
      modelStreaming: "off",
      subagents: { enabled: false },
      workingDirectory: process.cwd(),
    },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model as never,
    },
  );
  await runtime.refreshCapabilities({ traceContext: TRACE_CONTEXT });

  changed = true;
  notifyChange?.();
  await watcherPrepareStarted.promise;
  const turn = runtime.executeTurn("use the refreshed catalog");
  await waitFor(() => runtime.getActiveTurnInfo() !== undefined);
  assert.ok(runtime.getTools().some((entry) => entry.name === "ToolA"));

  watchedCandidate.resolve(prepared("revision-2", [tool("ToolB")], { released }));
  const result = await turn;

  assert.equal(result.response, "done");
  assert.ok(observedTools[0]?.includes("ToolB"));
  assert.ok(!observedTools[0]?.includes("ToolA"));
  assert.deepEqual(released, ["revision-2"]);
  await runtime.disposeCapabilities();
});

test("refreshes the source between a completed tool step and the next model request", async () => {
  let generation = 1;
  const observedTools: string[][] = [];
  const model = {
    bind() {
      return model;
    },
    displayName: "Test model",
    generateText: async (request: { tools?: Array<{ name: string }> }) => {
      observedTools.push((request.tools ?? []).map((tool) => tool.name));
      if (observedTools.length === 1) {
        return {
          finishReason: "tool_calls",
          text: "",
          toolCalls: [{ id: "tool-call-a", input: {}, name: "ToolA" }],
          usage: {},
        };
      }
      return { finishReason: "stop", text: "done", usage: {} };
    },
    modelId: "test-model",
    optionSpecs: {
      maxOutputTokens: { max: 4_096 },
      reasoningLevel: { values: [] },
    },
    options: {},
    properties: { contextWindow: 32_768, inputFormat: "text" },
    providerId: "test-provider",
    streamText: async function* () {
      throw new Error("streaming is disabled for this test");
    },
  };
  const source: RuntimeCapabilitySource = {
    async prepare(input) {
      const revision = `revision-${generation}`;
      if (input.revision === revision) return undefined;
      return prepared(
        revision,
        generation === 1
          ? [
              {
                ...tool("ToolA"),
                handler: async () => {
                  generation = 2;
                  return {};
                },
              },
            ]
          : [tool("ToolB")],
      );
    },
  };
  const runtime = new AgentRuntime(
    "session-model-boundary" as never,
    {
      modelSelection: { modelId: "test-model", providerId: "test-provider" },
      modelStreaming: "off",
      subagents: { enabled: false },
      workingDirectory: process.cwd(),
    },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => model as never,
    },
  );

  const result = await runtime.executeTurn("use the live tool catalog");

  assert.equal(result.response, "done");
  assert.ok(observedTools[0]?.includes("ToolA"));
  assert.ok(!observedTools[0]?.includes("ToolB"));
  assert.ok(observedTools[1]?.includes("ToolB"));
  assert.ok(!observedTools[1]?.includes("ToolA"));
  await runtime.disposeCapabilities();
});

function sourceFrom(
  snapshots: Array<PreparedRuntimeCapabilities | undefined>,
): RuntimeCapabilitySource {
  return {
    async prepare() {
      return snapshots.shift();
    },
  };
}

function prepared(
  revision: string,
  tools: readonly ToolEntry[],
  lifecycle: { committed?: string[]; released?: string[] } = {},
): PreparedRuntimeCapabilities {
  return {
    revision,
    tools,
    skills: { diagnostics: [], skills: [], totalDiscovered: 0 },
    pluginReferenceCatalog: { plugins: [] },
    ...(lifecycle.committed ? { commit: () => lifecycle.committed?.push(revision) } : {}),
    ...(lifecycle.released ? { release: async () => void lifecycle.released?.push(revision) } : {}),
  };
}

function catalog(name: string) {
  return {
    plugins: [
      {
        conflictingPluginIds: [],
        enabled: true,
        marketplace: "test",
        mcpServerNames: [],
        name,
        pluginId: `${name}@test`,
        rootPath: "/plugin",
        skillQualifiedNames: [],
        subagentNames: [],
      },
    ],
  };
}

function tool(name: string): ToolEntry {
  return {
    capability: `${name} capability`,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["none"],
      permission: "test",
      reason: "test tool",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: {
      maxInlineBytes: 1_024,
      maxModelBytes: 1_024,
      strategy: "inline",
    },
    timeout: { allowCallOverride: false, defaultMs: 1_000 },
    cancellation: {
      cleanup: "none",
      supported: true,
      userVisibleMessage: "cancelled",
    },
    trace: {
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
      required: true,
    },
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
    },
    handler: async () => ({}),
  };
}

function mcpTool(name: string): ToolEntry {
  const entry = tool(name);
  return {
    ...entry,
    metadata: {
      ...entry.metadata,
      mcpPresentation: {
        serverName: "test-server",
        toolName: name,
      },
    },
  };
}

function skillOutcome(name: string, description: string) {
  return {
    diagnostics: [],
    skills: [
      {
        description,
        directory: `/skills/${name}`,
        frontmatterKeys: [],
        name,
        path: `/skills/${name}/SKILL.md`,
        rootPath: "/skills",
        safeToAutoLoad: false,
        scope: "project" as const,
        source: "zcode" as const,
      },
    ],
    totalDiscovered: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  return {
    promise: new Promise<T>((resolve) => {
      resolvePromise = resolve;
    }),
    resolve(value) {
      resolvePromise(value);
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 50; attempts += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for runtime state");
}
