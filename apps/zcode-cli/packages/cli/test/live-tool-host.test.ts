import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("internal tool host preserves JSON streams and reports repairable failures through the real CLI", async () => {
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

    const hosts = [
      {
        executable: process.execPath,
        args: [
          createRequire(import.meta.url).resolve("tsx/cli"),
          fileURLToPath(new URL("../src/main.ts", import.meta.url)),
        ],
      },
    ];
    if (process.env.ZCODE_SEA_BINARY)
      hosts.push({ executable: process.env.ZCODE_SEA_BINARY, args: [] });
    for (const host of hosts) {
      const failures = [
        { source: "const invalid = ;", message: /SyntaxError/ },
        {
          source: 'throw new TypeError("Expected text to be a string");',
          message: /TypeError: Expected text/,
        },
        { source: 'import "./missing-helper.mjs";', message: /missing-helper\.mjs/ },
        {
          source:
            'throw new Error("Request failed", { cause: new Error("Authorization: Bearer fixture-private-value") });',
          message: /Request failed/,
        },
        {
          source:
            'let input = ""; for await (const chunk of process.stdin) input += chunk; throw new Error("Invalid value: " + input);',
          message: /Invalid value/,
          input: JSON.stringify({ text: "fixture-user-content" }),
        },
      ];
      for (const failure of failures) {
        await writeFile(script, failure.source);
        const failed = await runHost(host, script, directory, failure.input);
        assert.equal(failed.code, 1);
        assert.equal(failed.stdout, "", "failure diagnostics must not corrupt tool JSON stdout");
        assert.match(failed.stderr, failure.message);
        assert.match(failed.stderr, /tool\.mjs/);
        assert.doesNotMatch(failed.stderr, /fixture-private-value/);
        assert.doesNotMatch(failed.stderr, /fixture-user-content/);
        assert.ok(failed.stderr.length < 4_096, "diagnostics must stay bounded");
      }
      await writeFile(script, "process.stdout.write(JSON.stringify({ repaired: true }));");
      const repaired = await runHost(host, script, directory);
      assert.equal(repaired.code, 0, repaired.stderr);
      assert.deepEqual(JSON.parse(repaired.stdout), { repaired: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function runHost(
  host: { executable: string; args: string[] },
  script: string,
  home: string,
  input = "{}",
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(host.executable, [...host.args, "__zcode-live-tool-host", script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 10_000,
    });
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
    child.stdin.end(input);
  });
}
