import { access, readFile, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import {
  hostTarget,
  outputBinaryName,
} from "../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = resolve(repositoryRoot, "apps/zcode-cli");
const cliScriptDirectory = resolve(cliRoot, "packages/cli/scripts");
const cliDistDirectory = resolve(cliRoot, "packages/cli/dist");

const readPinnedNodeVersion = async () => {
  const miseConfig = await readFile(resolve(repositoryRoot, "mise.toml"), "utf8");
  const match = miseConfig.match(/^node\s*=\s*"([^"]+)"\s*$/mu);
  if (!match) throw new Error("Could not read the Node version pinned in mise.toml.");
  return match[1];
};

const run = (phase, command, args, options = {}) => {
  console.log(`\n[live-capabilities] ${phase}`);
  const commandEnvironment = withPinnedNodePath(options.env ?? process.env, process.execPath);
  const result = runCommand(command, args, {
    cwd: repositoryRoot,
    ...options,
    env: commandEnvironment,
  });
  if (result.signal) throw new Error(`${phase} was terminated by ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`${phase} did not exit successfully (status: ${String(result.status)}).`);
  }
};

const validateHostBinary = async (binaryPath) => {
  const binary = await stat(binaryPath).catch((error) => {
    if (error.code === "ENOENT") throw new Error(`SEA builder did not produce ${binaryPath}`);
    throw error;
  });
  if (!binary.isFile()) throw new Error(`SEA builder output is not a regular file: ${binaryPath}`);
  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  await access(binaryPath, accessMode).catch((error) => {
    throw new Error(`SEA builder output is not executable: ${binaryPath}`, { cause: error });
  });
};

const main = async () => {
  const pinnedNodeVersion = await readPinnedNodeVersion();
  if (process.versions.node !== pinnedNodeVersion) {
    throw new Error(
      `The live-capabilities gate requires Node ${pinnedNodeVersion} from mise.toml; ` +
        `got ${process.versions.node}. ` +
        "Run it with `mise exec -- pnpm run verify:pre-push`.",
    );
  }

  run("root typecheck", "pnpm", ["run", "typecheck"]);
  run("root lint", "pnpm", ["run", "lint"]);
  run("CLI typecheck", "pnpm", ["--dir", "apps/zcode-cli", "run", "typecheck", "--force"]);
  run("CLI lint", "pnpm", [
    "--dir",
    "apps/zcode-cli",
    "run",
    "lint",
    "--force",
    "--continue=always",
  ]);
  run("full architecture check", "pnpm", ["run", "architecture:check"]);

  const target = hostTarget();
  const binaryPath = resolve(cliDistDirectory, outputBinaryName(target));
  await rm(binaryPath, { force: true });

  run("build CLI workspace dependencies", "pnpm", [
    "exec",
    "turbo",
    "--skip-infer",
    "--cwd",
    "apps/zcode-cli",
    "run",
    "build",
    "--filter=!@zcode/cli",
    "--force",
  ]);
  run("build CLI bundle", "pnpm", ["--dir", "apps/zcode-cli/packages/cli", "run", "build"]);
  run("build and smoke-test current-host SEA", process.execPath, [
    resolve(cliScriptDirectory, "build-sea.mjs"),
    "--target",
    target,
    "--node-binary",
    `${target}=${process.execPath}`,
  ]);
  await validateHostBinary(binaryPath);

  const testEnvironment = {
    ...process.env,
    ZCODE_PROTOCOL_BUNDLE: resolve(cliDistDirectory, "zcode.cjs"),
    ZCODE_SEA_BINARY: binaryPath,
  };
  run(
    "live-capabilities integration and native SEA acceptance",
    process.execPath,
    [resolve(repositoryRoot, "scripts/run-live-capability-suite.mjs")],
    { env: testEnvironment },
  );
};

try {
  await main();
} catch (error) {
  console.error(`[live-capabilities] ${error.message}`);
  process.exitCode = 1;
}
