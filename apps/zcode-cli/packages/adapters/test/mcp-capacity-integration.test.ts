import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { McpServerConfig } from "@zcode/contracts";
import { createMcpAdapter, createMcpConnectionPool } from "../src/mcp/index.js";

test(
  "pooled real MCP handshakes stay bounded through early caller return, cancellation and shutdown",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-capacity-"));
    const script = join(root, "server.mjs");
    const requests: string[] = [];
    const pending = new Map<string, ServerResponse>();
    let active = 0;
    let peak = 0;
    let hold = false;
    const server = createServer((request, response) => {
      requests.push(request.url!);
      active++;
      peak = Math.max(peak, active);
      pending.set(request.url!, response);
      response.once("close", () => {
        active--;
        pending.delete(request.url!);
      });
      // Real latency in the MCP initialization/list-tools boundary, not a queue mock.
      if (!hold) setTimeout(() => response.end("ready"), 350);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    await writeFile(
      script,
      `import { createInterface } from "node:readline";
const [url, label] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "initialize") {
    await fetch(url + "/" + label + "/initialize").then(response => response.text());
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: label, version: "1" } };
  } else if (request.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: label }] };
  else if (request.method === "ping") await fetch(url + "/" + label + "/ping").then(response => response.text());
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`,
    );
    const pool = createMcpConnectionPool({
      idleGraceMs: 0,
      createAdapter: ({ connectionAdmission, connectionContext, workingDirectory }) =>
        createMcpAdapter({ connectionAdmission, connectionContext, workingDirectory }),
    });
    const first = pool.acquireLease();
    const second = pool.acquireLease();
    const config = (label: string): McpServerConfig => ({
      type: "stdio",
      command: process.execPath,
      args: [script, url, label],
      timeoutMs: 5_000,
    });
    const servers = (prefix: string) =>
      Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `${prefix}-${index}`,
          config(`${prefix}-${index}`),
        ]),
      );
    const firstServers = servers("first");
    const secondServers = servers("second");
    const waitUntil = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 8_000;
      while (!(await condition())) {
        assert.ok(Date.now() < deadline, "MCP integration condition did not settle");
        await delay(10);
      }
    };
    try {
      // A short caller wait must not release admission while the real attempt continues.
      await Promise.all([
        first.connectConfiguredServers(firstServers, { oauthAuthorizationTimeoutMs: 1 }),
        second.connectConfiguredServers(secondServers, { oauthAuthorizationTimeoutMs: 1 }),
      ]);
      await waitUntil(
        async () =>
          Object.values({ ...(await first.status()), ...(await second.status()) }).filter(
            (status) => status.status === "connected",
          ).length === 16,
      );
      assert.equal(requests.filter((value) => value.endsWith("/initialize")).length, 16);
      assert.ok(peak <= 8, `shared pool started ${peak} overlapping handshakes`);
      assert.match(
        JSON.stringify(await second.callTool({ serverName: "second-7", toolName: "echo" })),
        /second-7/,
      );

      // Revalidation still uses each live connection and must not create a second process.
      const initializations = requests.filter((value) => value.endsWith("/initialize")).length;
      await first.connectConfiguredServers(firstServers, { revalidate: true });
      assert.equal(
        requests.filter((value) => value.endsWith("/initialize")).length,
        initializations,
      );

      hold = true;
      const retiringRetry = first.connectServer("first-0", firstServers["first-0"], {
        revalidate: true,
      });
      const retiredResult = assert.rejects(retiringRetry, /closed|leased|changed/);
      await waitUntil(() => pending.has("/first-0/ping"));
      await first.disconnectServer("first-0");
      await retiredResult;
      await waitUntil(() => active === 0);
      assert.equal(
        requests.filter((value) => value === "/first-0/initialize").length,
        1,
        "retired entry must not reconnect after its pending ping fails",
      );
      const blocked = pool.acquireLease();
      const blockedResult = blocked.connectConfiguredServers(servers("blocked"));
      await waitUntil(() => active === 8);
      const queued = pool.acquireLease();
      const abort = new AbortController();
      const canceledResult = queued.connectServer("canceled", config("canceled"), {
        signal: abort.signal,
      });
      abort.abort(new Error("integration cancellation"));
      await Promise.allSettled([canceledResult]);
      const admittedAfterCancel = queued.connectServer("after-cancel", config("after-cancel"));
      pending.values().next().value!.end("ready");
      await waitUntil(() => pending.has("/after-cancel/initialize"));
      pending.get("/after-cancel/initialize")!.end("ready");
      assert.equal((await admittedAfterCancel).status, "connected");
      assert.ok(!requests.includes("/canceled/initialize"), "aborted queued work must not start");

      const refillResult = blocked.connectServer("refill", config("refill"));
      await waitUntil(() => active === 8);
      const closing = pool.acquireLease();
      const closingResult = closing.connectServer("closing", config("closing"));
      const outcomes = Promise.allSettled([blockedResult, closingResult, refillResult]);
      await pool.close();
      await outcomes;
      await waitUntil(() => active === 0);
      assert.equal(pool.stats().activeConnections, 0);
      assert.ok(
        !requests.includes("/closing/initialize"),
        "pool shutdown must not admit queued work",
      );
      await assert.rejects(first.connectServer("after-close", config("after-close")), /closed/);
    } finally {
      for (const response of pending.values()) response.destroy();
      await pool.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
);
