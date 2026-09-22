import type { McpConnectOptions, McpServerConfig } from "@zcode/contracts";

export function resolveMcpPoolWorkspaceKey(connectOptions: McpConnectOptions): string | undefined {
  return (
    connectOptions.workspaceIdentity?.trim() || connectOptions.workingDirectory?.trim() || undefined
  );
}

export function createMcpPoolConnectionKey(input: {
  config: McpServerConfig;
  connectOptions: McpConnectOptions;
  leaseId: string;
  serverName: string;
}): string {
  const scope =
    input.config.isolation === "workspace"
      ? (resolveMcpPoolWorkspaceKey(input.connectOptions) ?? "")
      : input.leaseId;
  return [
    input.serverName,
    scope,
    input.connectOptions.capabilityRevision ?? "",
    stableStringify(input.config),
  ].join("\u0000");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
