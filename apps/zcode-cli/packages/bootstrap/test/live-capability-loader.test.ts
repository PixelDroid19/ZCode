import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfig } from "@zcode/adapters/config";
import type { Logger, McpServerConfig } from "@zcode/contracts";
import { resolveZCodePlugins } from "../src/plugins.js";
import { createLiveCapabilityLoader } from "../src/app/live-capability-loader.js";
import type { ZCodeAppOptions } from "../src/app/types.js";

const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

async function fixture(
  run: (input: {
    home: string;
    workspace: string;
    configFile: string;
    loader: (options: Partial<ZCodeAppOptions>) => ReturnType<typeof createLiveCapabilityLoader>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-capability-loader-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, ".zcode"), { recursive: true });
  const configFile = join(workspace, ".zcode", "config.json");
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    await run({
      home,
      workspace,
      configFile,
      loader(overrides) {
        const options = {
          env,
          officialPluginRoots: [],
          pluginStorageRoot: join(root, "plugins"),
          ...overrides,
        } as unknown as ZCodeAppOptions;
        const initialConfig = createConfig({ env, workingDirectory: workspace });
        const initialPlugins = resolveZCodePlugins({
          configResult: initialConfig,
          env,
          workingDirectory: workspace,
          officialPluginRoots: [],
          pluginStorageRoot: options.pluginStorageRoot,
        });
        return createLiveCapabilityLoader({
          options,
          initialConfig,
          initialPlugins,
          initialRuntimeConfig: {},
          cliStorageRoot: join(root, "cli"),
          storageRoot: join(root, "storage"),
          workingDirectory: workspace,
          logger,
        });
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const server: McpServerConfig = { type: "stdio", command: "node", args: ["-e", ""] };

test("a complete session MCP override never reacquires servers excluded by its caller", async () => {
  await fixture(async ({ configFile, loader }) => {
    assert.throws(
      () =>
        loader({
          mcpServersSource: "directory",
          runtimeConfig: { mcp: { servers: {} } },
        }),
      /require their unaugmented base/,
    );
    await writeFile(configFile, JSON.stringify({ mcp: { servers: { alpha: server } } }));
    const source = loader({ runtimeConfig: { mcp: { enabled: true, servers: { beta: server } } } });
    const first = (await source.load())!;
    assert.deepEqual(Object.keys(first.mcp.servers ?? {}).sort(), ["beta", "node_repl"]);
    await writeFile(
      configFile,
      JSON.stringify({ mcp: { servers: { alpha: server, gamma: server } } }),
    );
    const second = (await source.load(first.revision))!;
    assert.deepEqual(Object.keys(second.mcp.servers ?? {}).sort(), ["beta", "node_repl"]);
    await first.disposeTools?.();
    await second.disposeTools?.();
    const empty = (await loader({
      runtimeConfig: { mcp: { enabled: true, servers: {} } },
    }).load())!;
    // Session maps override user MCP; the host-owned node_repl remains independent.
    assert.deepEqual(Object.keys(empty.mcp.servers ?? {}), ["node_repl"]);
    await empty.disposeTools?.();
  });
});

test("directory projections follow added, changed, and removed .agents servers without reopening the app", async () => {
  await fixture(async ({ workspace, loader }) => {
    await mkdir(join(workspace, ".agents"));
    const path = join(workspace, ".agents", "mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { alpha: server } }));
    const source = loader({ mcpServersSource: "directory" });
    const first = (await source.load())!;
    assert.deepEqual(Object.keys(first.mcp.servers ?? {}).sort(), ["alpha", "node_repl"]);
    await writeFile(path, JSON.stringify({ mcpServers: { beta: { ...server, timeoutMs: 4321 } } }));
    const second = (await source.load(first.revision))!;
    assert.deepEqual(Object.keys(second.mcp.servers ?? {}).sort(), ["beta", "node_repl"]);
    assert.equal(second.mcp.servers?.beta?.timeoutMs, 4321);
    await writeFile(path, JSON.stringify({ mcpServers: {} }));
    const third = (await source.load(second.revision))!;
    assert.deepEqual(Object.keys(third.mcp.servers ?? {}), ["node_repl"]);
    await Promise.all([first, second, third].map((value) => value.disposeTools?.()));
  });
});

test("explicit extensionless and exe commands reload while bare wrappers retain script arguments", async () => {
  await fixture(async ({ workspace, loader }) => {
    const bin = join(workspace, "bin");
    const extensionlessCommand = join(bin, "mcp-server");
    const exeCommand = join(bin, "remote-mcp.exe");
    const linkedCommand = join(bin, "linked-mcp");
    const wrapperEntry = join(bin, "entry.mjs");
    const hiddenName = join(bin, ".hiddenCommand");
    await mkdir(bin, { recursive: true });
    await writeFile(extensionlessCommand, "first executable", "utf8");
    await writeFile(exeCommand, "first windows executable", "utf8");
    if (process.platform !== "win32") await symlink(exeCommand, linkedCommand);
    await writeFile(wrapperEntry, "export const value = 1;\n", "utf8");
    await writeFile(hiddenName, "not selected by a bare command", "utf8");

    const source = loader({
      runtimeConfig: {
        mcp: {
          enabled: true,
          servers: {
            ...(process.platform !== "win32"
              ? { linked: { type: "stdio" as const, command: linkedCommand } }
              : {}),
            extensionless: {
              type: "stdio",
              command: "./mcp-server",
              cwd: "bin",
            },
            exe: {
              type: "stdio",
              command: "./remote-mcp.exe",
              cwd: "bin",
            },
            wrapper: {
              type: "stdio",
              command: "mcp-wrapper",
              args: ["./entry.mjs"],
              cwd: "bin",
            },
            hidden: {
              type: "stdio",
              command: ".hiddenCommand",
              cwd: "bin",
            },
          },
        },
      },
    });
    const first = (await source.load())!;

    assert.ok(first.watchPaths?.includes(extensionlessCommand));
    assert.ok(first.watchPaths?.includes(exeCommand));
    assert.ok(first.watchPaths?.includes(wrapperEntry));
    assert.ok(!first.watchPaths?.includes(hiddenName));
    assert.ok(!first.watchPaths?.includes(join(bin, "mcp-wrapper")));

    await writeFile(extensionlessCommand, "second executable", "utf8");
    const second = await source.load(first.revision);
    assert.ok(second);
    assert.notEqual(second.revision, first.revision);

    await writeFile(exeCommand, "second windows executable", "utf8");
    const third = await source.load(second.revision);
    assert.ok(third);
    assert.notEqual(third.revision, second.revision);

    await rm(extensionlessCommand);
    const fourth = await source.load(third.revision);
    assert.ok(fourth);
    assert.notEqual(fourth.revision, third.revision);
    if (process.platform !== "win32") {
      await chmod(exeCommand, 0o744);
      const permissionChange = await source.load(fourth.revision);
      assert.ok(permissionChange, "an executable permission change requires reconciliation");
      assert.notEqual(permissionChange.revision, fourth.revision);
      const alternativeCommand = join(bin, "alternative-mcp.exe");
      await copyFile(exeCommand, alternativeCommand);
      await chmod(alternativeCommand, 0o744);
      await rm(linkedCommand);
      await symlink(alternativeCommand, linkedCommand);
      const retargeted = await source.load(permissionChange.revision);
      assert.ok(
        retargeted,
        "a symlink target change requires reconciliation even with identical bytes",
      );
      assert.notEqual(retargeted.mcpContentRevision, permissionChange.mcpContentRevision);
      await retargeted.disposeTools?.();
      await permissionChange.disposeTools?.();
    }
    await Promise.all([first, second, third, fourth].map((value) => value.disposeTools?.()));
  });
});
