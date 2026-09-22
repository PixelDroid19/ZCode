import { spawnSync } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testDirectories = [
  "apps/zcode-cli/packages/adapters/test",
  "apps/zcode-cli/packages/bootstrap/test",
  "apps/zcode-cli/packages/cli/test",
  "apps/zcode-cli/packages/core/test",
  "apps/zcode-cli/packages/telemetry/test",
  "apps/zcode-cli/packages/tui/test",
  "packages/services/test",
  "packages/ui/test",
];
const testFilePattern = /\.test\.(?:mjs|ts)$/u;
const seaAcceptanceName =
  "native SEA executable exposes CLI help and preserves async live-tool JSON streams";

const listTestFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return listTestFiles(entryPath);
      return entry.isFile() && testFilePattern.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nestedFiles.flat();
};

const validateSeaBinary = async (binaryPath) => {
  if (!binaryPath || !isAbsolute(binaryPath)) {
    throw new Error("ZCODE_SEA_BINARY must name the absolute path to the host SEA.");
  }

  const binary = await stat(binaryPath).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`ZCODE_SEA_BINARY does not exist: ${binaryPath}`);
    }
    throw error;
  });
  if (!binary.isFile()) throw new Error(`ZCODE_SEA_BINARY is not a file: ${binaryPath}`);

  const accessMode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  await access(binaryPath, accessMode).catch((error) => {
    throw new Error(`ZCODE_SEA_BINARY is not executable: ${binaryPath}`, { cause: error });
  });
};

const readReportedCount = (report, label) => {
  const matches = [...report.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gmu"))];
  if (matches.length === 0) {
    throw new Error(`Node test runner did not report a TAP ${label} count.`);
  }
  return Number(matches.at(-1)[1]);
};

const main = async () => {
  const seaBinary = process.env.ZCODE_SEA_BINARY;
  await validateSeaBinary(seaBinary);

  const testGroups = (
    await Promise.all(
      testDirectories.map(async (directory) => {
        const testDirectory = join(repositoryRoot, directory);
        const packageDirectory = dirname(testDirectory);
        const tsconfigPath = join(packageDirectory, "tsconfig.json");
        const testFiles = (await listTestFiles(testDirectory)).sort();
        if (testFiles.length === 0) return null;
        await access(tsconfigPath, constants.R_OK).catch((error) => {
          throw new Error(`The package tsconfig is unavailable: ${tsconfigPath}`, {
            cause: error,
          });
        });
        return { directory, packageDirectory, testFiles, tsconfigPath };
      }),
    )
  ).filter((group) => group !== null);
  const testFiles = testGroups.flatMap((group) => group.testFiles);

  if (testFiles.length === 0) throw new Error("No live-capability integration tests were found.");

  const seaAcceptancePath = join(
    repositoryRoot,
    "apps/zcode-cli/packages/cli/test/sea-executable.test.mjs",
  );
  if (!testFiles.includes(seaAcceptancePath)) {
    throw new Error(`The required SEA acceptance test was not discovered: ${seaAcceptancePath}`);
  }

  console.log(
    `[live-capabilities] running ${testFiles.length} test files in ${testGroups.length} package groups`,
  );

  let totalTests = 0;
  let totalSkipped = 0;
  let seaAcceptanceReported = false;
  const failures = [];

  for (const group of testGroups) {
    console.log(
      `[live-capabilities] ${group.directory}: ${group.testFiles.length} files using ${group.tsconfigPath}`,
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--test", "--test-reporter=tap", ...group.testFiles],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, TSX_TSCONFIG_PATH: group.tsconfigPath },
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) failures.push(`${group.directory}: ${result.error.message}`);
    if (result.signal)
      failures.push(`${group.directory}: tests were terminated by ${result.signal}`);
    if (result.status !== 0) {
      failures.push(`${group.directory}: tests exited with status ${String(result.status)}`);
    }

    const report = result.stdout ?? "";
    try {
      totalTests += readReportedCount(report, "tests");
      totalSkipped += readReportedCount(report, "skipped");
    } catch (error) {
      failures.push(`${group.directory}: ${error.message}`);
    }

    if (group.testFiles.includes(seaAcceptancePath)) {
      if (report.includes(seaAcceptanceName)) {
        seaAcceptanceReported = true;
      } else {
        failures.push("The required native SEA acceptance test did not appear in the TAP report.");
      }
    }
  }

  console.log(
    `[live-capabilities] completed ${totalTests} tests across ${testGroups.length} package groups; ${totalSkipped} skipped`,
  );
  if (totalSkipped !== 0) {
    failures.push(`The gate requires zero skipped tests; Node reported ${totalSkipped}.`);
  }
  if (!seaAcceptanceReported) {
    failures.push("The required native SEA acceptance test did not run.");
  }
  if (failures.length > 0) {
    throw new Error(`Integration test failures:\n${failures.join("\n")}`);
  }
};

try {
  await main();
} catch (error) {
  console.error(`[live-capabilities] ${error.message}`);
  process.exitCode = 1;
}
