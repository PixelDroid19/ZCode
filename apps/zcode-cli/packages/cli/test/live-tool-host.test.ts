import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("internal tool host preserves JSON stdout and asynchronous script lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-tool-host-"));
  try {
    const script = join(directory, "tool.mjs");
    await writeFile(
      script,
      `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  setTimeout(() => process.stdout.write(JSON.stringify({
    value: JSON.parse(input).value,
    argument: process.argv[2],
  })), 1400);
});
`,
    );
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            createRequire(import.meta.url).resolve("tsx/cli"),
            fileURLToPath(new URL("../src/main.ts", import.meta.url)),
            "__zcode-live-tool-host",
            script,
            "literal argument",
          ],
          { env: { ...process.env, HOME: directory, USERPROFILE: directory }, timeout: 10_000 },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(JSON.stringify({ value: "kept" }));
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { value: "kept", argument: "literal argument" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
