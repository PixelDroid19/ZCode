import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const seaBinary = process.env.ZCODE_SEA_BINARY;

const runSea = (args, { input } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(seaBinary, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`SEA command timed out: ${args.join(" ")}`));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr, stdout });
    });
    child.stdin.end(input);
  });

test(
  "native SEA executable exposes CLI help and preserves async live-tool JSON streams",
  { skip: seaBinary ? false : "set ZCODE_SEA_BINARY to a native SEA executable" },
  async () => {
    const version = await runSea(["--version"]);
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/u);

    const help = await runSea(["--help"]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /__zcode-live-tool-host|Usage:/u);

    const directory = await mkdtemp(join(tmpdir(), "zcode-sea-live-tool-"));
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
  })), 1200);
});
`,
      );
      const result = await runSea(["__zcode-live-tool-host", script, "literal argument"], {
        input: JSON.stringify({ value: "kept" }),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        argument: "literal argument",
        value: "kept",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
