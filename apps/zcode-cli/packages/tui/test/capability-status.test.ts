import assert from "node:assert/strict";
import test from "node:test";
import { capabilityReloadError } from "../src/app-mcp-status.js";

test("capability sidebar status only notices a completed reload error", () => {
  assert.equal(capabilityReloadError({ status: "loading" }), undefined);
  assert.equal(capabilityReloadError({ revision: "revision-a", status: "ready" }), undefined);
  assert.equal(
    capabilityReloadError({ status: "error", error: "Invalid manifest" }),
    "Invalid manifest",
  );
  assert.equal(capabilityReloadError({ status: "error" }), "");
});
