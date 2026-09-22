import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { McpServerConfig } from "@zcode/contracts";
import { createMcpAdapterConnectionPool } from "@zcode/adapters/mcp";
import {
  DirectoryMcpConfigurationError,
  loadDirectoryMcpServers,
} from "@zcode/adapters/directory-mcp";
import { createLiveCapabilitySource } from "../src/app/live-capability-source.js";

const MAX_DIRECTORY_FILE_BYTES = 1024 * 1024;
const traceContext = { traceId: "mcp-input-limits-test" } as never;

test(
  "directory MCP input limits reject whole candidates and preserve the adopted generation",
  { timeout: 45_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-mcp-input-limits-"));
    const homeDirectory = join(root, "home");
    const workspacePath = join(root, "workspace");
    const userConfigPath = join(homeDirectory, ".zcode", "cli", "config.json");
    const workspaceConfigPath = join(workspacePath, ".agents", "mcp.json");
    const serverPath = join(root, "server.mjs");
    const pool = createMcpAdapterConnectionPool();
    let source: ReturnType<typeof createLiveCapabilitySource> | undefined;

    try {
      const userServers: Record<string, Record<string, unknown>> = {
        example: stdioServer(process.execPath, {
          args: [serverPath],
          protocolVersion: "auto",
          timeoutMs: 2_000,
        }),
        masked: stdioServer("unused", { enabled: true }),
      };
      for (let index = 0; index < 38; index += 1) {
        userServers["user-disabled-" + pad(index)] = disabledStdioServer();
      }

      const workspaceServers: Record<string, Record<string, unknown>> = {
        masked: disabledStdioServer(),
      };
      for (let index = 0; index < 9; index += 1) {
        workspaceServers["user-disabled-" + pad(index)] = disabledStdioServer();
      }
      for (let index = 0; index < 21; index += 1) {
        workspaceServers["workspace-disabled-" + pad(index)] = disabledStdioServer();
      }

      const originalUserConfig = JSON.stringify({ mcp: { servers: userServers } }) + "\n";
      const serializedWorkspaceConfig = JSON.stringify({ mcpServers: workspaceServers }) + "\n";
      const originalWorkspaceConfig =
        " ".repeat(
          MAX_DIRECTORY_FILE_BYTES - Buffer.byteLength(serializedWorkspaceConfig, "utf8"),
        ) + serializedWorkspaceConfig;
      assert.equal(Buffer.byteLength(originalWorkspaceConfig, "utf8"), MAX_DIRECTORY_FILE_BYTES);
      await Promise.all([
        mkdir(dirname(userConfigPath), { recursive: true }),
        mkdir(dirname(workspaceConfigPath), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(userConfigPath, originalUserConfig, "utf8"),
        writeFile(workspaceConfigPath, originalWorkspaceConfig, "utf8"),
      ]);
      await writeFile(serverPath, liveMcpServer(), "utf8");

      let revision = 0;
      let effectiveServers: Record<string, McpServerConfig> = {};
      source = createLiveCapabilitySource({
        workingDirectory: workspacePath,
        workspaceIdentity: "mcp-input-limits-workspace",
        load: async () => {
          effectiveServers = (await loadDirectoryMcpServers({ homeDirectory, workspacePath }))
            .servers;
          revision += 1;
          return {
            revision: "input-limits-" + revision,
            tools: [],
            skills: { skills: [], diagnostics: [], totalDiscovered: 0 },
            pluginReferenceCatalog: { plugins: [] },
            mcp: { enabled: true, servers: effectiveServers },
          };
        },
        createMcpPort: () => pool.acquireLease(),
      });

      const first = (await source.prepare({ traceContext }))!;
      first.commit?.();
      assert.deepEqual(Object.keys(effectiveServers), ["example"]);
      assert.equal(effectiveServers.example?.protocolVersion, "auto");
      assert.equal(effectiveServers.example?.timeoutMs, 2_000);

      const assertOriginalGenerationCallable = async () => {
        const result = await first.mcp!.port!.callTool({
          serverName: "example",
          toolName: "echo",
          arguments: {},
        });
        assert.match(JSON.stringify(result), /stable-generation/u);
        assert.equal(pool.stats().activeConnections, 1);
      };

      const overlongFile = "{" + " ".repeat(MAX_DIRECTORY_FILE_BYTES) + "}";
      await assertRejectedCandidate(
        source,
        async () => {
          await writeFile(userConfigPath, originalUserConfig, "utf8");
          await writeFile(workspaceConfigPath, overlongFile, "utf8");
        },
        (error) =>
          error instanceof DirectoryMcpConfigurationError &&
          error.code === "invalid_config" &&
          error.cause instanceof Error &&
          error.cause.message === "Directory MCP input byte limit exceeded",
      );
      await assertOriginalGenerationCallable();

      const tooManyCombinedUserServers: Record<string, Record<string, unknown>> = {
        example: stdioServer(process.execPath, { args: [serverPath] }),
      };
      for (let index = 0; index < 62; index += 1) {
        tooManyCombinedUserServers["count-user-" + pad(index)] = disabledStdioServer();
      }
      const tooManyCombinedWorkspaceServers = {
        "count-workspace-a": disabledStdioServer(),
        "count-workspace-b": disabledStdioServer(),
      };
      await assertRejectedCandidate(
        source,
        async () => {
          await writeJson(userConfigPath, { mcp: { servers: tooManyCombinedUserServers } });
          await writeJson(workspaceConfigPath, { mcpServers: tooManyCombinedWorkspaceServers });
        },
        isInvalidDirectoryMcpConfig,
      );
      await assertOriginalGenerationCallable();

      const invalidServers: Record<string, Record<string, unknown>>[] = [
        { "too-long-command": stdioServer("x".repeat(4 * 1024 + 1), { enabled: false }) },
        {
          "too-many-args": stdioServer("unused", {
            args: Array.from({ length: 65 }, () => "x"),
            enabled: false,
          }),
        },
        {
          "too-many-env-entries": stdioServer("unused", {
            enabled: false,
            env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["K" + index, "v"])),
          }),
        },
        {
          "too-large-server-value": stdioServer("unused", {
            args: Array.from({ length: 5 }, () => "x".repeat(4_000)),
            enabled: false,
          }),
        },
        { ["n".repeat(129)]: disabledStdioServer() },
      ];

      for (const invalidMcpServers of invalidServers) {
        await assertRejectedCandidate(
          source,
          async () => {
            await writeJson(userConfigPath, { mcp: { servers: userServers } });
            await writeJson(workspaceConfigPath, { mcpServers: invalidMcpServers });
          },
          isInvalidDirectoryMcpConfig,
        );
        await assertOriginalGenerationCallable();
      }

      await writeFile(userConfigPath, originalUserConfig, "utf8");
      await writeFile(workspaceConfigPath, originalWorkspaceConfig, "utf8");
      const restored = (await source.prepare({
        revision: "after-invalid-candidates",
        traceContext,
      } as never))!;
      restored.commit?.();
      assert.deepEqual(Object.keys(effectiveServers), ["example"]);
      const restoredResult = await restored.mcp!.port!.callTool({
        serverName: "example",
        toolName: "echo",
        arguments: {},
      });
      assert.match(JSON.stringify(restoredResult), /stable-generation/u);
      await first.release?.();
      await restored.release?.();
    } finally {
      await source?.dispose?.();
      await pool.close();
      await rm(root, { force: true, recursive: true });
    }
  },
);

async function assertRejectedCandidate(
  source: ReturnType<typeof createLiveCapabilitySource>,
  writeCandidate: () => Promise<void>,
  validate: (error: unknown) => boolean,
): Promise<void> {
  await writeCandidate();
  await assert.rejects(source.prepare({ revision: "current", traceContext }), validate);
}

function isInvalidDirectoryMcpConfig(error: unknown): boolean {
  return error instanceof DirectoryMcpConfigurationError && error.code === "invalid_config";
}

function stdioServer(
  command: string,
  options: {
    args?: string[];
    enabled?: boolean;
    env?: Record<string, string>;
    protocolVersion?: "auto" | "legacy" | "2026-07-28";
    timeoutMs?: number;
  } = {},
): Record<string, unknown> {
  return {
    type: "stdio",
    command,
    args: options.args ?? [],
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function disabledStdioServer(): Record<string, unknown> {
  return stdioServer("unused", { enabled: false });
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value) + "\n", "utf8");
}

function liveMcpServer(): string {
  return [
    'import { createInterface } from "node:readline";',
    "for await (const line of createInterface({ input: process.stdin })) {",
    "  const request = JSON.parse(line);",
    "  if (request.id === undefined) continue;",
    "  let result;",
    '  if (request.method === "initialize") result = {',
    "    protocolVersion: request.params.protocolVersion,",
    '    capabilities: { tools: {} }, serverInfo: { name: "input-limit-test", version: "1" }',
    "  };",
    '  else if (request.method === "tools/list") result = { tools: [{',
    '    name: "echo", description: "stable-generation", inputSchema: { type: "object", properties: {} }',
    "  }] };",
    '  else if (request.method === "tools/call") result = { content: [{ type: "text", text: "stable-generation" }] };',
    "  else result = {};",
    '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");',
    "}",
    "",
  ].join("\n");
}
