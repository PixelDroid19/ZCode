import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { TurnSteerInput } from "@zcode/contracts";
import type { RuntimeTaskPendingMessage } from "../src/runtime-task/registry.js";
import { SubagentMessageNotAdmittedError } from "../src/subagent/message-channel.js";
import { createSubagentMessageSink } from "../src/subagent/message-steering.js";
import { createHarness, deferred, nextEventLoopTurn } from "./fixtures/subagent-message-harness.js";

test(
  "a send waiting on a sink resumes after a worker finishes without installing one",
  { timeout: 10_000 },
  async () => {
    const finishFirstRun = deferred<void>();
    const finishResume = deferred<void>();
    const firstStarted = deferred<void>();
    const resumedStarted = deferred<{ prompt: string; resumeFromStore?: boolean }>();
    let invocations = 0;
    const harness = await createHarness(async (request) => {
      invocations += 1;
      if (invocations === 1) {
        await request.onSessionReady?.();
        firstStarted.resolve();
        await finishFirstRun.promise;
      } else {
        resumedStarted.resolve({
          prompt: request.prompt,
          resumeFromStore: request.resumeFromStore,
        });
        await request.onSessionReady?.();
        request.registerMessageSink?.({ send: async () => "steered" });
        await finishResume.promise;
      }
      return {
        response: `run ${invocations} complete`,
        traceId: request.traceContext.traceId,
        events: [],
      };
    });
    let taskId: string | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      await firstStarted.promise;
      const pending = harness.port.sendMessage!(
        harness.messageRequest(taskId, "resume with this message"),
      );
      finishFirstRun.resolve();
      const result = await pending;
      assert.equal(result.status, "success");
      assert.equal(result.delivery, "resumed_background");
      assert.deepEqual(await resumedStarted.promise, {
        prompt: "resume with this message",
        resumeFromStore: true,
      });
      assert.equal(invocations, 2, "the terminal child should resume exactly once");
      finishResume.resolve();
      await harness.port.waitForTask!(taskId);
      await harness.port.stopTask!(taskId);
    } finally {
      finishFirstRun.resolve();
      finishResume.resolve();
      if (taskId) {
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "a second rejected old-sink send is delivered once to the resumed generation",
  { timeout: 10_000 },
  async () => {
    const finishFirstRun = deferred<void>();
    const finishResume = deferred<void>();
    const rejectFirstOldSend = deferred<void>();
    const rejectSecondOldSend = deferred<void>();
    const firstStarted = deferred<void>();
    const oldSends = deferred<RuntimeTaskPendingMessage[]>();
    const resumedStarted = deferred<{ prompt: string; resumeFromStore?: boolean }>();
    const allowResumeReady = deferred<void>();
    const newSinkReceived = deferred<RuntimeTaskPendingMessage>();
    let invocations = 0;
    const harness = await createHarness(async (request) => {
      invocations += 1;
      if (invocations === 1) {
        await request.onSessionReady?.();
        firstStarted.resolve();
        request.registerMessageSink?.({
          send: async (message) => {
            oldMessages.push(message);
            if (oldMessages.length === 2) oldSends.resolve([...oldMessages]);
            await (message.message === "first racing send"
              ? rejectFirstOldSend.promise
              : rejectSecondOldSend.promise);
            throw new SubagentMessageNotAdmittedError("old generation stopped while sending");
          },
        });
        await finishFirstRun.promise;
      } else {
        resumedStarted.resolve({
          prompt: request.prompt,
          resumeFromStore: request.resumeFromStore,
        });
        await allowResumeReady.promise;
        await request.onSessionReady?.();
        request.registerMessageSink?.({
          send: async (message) => {
            newSinkReceived.resolve(message);
            return "steered";
          },
        });
        await finishResume.promise;
      }
      return {
        response: `run ${invocations} complete`,
        traceId: request.traceContext.traceId,
        events: [],
      };
    });
    const oldMessages: RuntimeTaskPendingMessage[] = [];
    let taskId: string | undefined;
    let firstSend: Promise<unknown> | undefined;
    let secondSend: Promise<unknown> | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      await firstStarted.promise;
      firstSend = harness.port.sendMessage!(harness.messageRequest(taskId, "first racing send"));
      secondSend = harness.port.sendMessage!(harness.messageRequest(taskId, "second racing send"));
      const oldMessagesSent = await oldSends.promise;
      finishFirstRun.resolve();
      await harness.port.waitForTask!(taskId);

      rejectFirstOldSend.resolve();
      assert.deepEqual(await resumedStarted.promise, {
        prompt: "first racing send",
        resumeFromStore: true,
      });
      rejectSecondOldSend.resolve();
      await nextEventLoopTurn();
      allowResumeReady.resolve();

      const [firstResult, secondResult] = await Promise.all([firstSend, secondSend]);
      assert.equal((firstResult as { status?: string }).status, "success");
      assert.equal((secondResult as { status?: string }).status, "success");
      assert.equal((firstResult as { delivery?: string }).delivery, "resumed_background");
      assert.equal((secondResult as { delivery?: string }).delivery, "steered");
      const deliveredMessage = await newSinkReceived.promise;
      assert.equal(deliveredMessage.message, "second racing send");
      assert.equal(
        deliveredMessage.id,
        oldMessagesSent.find((message) => message.message === "second racing send")?.id,
        "retry must preserve the original pending-message ID",
      );
      assert.equal(invocations, 2, "the second send must not start another resume");
      finishResume.resolve();
      await harness.port.waitForTask!(taskId);
      await harness.port.stopTask!(taskId);
    } finally {
      finishFirstRun.resolve();
      rejectFirstOldSend.resolve();
      rejectSecondOldSend.resolve();
      allowResumeReady.resolve();
      finishResume.resolve();
      if (taskId) {
        await Promise.all([firstSend, secondSend].filter((promise) => promise !== undefined));
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);

test(
  "an ambiguous failure after admission is not replayed when the child finishes",
  { timeout: 10_000 },
  async () => {
    const finishFirstRun = deferred<void>();
    const failPublication = deferred<void>();
    const sinkAdmitted = deferred<TurnSteerInput>();
    let invocations = 0;
    const harness = await createHarness(async (request) => {
      invocations += 1;
      await request.onSessionReady?.();
      if (invocations === 1) {
        request.registerMessageSink?.(
          createSubagentMessageSink(
            {
              steerTurn: async (input) => {
                if (typeof input === "string") {
                  throw new Error("expected structured TurnSteerInput");
                }
                // 模拟消息写入成功后才发生发布失败，不能据此证明消息未准入。
                sinkAdmitted.resolve(input);
                await failPublication.promise;
                throw new Error("event publication failed after message append");
              },
            },
            { traceContext: request.traceContext },
          ),
        );
        await finishFirstRun.promise;
      }
      return {
        response: `run ${invocations} complete`,
        traceId: request.traceContext.traceId,
        events: [],
      };
    });
    let taskId: string | undefined;
    let pendingSend: Promise<{ status: string; messageId?: string; error?: string }> | undefined;
    try {
      const launched = await harness.port.start!(harness.request);
      taskId = launched.agentId;
      pendingSend = harness.port.sendMessage!(
        harness.messageRequest(taskId, "already appended before publish failure"),
      );
      const admitted = await sinkAdmitted.promise;
      assert.match(admitted.input, /already appended before publish failure/);
      finishFirstRun.resolve();
      await harness.port.waitForTask!(taskId);
      failPublication.resolve();

      const result = await pendingSend;
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /publication failed after message append/);
      assert.equal(result.messageId, admitted.inputId);
      assert.equal(
        invocations,
        1,
        "an ambiguous post-admission failure must not replay the message",
      );
    } finally {
      finishFirstRun.resolve();
      failPublication.resolve();
      if (taskId) {
        await pendingSend;
        await harness.port.waitForTask!(taskId);
        await harness.port.stopTask!(taskId);
      }
      await rm(harness.outputRootDir, { recursive: true, force: true });
    }
  },
);
