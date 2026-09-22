import type { McpServerConfig } from "@zcode/contracts";

/** Reapplies only host-owned augmentation, never a stale directory server list. */
export function applyDirectoryMcpAugmentations(
  current: Record<string, McpServerConfig>,
  base: Record<string, McpServerConfig> = {},
  resolved: Record<string, McpServerConfig> = {},
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(current)) {
    const original = base[name];
    const augmented = resolved[name];
    // Host 的显式剔除是 session 边界；读取目录不能把它重新启用。
    if (original && !augmented) continue;
    if (!original || !augmented || !sameEndpoint(original, server)) {
      servers[name] = server;
      continue;
    }
    if (server.type === "stdio" && original.type === "stdio" && augmented.type === "stdio") {
      const originalArgs = original.args ?? [];
      const augmentedArgs = augmented.args ?? [];
      if (
        original.command !== augmented.command ||
        original.cwd !== augmented.cwd ||
        !originalArgs.every((arg, index) => augmentedArgs[index] === arg)
      ) {
        throw new Error("Unsupported host MCP command transformation");
      }
      servers[name] = {
        ...server,
        args: [...(server.args ?? []), ...augmentedArgs.slice(originalArgs.length)],
        env: applyHostMapDelta(server.env, original.env, augmented.env),
      };
    } else if (
      server.type !== "stdio" &&
      original.type !== "stdio" &&
      augmented.type !== "stdio" &&
      original.type === augmented.type &&
      original.url === augmented.url
    ) {
      servers[name] = {
        ...server,
        headers: applyHostMapDelta(server.headers, original.headers, augmented.headers),
      };
    } else {
      throw new Error("Unsupported host MCP endpoint transformation");
    }
  }
  return servers;
}

function sameEndpoint(left: McpServerConfig, right: McpServerConfig): boolean {
  if (left.type !== right.type) return false;
  if (left.type !== "stdio" && right.type !== "stdio") {
    return left.url === right.url && sameMap(left.headers, right.headers);
  }
  if (left.type !== "stdio" || right.type !== "stdio") return false;
  return (
    left.command === right.command &&
    left.cwd === right.cwd &&
    JSON.stringify(left.args ?? []) === JSON.stringify(right.args ?? []) &&
    sameMap(left.env, right.env)
  );
}

function sameMap(left: Record<string, string> = {}, right: Record<string, string> = {}): boolean {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => left[key] === right[key])
  );
}

function applyHostMapDelta(
  current: Record<string, string> = {},
  base: Record<string, string> = {},
  augmented: Record<string, string> = {},
): Record<string, string> {
  const result = { ...current };
  for (const key of new Set([...Object.keys(base), ...Object.keys(augmented)])) {
    if (base[key] === augmented[key]) continue;
    if (augmented[key] === undefined) delete result[key];
    else result[key] = augmented[key];
  }
  return result;
}
