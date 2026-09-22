import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMcpAdapterConnectionPool } from "@zcode/adapters/mcp";
import {
  createLiveCapabilitySource,
  type LoadedCapabilityEnvironment,
} from "../src/app/live-capability-source.js";
import { createSessionFacade } from "../src/app/session-facade.js";

test(
  "real pooled MCP processes reload changed script content while the prior generation remains callable",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-live-mcp-"));
    const script = join(root, "server.mjs");
    const pool = createMcpAdapterConnectionPool();
    const traceContext = { traceId: "live-mcp-test" } as never;
    let environment: LoadedCapabilityEnvironment = {
      revision: "one",
      mcpContentRevision: "script-one",
      tools: [],
      skills: { skills: [], diagnostics: [], totalDiscovered: 0 },
      pluginReferenceCatalog: { plugins: [] },
      mcp: {
        enabled: true,
        servers: {
          example: {
            type: "stdio",
            command: process.execPath,
            args: [script],
            isolation: "workspace",
            timeoutMs: 2_000,
          },
        },
      },
    };
    const source = createLiveCapabilitySource({
      workingDirectory: root,
      workspaceIdentity: "mcp-reload-workspace",
      load: async () => environment,
      createMcpPort: () => pool.acquireLease(),
    });
    try {
      await writeFile(script, mcpServer("one"));
      const first = (await source.prepare({ traceContext }))!;
      first.commit?.();
      const call = async (candidate: typeof first) =>
        candidate.mcp!.port!.callTool({
          serverName: "example",
          toolName: "echo",
          arguments: {},
        });
      assert.match(JSON.stringify(await call(first)), /one/);

      await writeFile(script, mcpServer("two"));
      environment = { ...environment, revision: "two", mcpContentRevision: "script-two" };
      const second = (await source.prepare({ revision: "one", traceContext }))!;
      second.commit?.();
      assert.equal(pool.stats().activeConnections, 2);
      assert.match(JSON.stringify(await call(first)), /one/);
      assert.match(JSON.stringify(await call(second)), /two/);

      const facade = createSessionFacade({
        configResult: { config: { ui: { locale: "en-US" } } },
        runtime: {
          config: { workspaceIdentity: "mcp-reload-workspace" },
          refreshCapabilities: async () => undefined,
        },
        getLiveMcpPort: () => second.mcp!.port,
        getLiveMcpRevision: () => "script-two",
        getLiveMcpServers: () => environment.mcp.servers,
        traceContext,
        workingDirectory: root,
        workspaceIdentity: "mcp-reload-workspace",
      } as unknown as Parameters<typeof createSessionFacade>[0]);
      await facade.connectMcpServer("example");
      assert.equal(
        pool.stats().activeConnections,
        2,
        "manual reconnect must retain the adopted pool key",
      );
      assert.match(JSON.stringify(await call(first)), /one/);
      assert.match(JSON.stringify(await call(second)), /two/);

      const otherWorkspace = pool.acquireLease();
      await otherWorkspace.connectConfiguredServers(environment.mcp.servers!, {
        workingDirectory: root,
        workspaceIdentity: "different-remote-workspace",
        capabilityRevision: "script-two",
      });
      assert.equal(
        pool.stats().activeConnections,
        3,
        "identical paths do not merge remote workspace identities",
      );
      await otherWorkspace.close();

      await writeFile(script, "process.exit(1);\n");
      environment = { ...environment, revision: "broken", mcpContentRevision: "script-broken" };
      await assert.rejects(
        source.prepare({ revision: "two", traceContext }),
        /MCP capability preparation failed/,
      );
      assert.match(JSON.stringify(await call(second)), /two/);
      await first.release?.();
      assert.match(JSON.stringify(await call(second)), /two/);
      await second.release?.();
    } finally {
      await source.dispose?.();
      await pool.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function mcpServer(value: string): string {
  return `import { createInterface } from "node:readline";
const value = ${JSON.stringify(value)};
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "live-test", version: "1" }
  };
  else if (request.method === "tools/list") result = { tools: [{
    name: "echo", description: value, inputSchema: { type: "object", properties: {} }
  }] };
  else if (request.method === "tools/call") result = { content: [{ type: "text", text: value }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
}
`;
}
