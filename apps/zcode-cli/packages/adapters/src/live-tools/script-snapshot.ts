import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiveToolConfigurationError } from "./errors.js";
import type { LiveToolNodeScriptCommand, LiveToolScriptLease } from "./types.js";

const SNAPSHOT_PREFIX = "zcode-live-tool-";

/**
 * Writes captured script bytes to a private temporary directory once per prepared
 * capability candidate. The caller owns the returned lease and must dispose it after
 * the candidate is rejected or after its final active tool call drains.
 */
export async function materializeLiveToolScript(
  script: LiveToolNodeScriptCommand,
  options: { temporaryDirectory?: string } = {},
): Promise<LiveToolScriptLease> {
  verifyScriptDigest(script);
  const directory = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), SNAPSHOT_PREFIX));
  const path = join(directory, `tool${script.extension}`);
  let disposed = false;
  try {
    await writeFile(path, script.contents, { flag: "wx", mode: 0o500 });
    const written = new Uint8Array(await readFile(path));
    if (digest(written) !== script.digest) {
      throw new LiveToolConfigurationError(
        "script_digest_mismatch",
        "Live tool script snapshot did not retain its captured bytes",
        { path: script.sourcePath },
      );
    }
    // Windows ignores Unix mode bits, while Unix prevents accidental edits through the
    // materialized path. The immutable content check above remains the correctness guard.
    await chmod(path, 0o500);
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }

  return Object.freeze({
    dispose: async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await rm(directory, { force: true, recursive: true });
    },
    path,
  });
}

function verifyScriptDigest(script: LiveToolNodeScriptCommand): void {
  if (digest(script.contents) !== script.digest) {
    throw new LiveToolConfigurationError(
      "script_digest_mismatch",
      "Live tool script bytes no longer match the loaded revision",
      { path: script.sourcePath },
    );
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
