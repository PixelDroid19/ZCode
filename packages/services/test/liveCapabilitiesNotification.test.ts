import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "@zcode/shared";

test("capability notifications expose a strict session status contract", () => {
  assert.equal(
    (shared.zcodeProtocolNotifications as Record<string, unknown>).sessionCapabilitiesChanged,
    "session/capabilities_changed",
  );

  const schema = (shared as Record<string, unknown>)
    .zcodeSessionCapabilitiesChangedNotificationSchema as
    | { parse(input: unknown): unknown }
    | undefined;
  assert.ok(schema, "the protocol must validate session capability notifications");
  assert.deepEqual(
    schema.parse({
      sessionId: "session-a",
      status: { revision: "revision-a", status: "ready" },
    }),
    {
      sessionId: "session-a",
      status: { revision: "revision-a", status: "ready" },
    },
  );
  assert.throws(() =>
    schema.parse({
      sessionId: "session-a",
      status: { revision: "revision-a", status: "ready", unexpected: true },
    }),
  );
});

test("capability notifications stay within their workspace and remote attachment", async () => {
  const routerModule = (await import("../src/zcode-agent/capabilitiesChangedRouter.js")) as Record<
    string,
    unknown
  >;
  const createRouter = routerModule.createCapabilitiesChangedRouter as
    | (() => {
        emit(
          workspace: {
            workspacePath: string;
            workspaceIdentity?: string;
            remoteSessionId?: string;
          },
          notification: {
            sessionId: string;
            status: { revision?: string; status: "ready" | "loading" | "error"; error?: string };
          },
        ): void;
        on(workspace: {
          workspacePath: string;
          workspaceIdentity?: string;
          remoteSessionId?: string;
        }): (listener: (event: unknown) => void) => { dispose(): void };
        dispose(): void;
      })
    | undefined;
  assert.ok(createRouter, "services must expose a scoped capability notification router");

  const router = createRouter();
  const local: unknown[] = [];
  const remote: unknown[] = [];
  const localSubscription = router.on({
    workspacePath: "/workspace",
    workspaceIdentity: "remote:ssh:workspace",
  })((event) => local.push(event));
  const remoteSubscription = router.on({
    workspacePath: "/workspace",
    workspaceIdentity: "remote:ssh:workspace",
    remoteSessionId: "attachment-b",
  })((event) => remote.push(event));

  try {
    router.emit(
      {
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:workspace",
        remoteSessionId: "attachment-b",
      },
      { sessionId: "session-b", status: { revision: "revision-b", status: "ready" } },
    );

    assert.deepEqual(local, []);
    assert.deepEqual(remote, [
      {
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:workspace",
        remoteSessionId: "attachment-b",
        sessionId: "session-b",
        status: { revision: "revision-b", status: "ready" },
      },
    ]);
  } finally {
    localSubscription.dispose();
    remoteSubscription.dispose();
    router.dispose();
  }
});
