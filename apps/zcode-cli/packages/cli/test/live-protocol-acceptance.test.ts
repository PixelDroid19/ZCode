import assert from "node:assert/strict";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  zcodeProtocolMethods,
  zcodeSessionCloseResultSchema,
  zcodeSessionSendResultSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeSessionSubscribeResultSchema,
  zcodeSessionCapabilitiesChangedNotificationSchema,
  zcodeStorageStartupStateSchema,
} from "@zcode/shared";
import {
  LIVE_PROTOCOL_MODEL_ID,
  LIVE_PROTOCOL_PROVIDER_ID,
  LIVE_PROTOCOL_TOOL_NAME,
  createLiveProtocolFixture,
  requestText,
  requestToolNames,
} from "./live-protocol-fixture.js";

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

const MODEL_SELECTION = {
  modelId: LIVE_PROTOCOL_MODEL_ID,
  options: { reasoningLevel: "disabled" },
  providerId: LIVE_PROTOCOL_PROVIDER_ID,
};

function liveManifest(): string {
  return JSON.stringify({
    id: "acceptance.live_word_count",
    tools: [
      {
        command: { script: "./word-count.mjs" },
        description: "Count words through the live programmable-tool runtime.",
        inputSchema: INPUT_SCHEMA,
        name: LIVE_PROTOCOL_TOOL_NAME,
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

function assertLiveToolResult(request: Parameters<typeof requestText>[0], expected: object): void {
  const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
  const contents = messages.flatMap((message) => {
    if (!message || typeof message !== "object") return [];
    const content = (message as { content?: unknown }).content;
    return typeof content === "string" ? [content] : [];
  });
  assert.equal(
    contents.includes(JSON.stringify(expected)),
    true,
    "the next real provider request must carry the child tool result",
  );
}

test(
  "CLI app-server adopts, rolls back, and removes a live capability through real stdio and HTTP",
  { timeout: 60_000 },
  async () => {
    const fixture = await createLiveProtocolFixture();
    const manifestPath = join(fixture.toolRoot, "word-count.json");
    const scriptPath = join(fixture.toolRoot, "word-count.mjs");
    try {
      await fixture.client.waitForFrame("the app-server startup storage-ready frame", (frame) => {
        if (!("method" in frame.message) || frame.message.method !== "startup/storageState") {
          return false;
        }
        return zcodeStorageStartupStateSchema.parse(frame.message.params).phase === "ready";
      });
      fixture.model.setScript((request, call) => {
        const names = requestToolNames(request);
        switch (call) {
          case 1:
            assert.equal(
              names.has(LIVE_PROTOCOL_TOOL_NAME),
              false,
              "the first provider request must not invent the live tool",
            );
            assert.equal(names.has("Write"), true, "the real Write tool must be exposed");
            assert.match(
              requestText(request),
              /\.zcode\\?\/tools/u,
              "the model request must explain where programmable manifests belong",
            );
            return {
              kind: "tool_calls",
              calls: [
                {
                  arguments: { content: liveManifest(), file_path: manifestPath },
                  id: "write-live-manifest",
                  name: "Write",
                },
                {
                  arguments: { content: liveScript("v1"), file_path: scriptPath },
                  id: "write-live-script",
                  name: "Write",
                },
              ],
            };
          case 2:
            assert.equal(
              names.has(LIVE_PROTOCOL_TOOL_NAME),
              true,
              "the next provider request in the same turn must receive the new live tool",
            );
            return {
              kind: "tool_calls",
              calls: [
                {
                  arguments: { text: "one two three" },
                  id: "run-live-v1",
                  name: LIVE_PROTOCOL_TOOL_NAME,
                },
              ],
            };
          case 3:
            assertLiveToolResult(request, { count: 3, revision: "v1" });
            return { kind: "text", text: "The first live tool execution completed." };
          case 4:
            assert.equal(
              names.has(LIVE_PROTOCOL_TOOL_NAME),
              true,
              "an edited manifest must keep the adopted tool callable",
            );
            return {
              kind: "tool_calls",
              calls: [
                {
                  arguments: { text: "four five" },
                  id: "run-live-v2",
                  name: LIVE_PROTOCOL_TOOL_NAME,
                },
              ],
            };
          case 5:
            assertLiveToolResult(request, { count: 2, revision: "v2" });
            return { kind: "text", text: "The edited live tool execution completed." };
          case 6:
            assert.equal(
              names.has(LIVE_PROTOCOL_TOOL_NAME),
              true,
              "a malformed replacement must retain the last valid tool",
            );
            return {
              kind: "tool_calls",
              calls: [
                {
                  arguments: { text: "six seven" },
                  id: "run-retained-v2",
                  name: LIVE_PROTOCOL_TOOL_NAME,
                },
              ],
            };
          case 7:
            assertLiveToolResult(request, { count: 2, revision: "v2" });
            return { kind: "text", text: "The retained live tool execution completed." };
          case 8:
            assert.equal(
              names.has(LIVE_PROTOCOL_TOOL_NAME),
              false,
              "a deleted manifest must remove the live tool from the next request",
            );
            return { kind: "text", text: "The deleted live tool is absent." };
          default:
            throw new Error(`Unexpected loopback model request ${call}`);
        }
      });

      const created = await fixture.client.request(zcodeProtocolMethods.sessionCreate, {
        workspace: {
          workspaceKey: "live-protocol-workspace",
          workspacePath: fixture.workspace,
        },
        mode: "yolo",
        model: MODEL_SELECTION,
        titleGenerationEnabled: false,
      });
      const session = zcodeSessionStateSnapshotSchema.parse(created.result);
      const sessionId = session.session.sessionId;
      assert.equal(session.session.workspace.workspacePath, fixture.workspace);

      const subscribed = await fixture.client.request(zcodeProtocolMethods.sessionSubscribe, {
        deliveryKind: "desktop-continuous",
        includeSnapshot: false,
        sessionId,
      });
      assert.equal(zcodeSessionSubscribeResultSchema.parse(subscribed.result).sessionId, sessionId);

      const firstSendStart = fixture.client.frameCount;
      const firstSend = await fixture.client.request(zcodeProtocolMethods.sessionSend, {
        content: "Create and use the live word-count tool.",
        modelSelection: MODEL_SELECTION,
        sessionId,
      });
      assert.equal(zcodeSessionSendResultSchema.parse(firstSend.result).sessionId, sessionId);
      await fixture.model.waitForRequestCount(3);
      fixture.model.assertHealthy();
      const firstReady = await fixture.client.waitForCapability({
        afterFrame: firstSendStart,
        description: "the Write-created capability ready notification",
        predicate: (status) => status.status === "ready" && typeof status.revision === "string",
        sessionId,
      });
      assert.ok(
        firstReady.index > firstSend.frame.index,
        "capability notification must remain a post-response protocol sideband frame",
      );
      const firstRevision = zcodeSessionCapabilitiesChangedNotificationSchema.parse(
        (firstReady.message as { params: unknown }).params,
      ).status.revision;
      assert.ok(firstRevision);

      const editedStart = fixture.client.frameCount;
      await writeFile(scriptPath, liveScript("v2"), "utf8");
      const editedReady = await fixture.client.waitForCapability({
        afterFrame: editedStart,
        description: "the edited live script ready notification",
        predicate: (status) => status.status === "ready" && status.revision !== firstRevision,
        sessionId,
      });
      const editedRevision = zcodeSessionCapabilitiesChangedNotificationSchema.parse(
        (editedReady.message as { params: unknown }).params,
      ).status.revision;
      assert.ok(editedRevision && editedRevision !== firstRevision);

      const editedSend = await fixture.client.request(zcodeProtocolMethods.sessionSend, {
        content: "Run the edited live word-count tool.",
        modelSelection: MODEL_SELECTION,
        sessionId,
      });
      assert.equal(zcodeSessionSendResultSchema.parse(editedSend.result).sessionId, sessionId);
      await fixture.model.waitForRequestCount(5);
      fixture.model.assertHealthy();

      const invalidStart = fixture.client.frameCount;
      await writeFile(manifestPath, "{ malformed manifest", "utf8");
      const invalid = await fixture.client.waitForCapability({
        afterFrame: invalidStart,
        description: "the malformed manifest rollback notification",
        predicate: (status) => status.status === "error" && status.revision === editedRevision,
        sessionId,
      });
      const invalidStatus = zcodeSessionCapabilitiesChangedNotificationSchema.parse(
        (invalid.message as { params: unknown }).params,
      ).status;
      assert.equal(invalidStatus.revision, editedRevision);
      assert.equal(invalidStatus.status, "error");

      const retainedSend = await fixture.client.request(zcodeProtocolMethods.sessionSend, {
        content: "Run the still-valid live tool after the malformed replacement.",
        modelSelection: MODEL_SELECTION,
        sessionId,
      });
      assert.equal(zcodeSessionSendResultSchema.parse(retainedSend.result).sessionId, sessionId);
      await fixture.model.waitForRequestCount(7);
      fixture.model.assertHealthy();

      const deletedStart = fixture.client.frameCount;
      await unlink(manifestPath);
      const deletedReady = await fixture.client.waitForCapability({
        afterFrame: deletedStart,
        description: "the manifest deletion ready notification",
        predicate: (status) => status.status === "ready" && status.revision !== editedRevision,
        sessionId,
      });
      const deletedStatus = zcodeSessionCapabilitiesChangedNotificationSchema.parse(
        (deletedReady.message as { params: unknown }).params,
      ).status;
      assert.equal(deletedStatus.status, "ready");
      assert.notEqual(deletedStatus.revision, editedRevision);

      const deletedSend = await fixture.client.request(zcodeProtocolMethods.sessionSend, {
        content: "Confirm that the deleted live tool cannot be selected.",
        modelSelection: MODEL_SELECTION,
        sessionId,
      });
      assert.equal(zcodeSessionSendResultSchema.parse(deletedSend.result).sessionId, sessionId);
      await fixture.model.waitForRequestCount(8);
      fixture.model.assertHealthy();
      fixture.client.assertNoUnexpectedServerRequests();

      const closed = await fixture.client.request(zcodeProtocolMethods.sessionClose, { sessionId });
      assert.equal(zcodeSessionCloseResultSchema.parse(closed.result).closed, true);
      const exit = await fixture.client.closeInputAndWait();
      assert.equal(exit.code, 0, `CLI exited with signal ${exit.signal ?? "none"}`);
      assert.equal(exit.signal, null);
    } finally {
      await fixture.dispose();
    }
  },
);
