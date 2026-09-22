import assert from "node:assert/strict";
import test from "node:test";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

test("the public V4 gateway facade retains inherited command and queue operations", () => {
  const host = {
    emitWireFrame() {},
    executeCommand: async () => undefined,
    sessionExists: () => false,
  } satisfies V4GatewayHost;
  const gateway = new ConversationV4Gateway(host);

  assert.equal(typeof gateway.handleCommand, "function");
  assert.equal(typeof gateway.getQueueItem, "function");
  assert.equal(gateway.getQueueLength("missing-session"), 0);

  gateway.dispose();
});
