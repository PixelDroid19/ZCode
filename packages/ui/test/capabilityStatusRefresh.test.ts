import assert from "node:assert/strict";
import test from "node:test";
import { capabilityStatusRefreshSignal } from "../src/hooks/capabilityStatusRefresh.js";

const scope = {
  workspacePath: "/workspace",
  workspaceIdentity: "remote:ssh:workspace",
  remoteSessionId: "attachment-a",
  sessionId: "session-a",
};

test("catalog refresh ignores loading and foreign capability notifications", () => {
  assert.equal(
    capabilityStatusRefreshSignal(scope, {
      ...scope,
      status: { status: "loading" },
    }),
    null,
  );
  assert.equal(
    capabilityStatusRefreshSignal(scope, {
      ...scope,
      remoteSessionId: "attachment-b",
      status: { revision: "revision-a", status: "ready" },
    }),
    null,
  );
  assert.equal(
    capabilityStatusRefreshSignal(scope, {
      ...scope,
      sessionId: "session-b",
      status: { revision: "revision-a", status: "ready" },
    }),
    null,
  );
});

test("catalog refresh keys ready revisions and distinct errors to the owning session", () => {
  assert.equal(
    capabilityStatusRefreshSignal(scope, {
      ...scope,
      status: { revision: "revision-a", status: "ready" },
    }),
    "remote:ssh:workspace\u0000attachment-a\u0000session-a\u0000ready:revision-a",
  );
  assert.equal(
    capabilityStatusRefreshSignal(scope, {
      ...scope,
      status: { revision: "revision-a", status: "error", error: "Invalid manifest" },
    }),
    "remote:ssh:workspace\u0000attachment-a\u0000session-a\u0000error:revision-a:Invalid manifest",
  );
});
