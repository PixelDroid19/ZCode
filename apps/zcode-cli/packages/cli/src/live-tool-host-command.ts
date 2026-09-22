import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ZCODE_LIVE_TOOL_HOST_COMMAND } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";

export function isLiveToolHostInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_LIVE_TOOL_HOST_COMMAND;
}

/** Only runs in the already permission-admitted child process, never during discovery. */
export async function runLiveToolHostCommand(ctx: RunContext, argv: string[]): Promise<number> {
  const [script, ...args] = argv;
  if (!script) {
    ctx.stderr.write("Live tool script path is required.\n");
    return 1;
  }
  try {
    const entrypoint = resolve(script);
    process.argv = [process.execPath, entrypoint, ...args];
    // 不恢复任何捕获的 broker 凭据；普通扩展不能冒充官方 plugin host。
    await import(pathToFileURL(entrypoint).href);
    return 0;
  } catch {
    ctx.stderr.write("Live tool script failed.\n");
    return 1;
  }
}
