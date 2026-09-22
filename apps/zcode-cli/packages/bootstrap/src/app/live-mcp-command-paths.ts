import { extname, isAbsolute, resolve, sep } from "node:path";
import type { McpServerConfig } from "@zcode/contracts";

const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sh"]);

export function resolveMcpCodePaths(
  servers: Record<string, McpServerConfig>,
  workingDirectory: string,
): string[] {
  const paths = Object.values(servers).flatMap((server) => {
    if (server.type !== "stdio") return [];
    // `cwd` 本身也可能相对 workspace；先确定基准目录再解析 command 与脚本参数。
    const baseDirectory = resolve(workingDirectory, server.cwd ?? ".");
    const commandPath = isExplicitPath(server.command)
      ? resolveMcpPath(server.command, baseDirectory)
      : undefined;
    const argumentPaths = (server.args ?? [])
      .filter((value) => SCRIPT_EXTENSIONS.has(extname(value).toLowerCase()))
      .map((value) => resolveMcpPath(value, baseDirectory));
    return [...(commandPath ? [commandPath] : []), ...argumentPaths];
  });
  return [...new Set(paths)].sort();
}

function isExplicitPath(value: string): boolean {
  // 裸命令交由 PATH 查找；`.hiddenCommand` 也可能是裸名，只有路径标记或分隔符才纳入监视。
  return (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith(`.${sep}`) ||
    value.startsWith(`..${sep}`) ||
    value.includes(sep) ||
    (sep !== "/" && value.includes("/"))
  );
}

function resolveMcpPath(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}
