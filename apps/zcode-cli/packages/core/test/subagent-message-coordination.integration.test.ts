import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import type { SubagentSendMessageResult, TurnSteerInput } from "@zcode/contracts";
import { SubagentMessageNotAdmittedError } from "../src/subagent/message-channel.js";
import { createSubagentMessageSink } from "../src/subagent/message-steering.js";

import {
  CHILD_MESSAGE,
  createHarness,
  deferred,
  nextEventLoopTurn,
} from "./fixtures/subagent-message-harness.js";
type SendOutcome = { result: SubagentSendMessageResult } | { error: unknown };

function captureSendResult(promise: Promise<SubagentSendMessageResult>): Promise<SendOutcome> {
  return promise.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
}

test("message admission waits for a child sink during startup", { timeout: 10_000 }, async () => {
  const installSink = deferred<void>();
  const finishWorker = deferred<void>();
  const sinkReceived = deferred<string>();
  const harness = await createHarness(async (request) => {
    await request.onSessionReady?.();
    await installSink.promise;
    request.registerMessageSink?.({
      send: async (message) => {
        sinkReceived.resolve(message.message);
        return "steered";
      },
    });
    await finishWorker.promise;
    return {
      response: "startup message accepted",
      traceId: request.traceContext.traceId,
      events: [],
    };
  });
  let sendResult: Promise<SendOutcome> | undefined;
  let taskId: string | undefined;
  try {
    const launched = await harness.port.start!(harness.request);
    taskId = launched.agentId;
    sendResult = captureSendResult(
      harness.port.sendMessage!(harness.messageRequest(launched.agentId)),
    );
    let settled = false;
    void sendResult.then(() => {
      settled = true;
    });
    await nextEventLoopTurn();
    assert.equal(settled, false, "a queued response is not admission while startup has no sink");

    installSink.resolve();
    assert.equal(await sinkReceived.promise, CHILD_MESSAGE);
    const outcome = await sendResult;
    assert.ok("result" in outcome, "sink admission should return a delivery result");
    if ("result" in outcome) {
      assert.equal(outcome.result.status, "success");
      assert.equal(outcome.result.delivery, "steered");
    }
    assert.deepEqual(harness.registry.get(launched.agentId)?.pendingMessages ?? [], []);

    finishWorker.resolve();
    await harness.port.waitForTask!(launched.agentId);
    await harness.port.stopTask!(launched.agentId);
  } finally {
    installSink.resolve();
    finishWorker.resolve();
    await sendResult;
    if (taskId) {
      await harness.port.waitForTask!(taskId);
      await harness.port.stopTask!(taskId);
    }
    await rm(harness.outputRootDir, { recursive: true, force: true });
  }
});

test(
  "a startup message can be cancelled while waiting for the child sink",
  { timeout: 10_000 },
  async () => {
    const installSink = deferred<void>();
    const finishWorker = deferred<void>();
    let receivedCount = 0;
    const harness = await createHarness(async (request) => {
      await request.onSessionReady?.();
      await installSink.promise;
      request.registerMessageSink?.({
        send: async () => {
          receivedCount += 1;
          return "steered";
        },
      });
      await finishWorker.promise;
      return { response: "startup continued", traceId: request.traceContext.traceId, events: [] };
    });
    let taskId: string | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      const controller = new AbortController();
      const pending = harness.port.sendMessage!(harness.messageRequest(launched.agentId), {
        signal: controller.signal,
      });
      await nextEventLoopTurn();
      controller.abort(new Error("caller cancelled startup message"));
      const response = await pending;
      assert.equal(response.status, "failed");
      assert.match(response.error ?? "", /abort|cancel/i);
      assert.deepEqual(harness.registry.get(launched.agentId)?.pendingMessages ?? [], []);

      installSink.resolve();
      await nextEventLoopTurn();
      assert.equal(receivedCount, 0, "a cancelled startup message must not be delivered later");
      finishWorker.resolve();
      await harness.port.waitForTask!(launched.agentId);
      await harness.port.stopTask!(launched.agentId);
    } finally {
      installSink.resolve();
      finishWorker.resolve();
      if (taskId) {
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "a rejected sink resumes a child that completed during delivery",
  { timeout: 10_000 },
  async () => {
    const finishFirstRun = deferred<void>();
    const rejectSink = deferred<void>();
    const sinkEntered = deferred<void>();
    const sinkInstalled = deferred<void>();
    const sinkInput = deferred<TurnSteerInput>();
    const resumedRequest = deferred<{
      agentId: string;
      prompt: string;
      sessionId: string;
      resumed: boolean;
    }>();
    let invocation = 0;
    const harness = await createHarness(async (request) => {
      invocation += 1;
      if (invocation === 1) {
        await request.onSessionReady?.();
        request.registerMessageSink?.(
          createSubagentMessageSink(
            {
              steerTurn: async (input) => {
                if (typeof input === "string") {
                  throw new Error("expected structured TurnSteerInput");
                }
                sinkInput.resolve(input);
                sinkEntered.resolve();
                await rejectSink.promise;
                return { kind: "rejected", reason: "no_active_turn" };
              },
            },
            { traceContext: request.traceContext },
          ),
        );
        sinkInstalled.resolve();
        await finishFirstRun.promise;
        return {
          response: "first run completed",
          traceId: request.traceContext.traceId,
          events: [],
        };
      }

      resumedRequest.resolve({
        agentId: request.agentId,
        prompt: request.prompt,
        sessionId: request.sessionId,
        resumed: request.resumeFromStore === true,
      });
      await request.onSessionReady?.();
      return { response: "resumed result", traceId: request.traceContext.traceId, events: [] };
    });
    let sendResult: Promise<SendOutcome> | undefined;
    let taskId: string | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      const originalChildSessionId = harness.registry.get(launched.agentId)?.childSessionId;
      await sinkInstalled.promise;
      sendResult = captureSendResult(
        harness.port.sendMessage!(harness.messageRequest(launched.agentId)),
      );
      await sinkEntered.promise;
      finishFirstRun.resolve();
      await harness.port.waitForTask!(launched.agentId);
      await harness.port.stopTask!(launched.agentId);

      rejectSink.resolve();
      const outcome = await sendResult;
      assert.ok(
        "result" in outcome,
        "a completed child should resume instead of failing or queueing",
      );
      if ("result" in outcome) {
        assert.equal(outcome.result.status, "success");
        assert.equal(outcome.result.delivery, "resumed_background");
        const steered = await sinkInput.promise;
        assert.equal(steered.inputId, outcome.result.messageId);
        assert.match(steered.input, /inspect the latest change and report back/);
      }
      const resumed = await resumedRequest.promise;
      assert.deepEqual(resumed, {
        agentId: launched.agentId,
        prompt: CHILD_MESSAGE,
        sessionId: String(originalChildSessionId),
        resumed: true,
      });
      await harness.port.waitForTask!(launched.agentId);
      await harness.port.stopTask!(launched.agentId);
      assert.equal(harness.registry.get(launched.agentId)?.status, "completed");
      assert.equal(await readFile(launched.outputFile, "utf8"), "resumed result");
      const metadata = JSON.parse(
        await readFile(join(dirname(launched.outputFile), "metadata.json"), "utf8"),
      ) as { status: string };
      assert.equal(metadata.status, "completed");
      assert.deepEqual(
        harness.notifications.map((text) => text.match(/<status>([^<]+)<\/status>/)?.[1]),
        ["completed", "completed"],
      );
    } finally {
      finishFirstRun.resolve();
      rejectSink.resolve();
      await sendResult;
      if (taskId) {
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "a rejected sink on a still-active child fails instead of claiming it queued",
  { timeout: 10_000 },
  async () => {
    const finishWorker = deferred<void>();
    const sinkEntered = deferred<void>();
    const sinkInstalled = deferred<void>();
    const harness = await createHarness(async (request) => {
      await request.onSessionReady?.();
      request.registerMessageSink?.({
        send: async () => {
          sinkEntered.resolve();
          throw new SubagentMessageNotAdmittedError("no_active_turn");
        },
      });
      sinkInstalled.resolve();
      await finishWorker.promise;
      return {
        response: "active child completed later",
        traceId: request.traceContext.traceId,
        events: [],
      };
    });
    let taskId: string | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      await sinkInstalled.promise;
      const result = harness.port.sendMessage!(harness.messageRequest(launched.agentId));
      await sinkEntered.promise;
      const response = await result;
      assert.equal(response.status, "failed");
      assert.match(response.error ?? "", /no_active_turn|active turn/i);
      assert.equal(harness.registry.get(launched.agentId)?.status, "running");
      assert.deepEqual(harness.registry.get(launched.agentId)?.pendingMessages ?? [], []);

      finishWorker.resolve();
      await harness.port.waitForTask!(launched.agentId);
      await harness.port.stopTask!(launched.agentId);
    } finally {
      finishWorker.resolve();
      if (taskId) {
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "a late sink rejection cannot undo stop; a new send can explicitly resume",
  { timeout: 10_000 },
  async () => {
    const rejectSink = deferred<void>();
    const sinkEntered = deferred<void>();
    const sinkInstalled = deferred<void>();
    const workerAborted = deferred<void>();
    const resumedStart = deferred<{ agentId: string; childSessionId: string; prompt: string }>();
    let invocation = 0;
    const harness = await createHarness(async (request, options) => {
      invocation += 1;
      if (invocation > 1) {
        resumedStart.resolve({
          agentId: request.agentId,
          childSessionId: request.sessionId,
          prompt: request.prompt,
        });
        await request.onSessionReady?.();
        return {
          response: "explicit resumed result",
          traceId: request.traceContext.traceId,
          events: [],
        };
      }

      const signal = options?.signal;
      if (!signal) throw new Error("background worker did not receive an abort signal");
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectOnAbort = () => {
          workerAborted.resolve();
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
      await request.onSessionReady?.();
      request.registerMessageSink?.({
        send: async () => {
          sinkEntered.resolve();
          await rejectSink.promise;
          throw new SubagentMessageNotAdmittedError("no_active_turn");
        },
      });
      sinkInstalled.resolve();
      await aborted;
      throw new Error("unreachable after stop abort");
    });
    let taskId: string | undefined;
    let pendingSend: Promise<SendOutcome> | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      const childSessionId = harness.registry.get(taskId)?.childSessionId;
      await sinkInstalled.promise;
      pendingSend = captureSendResult(
        harness.port.sendMessage!(harness.messageRequest(taskId, "message before stop")),
      );
      await sinkEntered.promise;

      assert.equal((await harness.port.stopTask!(taskId))?.status, "killed");
      await workerAborted.promise;
      rejectSink.resolve();
      const rejected = await pendingSend;
      assert.ok("result" in rejected);
      if ("result" in rejected) assert.equal(rejected.result.status, "failed");
      await nextEventLoopTurn();
      assert.equal(harness.registry.get(taskId)?.status, "killed");
      assert.deepEqual(harness.registry.get(taskId)?.pendingMessages ?? [], []);
      assert.equal(invocation, 1, "a rejected pre-stop send cannot automatically start a new run");

      const explicit = await harness.port.sendMessage!(
        harness.messageRequest(taskId, "explicitly resume after stop"),
      );
      assert.equal(explicit.delivery, "resumed_background");
      assert.equal(invocation, 2);
      assert.deepEqual(await resumedStart.promise, {
        agentId: taskId,
        childSessionId: String(childSessionId),
        prompt: "explicitly resume after stop",
      });
      await harness.port.waitForTask!(taskId);
      await harness.port.stopTask!(taskId);
      assert.equal(harness.registry.get(taskId)?.status, "completed");
      assert.equal(await readFile(launched.outputFile, "utf8"), "explicit resumed result");
      const statuses = harness.notifications.map(
        (text) => text.match(/<status>([^<]+)<\/status>/)?.[1],
      );
      assert.deepEqual(statuses, ["stopped", "completed"]);
    } finally {
      rejectSink.resolve();
      if (taskId) {
        await harness.port.stopTask!(taskId);
        await harness.port.waitForTask!(taskId);
      }
      await pendingSend;
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);
