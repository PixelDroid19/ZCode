import assert from "node:assert/strict";
import test from "node:test";
import { createLiveCapabilitySource } from "../src/app/live-capability-source.js";

const traceContext = { traceId: "test-trace", spanId: "test-span" } as any;
const environment = (revision: string, server = "one") => ({
  revision,
  tools: [],
  skills: { skills: [], diagnostics: [], totalDiscovered: 0 },
  pluginReferenceCatalog: { plugins: [] },
  mcp: { enabled: true, servers: { example: { type: "stdio", command: server } } },
});

function port(fail = false) {
  let closed = 0;
  return {
    get closed() {
      return closed;
    },
    async connectConfiguredServers() {
      return { statuses: { example: { status: fail ? "failed" : "connected" } }, tools: [] };
    },
    async status() {
      return {};
    },
    async listTools() {
      return [];
    },
    async close() {
      closed++;
    },
  } as any;
}

test("unchanged revisions avoid reconnects; replaced MCP stays alive until release", async () => {
  let current = environment("a");
  const ports: any[] = [];
  const source = createLiveCapabilitySource({
    workingDirectory: "/workspace",
    load: async () => current as any,
    createMcpPort: () => {
      const next = port();
      ports.push(next);
      return next;
    },
  });
  const first = (await source.prepare({ traceContext }))!;
  first.commit?.();
  assert.equal(await source.prepare({ revision: "a", traceContext }), undefined);
  assert.equal(ports.length, 1);
  current = environment("b", "two");
  const second = (await source.prepare({ revision: "a", traceContext }))!;
  second.commit?.();
  assert.equal(ports[0].closed, 0);
  await first.release?.();
  assert.equal(ports[0].closed, 1);
  await second.release?.();
  await source.dispose?.();
  assert.equal(ports[1].closed, 1);
});

test("failed MCP replacement leaves published resources intact", async () => {
  let current = environment("a");
  const ports: any[] = [];
  const source = createLiveCapabilitySource({
    workingDirectory: "/workspace",
    load: async () => current as any,
    createMcpPort: () => {
      const next = port(ports.length > 0);
      ports.push(next);
      return next;
    },
  });
  const first = (await source.prepare({ traceContext }))!;
  first.commit?.();
  current = environment("b", "broken");
  await assert.rejects(source.prepare({ revision: "a", traceContext }), /MCP/);
  assert.equal(ports[0].closed, 0);
  assert.equal(ports[1].closed, 1);
  await first.release?.();
  await source.dispose?.();
});

test("skill-only changes reuse a connection with independently releasable ownership", async () => {
  let current = environment("a");
  const onlyPort = port();
  let creates = 0;
  const source = createLiveCapabilitySource({
    workingDirectory: "/workspace",
    load: async () => current as any,
    createMcpPort: () => {
      creates++;
      return onlyPort;
    },
  });
  const first = (await source.prepare({ traceContext }))!;
  first.commit?.();
  current = environment("b");
  const second = (await source.prepare({ revision: "a", traceContext }))!;
  second.commit?.();
  await first.release?.();
  assert.equal(creates, 1);
  assert.equal(onlyPort.closed, 0);
  await second.release?.();
  await source.dispose?.();
  assert.equal(onlyPort.closed, 1);
});

test("an MCP edit during handshake rejects and closes only the staged generation", async () => {
  let changedDuringConnect = false;
  let current: any = environment("one");
  const ports: any[] = [];
  const source = createLiveCapabilitySource({
    workingDirectory: "/workspace",
    load: async () => current,
    createMcpPort: () => {
      const next = port();
      const connect = next.connectConfiguredServers;
      next.connectConfiguredServers = async () => {
        if (ports.length > 1) changedDuringConnect = true;
        return connect();
      };
      ports.push(next);
      return next;
    },
  });
  const first = (await source.prepare({ traceContext }))!;
  first.commit?.();
  current = {
    ...environment("two", "two"),
    async verifyMcpContentRevision() {
      if (changedDuringConnect) throw new Error("MCP source changed");
    },
  };
  await assert.rejects(source.prepare({ revision: "one", traceContext }), /MCP source changed/);
  assert.equal(ports[0].closed, 0);
  assert.equal(ports[1].closed, 1);
  await first.release?.();
  await source.dispose?.();
});
