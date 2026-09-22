import assert from "node:assert/strict";
import test from "node:test";
import type { McpServerConfig } from "@zcode/contracts";
import { applyDirectoryMcpAugmentations } from "../src/app/live-mcp-configuration.js";
import { protocolMcpServersToRuntimeMcpConfig } from "../src/zcode-protocol/protocol-mcp-config.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";

test("directory reload retains host additions, removals, and explicit exclusions without reviving deleted servers", () => {
  const base: Record<string, McpServerConfig> = {
    filesystem: {
      type: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: { USER: "before", REMOVE: "yes" },
    },
    excluded: { type: "stdio", command: "excluded" },
    deleted: { type: "stdio", command: "deleted" },
  };
  const resolved: Record<string, McpServerConfig> = {
    filesystem: {
      type: "stdio",
      command: "node",
      args: ["server.mjs", "/workspace"],
      env: { USER: "before", HOST_TEST_VALUE: "host-owned" },
    },
    deleted: base.deleted!,
  };
  const current: Record<string, McpServerConfig> = {
    filesystem: { ...base.filesystem!, timeoutMs: 1234 },
    excluded: base.excluded!,
    added: { type: "stdio", command: "added" },
  };
  const result = applyDirectoryMcpAugmentations(current, base, resolved);
  assert.deepEqual(Object.keys(result).sort(), ["added", "filesystem"]);
  assert.deepEqual(result.filesystem, {
    ...current.filesystem,
    args: ["server.mjs", "/workspace"],
    env: { USER: "before", HOST_TEST_VALUE: "host-owned" },
  });
});

test("changing a stdio command/arguments or HTTP endpoint cannot inherit another endpoint's host credentials", () => {
  const base: Record<string, McpServerConfig> = {
    stdio: { type: "stdio", command: "node", args: ["original.mjs"] },
    http: { type: "http", url: "https://old.example.test/mcp" },
  };
  const resolved: Record<string, McpServerConfig> = {
    stdio: { ...base.stdio!, env: { HOST_TEST_VALUE: "private-test-value" } },
    http: { ...base.http!, headers: { authorization: "private-test-value" } },
  };
  const current: Record<string, McpServerConfig> = {
    stdio: { type: "stdio", command: "node", args: ["replacement.mjs"] },
    http: { type: "http", url: "https://new.example.test/mcp" },
  };
  assert.deepEqual(applyDirectoryMcpAugmentations(current, base, resolved), current);
});

test("an explicit empty MCP map remains a complete override across protocol conversion", () => {
  assert.equal(protocolMcpServersToRuntimeMcpConfig(undefined), undefined);
  assert.deepEqual(protocolMcpServersToRuntimeMcpConfig([]), { enabled: true, servers: {} });
});

test("changing process startup environment does not inherit host credentials", () => {
  const base: Record<string, McpServerConfig> = {
    example: { type: "stdio", command: "node", args: ["server.mjs"] },
  };
  const resolved: Record<string, McpServerConfig> = {
    example: { ...base.example!, env: { HOST_TEST_VALUE: "private-test-value" } },
  };
  const current: Record<string, McpServerConfig> = {
    example: { ...base.example!, env: { NODE_OPTIONS: "--require ./changed.cjs" } },
  };
  assert.deepEqual(applyDirectoryMcpAugmentations(current, base, resolved), current);
});

test("the v4 session creation handler forwards MCP provenance and its unaugmented base", async () => {
  const payload = {
    workspaceId: "/workspace",
    mcpServers: [],
    mcpServersSource: "directory" as const,
    mcpServersBase: [],
  };
  let forwarded: unknown;
  const host = {
    async createSessionRecord(input: unknown) {
      forwarded = input;
      return { sessionId: "session-test" };
    },
  } as unknown as ConstructorParameters<typeof V4CommandExecutor>[0];
  await new V4CommandExecutor(host).execute({ type: "createSession", payload } as never);
  assert.deepEqual(forwarded, {
    ...payload,
    offPeakToolEnabled: undefined,
    dynamicWorkflowEnabled: undefined,
  });
});
