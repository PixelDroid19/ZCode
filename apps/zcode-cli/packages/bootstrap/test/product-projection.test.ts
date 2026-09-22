import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

// 实际 createZCodeApp 的 Write/Read 两轮事件；fixture 已移除 provider prompt 和临时机器路径。
// golden 来自拆分前的 25684f5 reducer，防止用新实现自身生成预期而掩盖回归。
const events: SessionEvent[] = JSON.parse(
  await readFile(new URL("./fixtures/projection-events.json", import.meta.url), "utf8"),
).map((event: SessionEvent) => ({ ...event, timestamp: new Date(event.timestamp) }));
const golden = JSON.parse(
  await readFile(new URL("./fixtures/projection-golden.json", import.meta.url), "utf8"),
);

function projection() {
  const result = new ProductProjection("fixture-session", "fixture-epoch");
  result.seedUsage({
    contextWindow: { maxTokens: 128_000, usedTokens: 0, autoCompactThresholdTokens: null },
  });
  return result;
}

function wireValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("real tool event replay preserves the pre-refactor deltas and final snapshot", () => {
  const current = projection();
  const deltas = events.map((event) => current.applyEvent(event));
  assert.deepEqual(wireValue(deltas), golden.deltas);
  assert.deepEqual(wireValue(current.getSnapshot()), golden.snapshot);
});

test("rejected atomic candidates leave the owner unchanged and later acceptance still works", () => {
  const current = projection();
  const deltas = events.map((event) => {
    const before = structuredClone(current.getSnapshot());
    assert.equal(
      current.applyEventAtomically(event, () => false),
      null,
    );
    assert.deepEqual(current.getSnapshot(), before, event.type);
    return current.applyEventAtomically(event, () => true);
  });
  assert.deepEqual(wireValue(deltas), golden.deltas);
  assert.deepEqual(wireValue(current.getSnapshot()), golden.snapshot);
});

test("hydration uses the same owner and restores the live conversation snapshot", () => {
  const current = projection();
  current.beginHydrationReplay();
  for (const event of events) current.applyHydrationEvent(event);
  current.completeHydrationReplay();
  assert.deepEqual(wireValue(current.getSnapshot()), golden.snapshot);
});
