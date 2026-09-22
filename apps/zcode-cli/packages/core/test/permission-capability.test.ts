import assert from "node:assert/strict";
import test from "node:test";
import { PermissionService } from "../src/permission/service.js";

test("a partial read-only third-party capability keeps the unknown-tool approval fallback", () => {
  const decision = new PermissionService().checkPermission(
    {
      input: {},
      mode: "build",
      riskLevel: "low",
      toolName: "third_party_observer",
    },
    {
      readOnly: true,
      riskLevel: "low",
    },
  );

  assert.equal(decision.decision, "ask");
  assert.equal(decision.sideEffectScope, "workspace");
});
