import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeSessionCreateParamsSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionStateSnapshotSchema,
  type ZCodeAgentMcpServer,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";
import { createZCodeSessionService } from "../src/zcode-session/zcodeSessionService.js";

const filesystemServer: ZCodeAgentMcpServer = {
  name: "filesystem",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed"],
  env: [],
};

function snapshot(workspacePath: string, sessionId: string): ZCodeSessionStateSnapshot {
  return zcodeSessionStateSnapshotSchema.parse({
    protocol: { name: ZCODE_PROTOCOL_NAME, version: ZCODE_PROTOCOL_VERSION },
    session: {
      sessionId,
      workspace: { workspaceKey: workspacePath, workspacePath },
      sessionKind: "interactive",
      title: "MCP provenance",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 200_000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 0, pendingRequestIds: [] },
    messages: [],
  });
}

test("session schemas require a raw base when directory provenance supplies an MCP map", () => {
  const directoryInput = {
    workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
    mcpServers: [filesystemServer],
    mcpServersSource: "directory",
    mcpServersBase: [filesystemServer],
  };

  assert.deepEqual(zcodeSessionCreateParamsSchema.parse(directoryInput), directoryInput);
  assert.deepEqual(
    zcodeSessionResumeParamsSchema.parse({
      sessionId: "directory-session",
      ...directoryInput,
    }),
    {
      sessionId: "directory-session",
      ...directoryInput,
    },
  );
  assert.deepEqual(
    commandPayloadSchemas.createSession.parse({
      workspaceId: "workspace-a",
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
      mcpServersBase: [filesystemServer],
    }),
    {
      workspaceId: "workspace-a",
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
      mcpServersBase: [filesystemServer],
    },
  );
  assert.throws(() =>
    zcodeSessionCreateParamsSchema.parse({
      workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
      mcpServersBase: [filesystemServer],
    }),
  );
  assert.throws(() =>
    zcodeSessionCreateParamsSchema.parse({
      workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
    }),
  );
  assert.throws(() =>
    zcodeSessionResumeParamsSchema.parse({
      sessionId: "directory-session",
      mcpServers: [],
      mcpServersSource: "directory",
    }),
  );
  assert.throws(() =>
    commandPayloadSchemas.createSession.parse({
      workspaceId: "workspace-a",
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
    }),
  );
  assert.deepEqual(
    zcodeSessionCreateParamsSchema.parse({
      workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
      mcpServersSource: "directory",
    }),
    {
      workspace: { workspaceKey: "/workspace", workspacePath: "/workspace" },
      mcpServersSource: "directory",
    },
  );
  assert.deepEqual(
    commandPayloadSchemas.createSession.parse({
      workspaceId: "workspace-a",
      mcpServersSource: "directory",
    }),
    { workspaceId: "workspace-a", mcpServersSource: "directory" },
  );
});

test("directory MCP inputs retain their raw base before workspace and product transforms", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-mcp-provenance-"));
  const created: Array<Record<string, unknown>> = [];
  const service = createZCodeSessionService({
    agentService: {
      async createSession(params) {
        created.push(params as Record<string, unknown>);
        return snapshot(params.workspacePath, params.sessionId ?? "session-a");
      },
    } as never,
    cuaProductMcpServerResolver: {
      async resolveMcpServers(servers) {
        return servers?.map((server) =>
          "command" in server
            ? { ...server, env: [...server.env, { name: "HOST_ADDED", value: "yes" }] }
            : server,
        );
      },
    },
  });

  try {
    await service.createSession({
      sessionId: "directory-session",
      persistence: "deferred",
      workspacePath,
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
    });
    await service.createSession({
      sessionId: "explicit-empty-session",
      persistence: "deferred",
      workspacePath,
      mcpServers: [],
      mcpServersSource: "directory",
    });
    await service.createSession({
      sessionId: "manual-session",
      persistence: "deferred",
      workspacePath,
      mcpServers: [],
    });

    const directory = created[0];
    assert.equal(directory?.mcpServersSource, "directory");
    assert.deepEqual(directory?.mcpServersBase, [filesystemServer]);
    assert.deepEqual(directory?.mcpServers, [
      {
        ...filesystemServer,
        args: [...filesystemServer.args, workspacePath],
        env: [{ name: "HOST_ADDED", value: "yes" }],
      },
    ]);

    const explicitEmpty = created[1];
    assert.equal(explicitEmpty?.mcpServersSource, "directory");
    assert.deepEqual(explicitEmpty?.mcpServersBase, []);
    assert.deepEqual(explicitEmpty?.mcpServers, []);

    const manual = created[2];
    assert.deepEqual(manual?.mcpServers, []);
    assert.equal("mcpServersSource" in (manual ?? {}), false);
    assert.equal("mcpServersBase" in (manual ?? {}), false);
  } finally {
    await rm(workspacePath, { force: true, recursive: true });
  }
});

test("replayable task creation forwards a directory base with its host-resolved map", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-task-mcp-provenance-"));
  const taskIndexRepo = new TaskIndexRepo(join(workspacePath, "tasks.sqlite"));
  const created: Array<Record<string, unknown>> = [];
  let createdSessionCount = 0;
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    taskIndexRepo,
    zcodeAgentService: {
      async createSession(params: { sessionId?: string; workspacePath: string }) {
        created.push(params as Record<string, unknown>);
        createdSessionCount += 1;
        return snapshot(params.workspacePath, params.sessionId ?? `session-${createdSessionCount}`);
      },
      disposeAll() {},
    } as never,
    taskIndexSyncer: {
      disposeAll() {},
      emitWorkspaceTaskListChanged() {},
      ensureSessionSubscription() {},
      getWorkspaceEmitter() {
        return { fire() {} };
      },
      onSessionReadyEvent: disposable,
      onSessionTerminalEvent: disposable,
    } as never,
    cuaProductMcpServerResolver: {
      async resolveMcpServers(servers) {
        return servers?.map((server) =>
          "command" in server
            ? { ...server, env: [...server.env, { name: "HOST_ADDED", value: "yes" }] }
            : server,
        );
      },
    } as never,
  });

  try {
    await service.createTask({
      workspacePath,
      workspaceIdentity: "remote:workspace-a",
      mcpServers: [filesystemServer],
      mcpServersSource: "directory",
    });

    assert.equal(created.length, 1);
    const input = created[0];
    assert.equal(input?.workspacePath, workspacePath);
    assert.equal(input?.workspaceIdentity, "remote:workspace-a");
    assert.equal(input?.mcpServersSource, "directory");
    assert.deepEqual(input?.mcpServersBase, [filesystemServer]);
    assert.deepEqual(input?.mcpServers, [
      {
        ...filesystemServer,
        env: [{ name: "HOST_ADDED", value: "yes" }],
      },
    ]);
  } finally {
    service.disposeAll();
    await rm(workspacePath, { force: true, recursive: true });
  }
});
