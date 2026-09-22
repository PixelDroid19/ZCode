import { isSea } from "node:sea";
import { ZCODE_LIVE_TOOL_HOST_COMMAND, type ExecutionEnvOverlay } from "@zcode/contracts";

/** Node, Electron helper and SEA use the same argv/stdin tool contract. */
export function resolveLiveToolNodeRuntime(): {
  executable: string;
  args: readonly string[];
  env: ExecutionEnvOverlay;
} {
  return {
    executable: process.execPath,
    args: isSea() ? [ZCODE_LIVE_TOOL_HOST_COMMAND] : [],
    env: { set: { ELECTRON_RUN_AS_NODE: "1" } },
  };
}
