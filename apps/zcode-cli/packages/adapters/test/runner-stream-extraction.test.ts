import assert from "node:assert/strict";
import test from "node:test";
import type { ModelNetworkStatusEvent, ModelStreamEvent } from "@zcode/contracts";
import { runStreamText } from "../src/model/runner-stream.js";
import type { RunStreamTextInput } from "../src/model/runner-stream-types.js";
import type {
  AiSdkModelRuntime,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";

function fakeStreamResult(parts: unknown[]): AiSdkStreamTextResult {
  return {
    fullStream: (async function* () {
      yield* parts;
    })(),
    response: Promise.resolve({ headers: new Headers() }),
  } as unknown as AiSdkStreamTextResult;
}

function createResolvedModel(): ResolvedAiSdkModel {
  return {
    baseURL: "https://model.example.test",
    headers: {},
    model: {},
    modelId: "model-test",
    properties: {
      inputFormat: {
        supportsAudio: false,
        supportsImage: false,
        supportsPdf: false,
        supportsText: true,
        supportsVideo: false,
      },
      outputFormat: { supportsText: true },
      requiresMfjsToolSchema: false,
      supportsNativeWebSearch: false,
    },
    providerId: "provider-test",
    providerKind: "openai-compatible",
  } as unknown as ResolvedAiSdkModel;
}

interface EarlyStreamCloseFixture {
  closeProvider(): Promise<void>;
  input: RunStreamTextInput;
  providerClosed(): boolean;
  released(): number;
  waitForProviderClose(): Promise<void>;
}

function createEarlyStreamCloseFixture(
  preserveProviderStreamBoundaries: boolean,
): EarlyStreamCloseFixture {
  let providerHasClosed = false;
  let released = 0;
  let resolveProviderClosed!: () => void;
  const providerClosed = new Promise<void>((resolve) => {
    resolveProviderClosed = resolve;
  });
  const source = (async function* () {
    try {
      yield { type: "start" };
      yield { id: "text-1", type: "text-start" };
      yield { id: "text-1", text: "visible", type: "text-delta" };
      await new Promise<void>(() => {});
    } finally {
      providerHasClosed = true;
      resolveProviderClosed();
    }
  })();
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("The stream extraction fixture does not call generateText.");
    },
    streamText: () =>
      ({
        fullStream: source,
        response: Promise.resolve({ headers: new Headers() }),
      }) as unknown as AiSdkStreamTextResult,
  };
  const input: RunStreamTextInput = {
    env: {},
    modelIoFullRetentionEnabled: false,
    request: {
      messages: [],
      metadata: { requestId: "stream-early-return" },
      modelRequestAdmission: {
        tryAcquire() {
          return {
            publish(_status: ModelNetworkStatusEvent) {},
            release() {
              released += 1;
            },
          };
        },
        async acquire() {
          throw new Error("The stream extraction fixture does not queue admission.");
        },
      },
      preserveProviderStreamBoundaries,
    },
    resolveModel: createResolvedModel,
    resolved: createResolvedModel(),
    retry: {
      backoffFactor: 1,
      baseDelayMs: 0,
      jitter: false,
      maxAttempts: 1,
      maxDelayMs: 0,
    },
    runtime,
    streamIdleTimeoutMs: 1_000,
  };

  return {
    async closeProvider() {
      await source.return(undefined);
      await providerClosed;
    },
    input,
    providerClosed: () => providerHasClosed,
    released: () => released,
    waitForProviderClose: () => providerClosed,
  };
}

function waitForAsyncCleanupTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("stream coordinator preserves ordered visible events and terminal status", async () => {
  const statuses: ModelNetworkStatusEvent[] = [];
  const resolved = createResolvedModel();
  const runtime: AiSdkModelRuntime = {
    async generateText() {
      throw new Error("The stream extraction fixture does not call generateText.");
    },
    streamText: () =>
      fakeStreamResult([
        { type: "start" },
        { id: "text-1", type: "text-start" },
        { id: "text-1", text: "hello", type: "text-delta" },
        { id: "text-1", type: "text-end" },
        {
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
          type: "finish",
        },
      ]),
  };
  const input: RunStreamTextInput = {
    env: {},
    modelIoFullRetentionEnabled: false,
    request: {
      messages: [],
      metadata: { requestId: "stream-extraction" },
      statusSink: {
        publish(status: ModelNetworkStatusEvent) {
          statuses.push(status);
        },
      },
    },
    resolveModel: () => resolved,
    resolved,
    retry: {
      backoffFactor: 1,
      baseDelayMs: 0,
      jitter: false,
      maxAttempts: 1,
      maxDelayMs: 0,
    },
    runtime,
    streamIdleTimeoutMs: 1_000,
  };
  const events: ModelStreamEvent[] = [];

  for await (const event of runStreamText(input)) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ["start", "text_start", "text_delta", "text_end", "finish"],
  );
  assert.equal(events.find((event) => event.type === "text_delta")?.text, "hello");
  assert.deepEqual(
    statuses.map((status) => status.type),
    ["model_request_started", "model_request_completed"],
  );
});

test(
  "stream coordinator closes provider boundaries and releases admission when the consumer returns early",
  { timeout: 1_000 },
  async () => {
    const fixture = createEarlyStreamCloseFixture(true);
    const stream = runStreamText(fixture.input);
    const first = await stream.next();
    assert.equal(first.done, false);
    assert.equal(first.value.type, "start");

    await stream.return(undefined);
    await fixture.waitForProviderClose();
    assert.equal(fixture.providerClosed(), true);
    assert.equal(fixture.released(), 1);
  },
);

test(
  "stream coordinator releases admission without closing ordinary provider boundaries",
  { timeout: 1_000 },
  async () => {
    const fixture = createEarlyStreamCloseFixture(false);
    const stream = runStreamText(fixture.input);
    try {
      const first = await stream.next();
      assert.equal(first.done, false);
      assert.equal(first.value.type, "start");

      await stream.return(undefined);
      await waitForAsyncCleanupTurn();
      assert.equal(fixture.providerClosed(), false);
      assert.equal(fixture.released(), 1);
    } finally {
      await fixture.closeProvider();
    }
  },
);
