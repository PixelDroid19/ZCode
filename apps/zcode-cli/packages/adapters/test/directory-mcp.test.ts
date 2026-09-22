import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";
import {
  DirectoryMcpConfigurationError,
  loadDirectoryMcpServers,
} from "../src/directory-mcp/index.js";

function stdio(command: string, enabled?: boolean): Record<string, unknown> {
  return {
    ...(enabled === undefined ? {} : { enabled }),
    args: [],
    command,
    type: "stdio",
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeDirectories(
  t: test.TestContext,
): Promise<{ homeDirectory: string; workspacePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-directory-mcp-"));
  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });
  return {
    homeDirectory: join(root, "home"),
    workspacePath: join(root, "workspace"),
  };
}

test("prefers non-empty .zcode sources, normalizes legacy enable, and applies workspace tombstones", async (t) => {
  const { homeDirectory, workspacePath } = await makeDirectories(t);
  await writeJson(join(homeDirectory, ".zcode", "cli", "config.json"), {
    mcp: {
      servers: {
        overridden: stdio("user-command"),
        userDisabled: { ...stdio("legacy-disabled"), enable: false },
        userZcode: stdio("user-zcode"),
      },
    },
  });
  await writeJson(join(homeDirectory, ".agents", "mcp.json"), {
    mcpServers: { userAgents: stdio("user-agents") },
  });
  await writeJson(join(workspacePath, ".zcode", "config.json"), {
    mcp: {
      servers: {
        overridden: stdio("workspace-disabled", false),
        workspaceZcode: stdio("workspace-zcode"),
      },
    },
  });
  await writeJson(join(workspacePath, ".agents", "mcp.json"), {
    mcpServers: { workspaceAgents: stdio("workspace-agents") },
  });

  const result = await loadDirectoryMcpServers({ homeDirectory, workspacePath });

  assert.deepEqual(Object.keys(result.servers), ["userZcode", "workspaceZcode"]);
  assert.equal(result.servers.userZcode?.type, "stdio");
  assert.equal(result.servers.workspaceZcode?.type, "stdio");
  assert.equal(result.servers.userAgents, undefined);
  assert.equal(result.servers.workspaceAgents, undefined);
  assert.equal(result.servers.overridden, undefined);
  assert.equal(result.servers.userDisabled, undefined);
});

test("falls back to .agents, normalizes legacy enable, and returns every absolute watch path", async (t) => {
  const { homeDirectory, workspacePath } = await makeDirectories(t);
  await writeJson(join(homeDirectory, ".zcode", "cli", "config.json"), { mcp: { servers: {} } });
  await writeJson(join(homeDirectory, ".agents", "mcp.json"), {
    mcpServers: {
      shared: stdio("user-shared"),
      userAgents: { ...stdio("user-agents"), enable: true },
    },
  });
  await writeJson(join(workspacePath, ".zcode", "config.json"), { mcp: { servers: {} } });
  await writeJson(join(workspacePath, ".agents", "mcp.json"), {
    mcpServers: {
      shared: { ...stdio("workspace-disabled"), enable: false },
      workspaceAgents: stdio("workspace-agents"),
    },
  });

  const result = await loadDirectoryMcpServers({ homeDirectory, workspacePath });

  assert.deepEqual(Object.keys(result.servers), ["userAgents", "workspaceAgents"]);
  assert.equal(result.servers.userAgents?.enabled, true);
  assert.deepEqual(result.watchPaths, [
    join(homeDirectory, ".zcode", "cli", "config.json"),
    join(homeDirectory, ".agents", "mcp.json"),
    join(workspacePath, ".zcode", "config.json"),
    join(workspacePath, ".agents", "mcp.json"),
  ]);
  assert.ok(result.watchPaths.every(isAbsolute));
});

test("rejects invalid directory inputs and invalid selected MCP files", async (t) => {
  const { homeDirectory, workspacePath } = await makeDirectories(t);
  await assert.rejects(
    loadDirectoryMcpServers({ homeDirectory: " ", workspacePath }),
    (error: unknown) =>
      error instanceof DirectoryMcpConfigurationError && error.code === "invalid_input",
  );

  const agentsPath = join(homeDirectory, ".agents", "mcp.json");
  await mkdir(dirname(agentsPath), { recursive: true });
  await writeFile(agentsPath, "{ not-json", "utf8");
  await assert.rejects(
    loadDirectoryMcpServers({ homeDirectory, workspacePath }),
    (error: unknown) =>
      error instanceof DirectoryMcpConfigurationError &&
      error.code === "invalid_config" &&
      error.path === agentsPath,
  );

  await writeJson(agentsPath, {
    mcpServers: {
      invalid: { ...stdio("bad-server"), unsupported: true },
    },
  });
  await assert.rejects(
    loadDirectoryMcpServers({ homeDirectory, workspacePath }),
    (error: unknown) =>
      error instanceof DirectoryMcpConfigurationError && error.code === "invalid_config",
  );
});
