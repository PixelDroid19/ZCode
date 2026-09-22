import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";

const AGENT_ID = "agent_terminal_race";
const STOPPED_OUTPUT = "Background agent task stopped.\n";
const COMPLETION_OUTPUT = "completed child result";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextEventLoopTurn(): Promise<void> {
  // Flush promise continuations after a controlled worker boundary without using a time delay.
  return new Promise((resolve) => setImmediate(resolve));
}

interface WriteGate {
  entered: Promise<void>;
  release(): void;
  restore(): void;
  writes: Array<{ file: string; content: string }>;
}

function gateOutputWrite(outputFile: string, content: string): WriteGate {
  const entered = deferred<void>();
  const release = deferred<void>();
  const originalWriteFile = fs.writeFile.bind(fs);
  const writes: Array<{ file: string; content: string }> = [];
  let blocked = false;

  fs.writeFile = async (file, data, ...args) => {
    const filePath = String(file);
    const text = typeof data === "string" ? data : "";
    if (filePath === outputFile) writes.push({ file: filePath, content: text });
    if (!blocked && filePath === outputFile && text === content) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
    return originalWriteFile(file, data, ...args);
  };
  syncBuiltinESMExports();

  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => {
      release.resolve();
      fs.writeFile = originalWriteFile;
      syncBuiltinESMExports();
    },
    writes,
  };
}

async function createHarness(
  runExploreAgent: Parameters<typeof createExploreSubagentPort>[0]["runExploreAgent"],
) {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-terminal-"));
  const registry = new InMemoryRuntimeTaskRegistry();
  const notifications: Array<{ taskId: string; text: string }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const profile = {
    name: "probe-agent",
    description: "terminal coordination integration",
    source: "project" as const,
    systemPrompt: "",
    tools: ["Read"],
  };
  const port = createExploreSubagentPort({
    runtimeTaskRegistry: registry,
    createAgentId: () => AGENT_ID,
    outputRootDir,
    profiles: [profile],
    runExploreAgent,
    emitParentEvent: async (event) => {
      events.push({ type: event.type, payload: event.payload as Record<string, unknown> });
    },
    enqueueParentTaskNotification: (notification) => {
      notifications.push({ taskId: notification.taskId, text: notification.text });
      return undefined;
    },
  });
  const request = {
    sessionId: "parent_session_terminal_race" as never,
    parentToolCallId: "parent_tool_terminal_race",
    agentType: profile.name,
    description: "terminal race",
    prompt: "return a short result",
    workingDirectory: process.cwd(),
    workspaceRoot: process.cwd(),
    trace: {
      traceId: "trace_terminal_race" as never,
      spanId: "span_parent_terminal_race" as never,
      sessionId: "parent_session_terminal_race" as never,
    },
  };
  return { events, notifications, outputRootDir, port, registry, request };
}

async function assertTerminalProjection(
  harness: Awaited<ReturnType<typeof createHarness>>,
  taskId: string,
  expected: "completed" | "killed",
  output: string,
  notificationCount = 1,
): Promise<void> {
  const task = harness.registry.get(taskId);
  assert.equal(task?.status, expected);
  assert.equal(await readFile(task!.outputFile!, "utf8"), output);
  const metadata = JSON.parse(
    await readFile(join(dirname(task!.outputFile!), "metadata.json"), "utf8"),
  ) as {
    status: string;
  };
  assert.equal(metadata.status, expected === "completed" ? "completed" : "stopped");

  const terminalEvents = harness.events.filter(
    (event) => event.type === "background_task_completed" || event.type === "subagent_stopped",
  );
  const notificationStatuses = Array.from({ length: notificationCount }, (_, index) =>
    expected === "killed" || (expected === "completed" && notificationCount > 1 && index === 0)
      ? "stopped"
      : expected,
  );
  const expectedEventStatuses = notificationStatuses.flatMap((status) =>
    status === "completed" ? ["completed", "completed"] : ["cancelled", "stopped"],
  );
  assert.deepEqual(
    terminalEvents.map((event) => event.payload.status),
    expectedEventStatuses,
  );
  assert.equal(harness.notifications.length, notificationCount);
  const actualNotificationStatuses = harness.notifications.map(
    (item) => item.text.match(/<status>([^<]+)<\/status>/)?.[1],
  );
  assert.deepEqual(actualNotificationStatuses, notificationStatuses);
}

test(
  "a completion already writing artifacts owns a concurrent stop",
  { timeout: 10_000 },
  async () => {
    const finishWorker = deferred<void>();
    const harness = await createHarness(async (request) => {
      await request.onSessionReady?.();
      await finishWorker.promise;
      return { response: COMPLETION_OUTPUT, traceId: request.traceContext.traceId, events: [] };
    });
    let gate: WriteGate | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      gate = gateOutputWrite(launched.outputFile, COMPLETION_OUTPUT);
      finishWorker.resolve();
      await gate.entered;

      const stopPromise = harness.port.stopTask!(launched.agentId);
      await nextEventLoopTurn();
      gate.release();
      const stopped = await stopPromise;
      assert.equal(stopped?.status, "completed");
      await harness.port.waitForTask!(launched.agentId);
      await assertTerminalProjection(harness, launched.agentId, "completed", COMPLETION_OUTPUT);
    } finally {
      gate?.restore();
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

for (const outcome of ["completion", "failure"] as const) {
  test(`a stop admitted first fences late ${outcome}`, { timeout: 10_000 }, async () => {
    const finishWorker = deferred<void>();
    const workerReturned = deferred<void>();
    const output = outcome === "completion" ? COMPLETION_OUTPUT : "late child failure";
    const harness = await createHarness(async (request) => {
      await request.onSessionReady?.();
      await finishWorker.promise;
      workerReturned.resolve();
      if (outcome === "failure") throw new Error(output);
      return { response: output, traceId: request.traceContext.traceId, events: [] };
    });
    let stopGate: WriteGate | undefined;
    let completionGate: WriteGate | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      stopGate = gateOutputWrite(launched.outputFile, STOPPED_OUTPUT);
      const stopPromise = harness.port.stopTask!(launched.agentId);
      await stopGate.entered;

      completionGate = gateOutputWrite(launched.outputFile, output);
      finishWorker.resolve();
      await workerReturned.promise;
      await nextEventLoopTurn();
      assert.equal(
        completionGate.writes.length,
        0,
        "a later worker result must not enter artifact writing while stop owns the transition",
      );

      stopGate.release();
      const stopped = await stopPromise;
      assert.equal(stopped?.status, "killed");
      await harness.port.waitForTask!(launched.agentId);
      await nextEventLoopTurn();
      await assertTerminalProjection(harness, launched.agentId, "killed", STOPPED_OUTPUT);
    } finally {
      finishWorker.resolve();
      completionGate?.restore();
      stopGate?.restore();
      await nextEventLoopTurn();
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  });
}

test("concurrent stop callers share one terminal publication", { timeout: 10_000 }, async () => {
  const finishWorker = deferred<void>();
  const harness = await createHarness(async (request) => {
    await request.onSessionReady?.();
    await finishWorker.promise;
    return { response: COMPLETION_OUTPUT, traceId: request.traceContext.traceId, events: [] };
  });
  let gate: WriteGate | undefined;
  try {
    const launched = await harness.port.start!(harness.request);
    gate = gateOutputWrite(launched.outputFile, STOPPED_OUTPUT);
    const firstStop = harness.port.stopTask!(launched.agentId);
    await gate.entered;
    const secondStop = harness.port.stopTask!(launched.agentId);
    gate.release();

    const [first, second] = await Promise.all([firstStop, secondStop]);
    assert.equal(first?.status, "killed");
    assert.equal(second?.status, "killed");
    await assertTerminalProjection(harness, launched.agentId, "killed", STOPPED_OUTPUT);
  } finally {
    finishWorker.resolve();
    gate?.restore();
    await nextEventLoopTurn();
    await rm(harness.outputRootDir, { recursive: true, force: true });
  }
});

test(
  "a late old completion cannot overwrite a resumed generation",
  { timeout: 10_000 },
  async () => {
    const oldWorker = deferred<void>();
    const resumedWorker = deferred<void>();
    const oldWorkerReturned = deferred<void>();
    let invocation = 0;
    const harness = await createHarness(async (request) => {
      invocation += 1;
      await request.onSessionReady?.();
      if (invocation === 1) {
        await oldWorker.promise;
        oldWorkerReturned.resolve();
        return { response: "stale old result", traceId: request.traceContext.traceId, events: [] };
      }
      await resumedWorker.promise;
      return {
        response: "resumed generation result",
        traceId: request.traceContext.traceId,
        events: [],
      };
    });
    try {
      const launched = await harness.port.start!(harness.request);
      const stopped = await harness.port.stopTask!(launched.agentId);
      assert.equal(stopped?.status, "killed");

      const resumed = await harness.port.sendMessage!({
        sessionId: harness.request.sessionId,
        parentToolCallId: "resume_parent_tool",
        to: launched.agentId,
        summary: "resume the child",
        message: "continue with the new request",
        workingDirectory: harness.request.workingDirectory,
        workspaceRoot: harness.request.workspaceRoot,
        trace: harness.request.trace,
      });
      assert.equal(resumed.delivery, "resumed_background");
      assert.equal(invocation, 2);
      const outputBeforeLateCompletion = await readFile(launched.outputFile, "utf8");
      const metadataPath = join(dirname(launched.outputFile), "metadata.json");
      const metadataBeforeLateCompletion = await readFile(metadataPath, "utf8");

      oldWorker.resolve();
      await oldWorkerReturned.promise;
      await nextEventLoopTurn();
      assert.equal(harness.registry.get(launched.agentId)?.status, "running");
      assert.equal(await readFile(launched.outputFile, "utf8"), outputBeforeLateCompletion);
      assert.equal(await readFile(metadataPath, "utf8"), metadataBeforeLateCompletion);
      assert.equal(harness.notifications.length, 1);
      assert.deepEqual(
        harness.events
          .filter(
            (event) =>
              event.type === "background_task_completed" || event.type === "subagent_stopped",
          )
          .map((event) => event.payload.status),
        ["cancelled", "stopped"],
      );

      resumedWorker.resolve();
      await harness.port.waitForTask!(launched.agentId);
      const final = await harness.port.stopTask!(launched.agentId);
      assert.equal(final?.status, "completed");
      await assertTerminalProjection(
        harness,
        launched.agentId,
        "completed",
        "resumed generation result",
        2,
      );
    } finally {
      oldWorker.resolve();
      resumedWorker.resolve();
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);
