import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMcpAdapterConnectionPool, createMcpConnectionPool } from "@zcode/adapters/mcp";
import {
  createInMemorySessionEventStore,
  type McpPort,
  type McpServerConfig,
} from "@zcode/contracts";
import { AgentRuntime, createToolRegistry } from "@zcode/core";
import type { LoadedCapabilityEnvironment } from "../src/app/live-capability-source.js";
import { createLiveCapabilitySource } from "../src/app/live-capability-source.js";
import { createSessionFacade } from "../src/app/session-facade.js";

test(
  "facade manually recovers a failed real MCP process in its adopted workspace revision",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-manual-recovery-"));
    const serverPath = join(root, "server.mjs");
    const launchCountPath = join(root, "launches.txt");
    const allowConnectionsPath = join(root, "allow-connections");
    const pool = createMcpAdapterConnectionPool();
    const revision = "adopted-mcp-source-revision";
    const workspaceIdentity = "remote-workspace-recovery-test";
    const traceContext = { traceId: "mcp-manual-recovery-test" } as never;
    let source: ReturnType<typeof createLiveCapabilitySource> | undefined;
    let adopted:
      | Awaited<ReturnType<ReturnType<typeof createLiveCapabilitySource>["prepare"]>>
      | undefined;
    const config: McpServerConfig = {
      type: "stdio",
      command: process.execPath,
      args: [serverPath, launchCountPath],
      cwd: root,
      isolation: "workspace",
      timeoutMs: 3_000,
    };
    const mcpPort = pool.acquireLease();

    try {
      await writeFile(serverPath, recoveryServer(launchCountPath, allowConnectionsPath), "utf8");
      const initial = await mcpPort.connectServer("recovery", config, {
        capabilityRevision: revision,
        workingDirectory: root,
        workspaceIdentity,
      });
      assert.equal(initial.status, "failed");
      const initialLaunchCount = Number(await readFile(launchCountPath, "utf8"));
      assert.ok(initialLaunchCount > 0);

      const facade = createRecoveryFacade({
        config,
        mcpPort,
        revision,
        root,
        traceContext,
        workingDirectory: root,
        workspaceIdentity,
        acquireCapabilitiesLease: () => async () => undefined,
      });

      await writeFile(allowConnectionsPath, "ready", "utf8");
      const recovered = await facade.connectMcpServer("recovery");

      assert.equal(recovered.status, "connected");
      assert.ok(Number(await readFile(launchCountPath, "utf8")) > initialLaunchCount);
      assert.equal(pool.stats().activeConnections, 1);
      assert.match(
        JSON.stringify(
          await mcpPort.callTool({
            serverName: "recovery",
            toolName: "echo",
            arguments: {},
          }),
        ),
        /recovered/,
      );

      const environment: LoadedCapabilityEnvironment = {
        revision: "recovered-live-generation",
        mcpContentRevision: revision,
        tools: [],
        skills: { skills: [], diagnostics: [], totalDiscovered: 0 },
        pluginReferenceCatalog: { plugins: [] },
        mcp: { enabled: true, servers: { recovery: config } },
      };
      source = createLiveCapabilitySource({
        workingDirectory: root,
        workspaceIdentity,
        load: async () => environment,
        createMcpPort: () => pool.acquireLease(),
      });
      adopted = await source.prepare({ traceContext });
      assert.ok(adopted);
      adopted.commit?.();
      const adoptedPort = adopted.mcp.port!;
      const adoptedFacade = createRecoveryFacade({
        mcpPort: adoptedPort,
        config,
        revision,
        root,
        traceContext,
        workspaceIdentity,
        acquireCapabilitiesLease: () => async () => undefined,
      });

      await adoptedPort.callTool({
        serverName: "recovery",
        toolName: "crash",
        arguments: {},
      });
      const launchCountBeforeSecondRecovery = Number(await readFile(launchCountPath, "utf8"));
      const afterProcessExit = await adoptedFacade.connectMcpServer("recovery");
      assert.equal(afterProcessExit.status, "connected");
      assert.ok(Number(await readFile(launchCountPath, "utf8")) > launchCountBeforeSecondRecovery);
      assert.match(
        JSON.stringify(
          await adoptedPort.callTool({
            serverName: "recovery",
            toolName: "echo",
            arguments: {},
          }),
        ),
        /recovered/,
      );

      await verifyRetryLeaseDuringGenerationReplacement(root, traceContext);
    } finally {
      await source?.dispose();
      if (adopted && adopted.release) await adopted.release();
      await mcpPort.close();
      await pool.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function recoveryServer(launchCountPath: string, allowConnectionsPath: string): string {
  return `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const launchCountPath = ${JSON.stringify(launchCountPath)};
const allowConnectionsPath = ${JSON.stringify(allowConnectionsPath)};
const launchCount = (existsSync(launchCountPath) ? Number(readFileSync(launchCountPath, "utf8")) : 0) + 1;
writeFileSync(launchCountPath, String(launchCount));
if (!existsSync(allowConnectionsPath)) process.exit(1);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "manual-recovery", version: "1" }
  };
  else if (request.method === "tools/list") result = { tools: [
    { name: "echo", description: "recovered", inputSchema: { type: "object", properties: {} } },
    { name: "crash", description: "exit after reply", inputSchema: { type: "object", properties: {} } }
  ] };
  else if (request.method === "tools/call") {
    const response = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
      content: [{ type: "text", text: request.params.name === "crash" ? "exiting" : "recovered" }]
    } }) + "\\n";
    if (request.params.name === "crash") process.stdout.write(response, () => process.exit(0));
    else process.stdout.write(response);
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
}

function createRecoveryFacade(input: {
  config: McpServerConfig;
  mcpPort: McpPort;
  revision: string;
  root: string;
  traceContext: never;
  workingDirectory?: string;
  workspaceIdentity: string;
  acquireCapabilitiesLease: () => () => Promise<void>;
}) {
  return createSessionFacade({
    configResult: { config: { ui: { locale: "en-US" } } },
    runtime: {
      config: { workspaceIdentity: input.workspaceIdentity },
      refreshCapabilities: async () => undefined,
      acquireCapabilitiesLease: input.acquireCapabilitiesLease,
    },
    getLiveMcpPort: () => input.mcpPort,
    getLiveMcpRevision: () => input.revision,
    getLiveMcpServers: () => ({ recovery: input.config }),
    traceContext: input.traceContext,
    workingDirectory: input.workingDirectory ?? input.root,
    workspaceIdentity: input.workspaceIdentity,
  } as unknown as Parameters<typeof createSessionFacade>[0]);
}

async function verifyRetryLeaseDuringGenerationReplacement(
  root: string,
  traceContext: never,
): Promise<void> {
  let markPingStarted!: () => void;
  const pingStarted = new Promise<void>((resolve) => {
    markPingStarted = resolve;
  });
  let resolvePing!: (alive: boolean) => void;
  const pingGate = new Promise<boolean>((resolve) => {
    resolvePing = resolve;
  });
  const adapters = new Map<
    string,
    { closeCalls: number; closed: boolean; closeDone: Promise<void> }
  >();
  const pool = createMcpConnectionPool({
    idleGraceMs: 0,
    createAdapter: ({ config, serverName }) => {
      const generation = config.type === "stdio" ? (config.args?.[0] ?? "unknown") : "unknown";
      let status: "connected" | "disconnected" | "failed" = "disconnected";
      let resolveClose!: () => void;
      const adapterState = {
        closeCalls: 0,
        closed: false,
        closeDone: new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
      };
      adapters.set(generation, adapterState);
      const adapter = {
        async connectServer() {
          if (adapterState.closed) {
            status = "failed";
            return mcpStatus("failed");
          }
          status = "connected";
          return mcpStatus("connected");
        },
        async pingServer() {
          if (generation === "old") {
            markPingStarted();
            const alive = await pingGate;
            return alive && !adapterState.closed;
          }
          return !adapterState.closed;
        },
        async status() {
          return { [serverName]: mcpStatus(status) };
        },
        async listTools() {
          return [];
        },
        async callTool() {
          if (adapterState.closed) throw new Error("MCP generation is closed");
          return { content: [{ type: "text", text: generation }] };
        },
        async close() {
          adapterState.closeCalls++;
          adapterState.closed = true;
          status = "disconnected";
          resolveClose();
        },
      };
      return adapter as unknown as McpPort;
    },
  });
  let environment = testEnvironment("old");
  const source = createLiveCapabilitySource({
    workingDirectory: root,
    workspaceIdentity: "mcp-retry-generation-test",
    load: async () => environment,
    createMcpPort: () => pool.acquireLease(),
    onCommit: (committed, port) => {
      activeEnvironment = committed;
      activePort = port;
    },
  });
  let activeEnvironment: LoadedCapabilityEnvironment | undefined;
  let activePort: McpPort | undefined;
  const runtime = new AgentRuntime(
    "mcp-retry-generation-test" as never,
    { workingDirectory: root, subagents: { enabled: false } },
    {
      capabilitySource: source,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => ({}) as never,
      toolRegistry: createToolRegistry(),
    },
  );

  try {
    const initialStatus = await runtime.refreshCapabilities({ traceContext });
    assert.equal(initialStatus.status, "ready");
    const oldAdapter = adapters.get("old");
    assert.ok(oldAdapter);
    const facade = createSessionFacade({
      configResult: { config: { ui: { locale: "en-US" } } },
      runtime,
      getLiveMcpPort: () => activePort,
      getLiveMcpRevision: () => environment.mcpContentRevision,
      getLiveMcpServers: () => activeEnvironment?.mcp.servers ?? {},
      traceContext,
      workingDirectory: root,
      workspaceIdentity: "mcp-retry-generation-test",
    } as unknown as Parameters<typeof createSessionFacade>[0]);

    const retry = facade.connectMcpServer("example");
    await pingStarted;

    environment = testEnvironment("new");
    const replacement = await runtime.refreshCapabilities({ traceContext });
    assert.equal(replacement.status, "ready");
    assert.ok(adapters.get("new"), "the replacement source creates a separate MCP adapter");
    assert.equal(oldAdapter.closeCalls, 0, "retiring a generation cannot close a port in use");
    assert.match(
      JSON.stringify(
        await activePort!.callTool({
          serverName: "example",
          toolName: "echo",
          arguments: {},
        }),
      ),
      /new/,
    );

    resolvePing(true);
    assert.equal((await retry).status, "connected");
    await oldAdapter.closeDone;
    assert.equal(
      oldAdapter.closeCalls,
      1,
      "the old port closes after the retry releases its lease",
    );
    assert.match(
      JSON.stringify(
        await activePort!.callTool({
          serverName: "example",
          toolName: "echo",
          arguments: {},
        }),
      ),
      /new/,
    );
  } finally {
    await runtime.disposeCapabilities();
    await pool.close();
  }
}

function testEnvironment(generation: "old" | "new"): LoadedCapabilityEnvironment {
  return {
    revision: `${generation}-environment`,
    mcpContentRevision: `${generation}-mcp-content`,
    tools: [],
    skills: { skills: [], diagnostics: [], totalDiscovered: 0 },
    pluginReferenceCatalog: { plugins: [] },
    mcp: {
      enabled: true,
      servers: {
        example: {
          type: "stdio",
          command: "fake-mcp",
          args: [generation],
          isolation: "workspace",
          timeoutMs: 2_000,
        },
      },
    },
  };
}

function mcpStatus(status: "connected" | "disconnected" | "failed") {
  return {
    status,
    transport: "stdio" as const,
    toolCount: 0,
    updatedAt: new Date().toISOString(),
  };
}
