import type {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type {
  Logger,
  McpOAuthConfig,
  McpServerConfig,
  McpServerStatus,
  OfficialMcpAuthFailureReason,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";
import type { McpConnectionContext } from "./pool.js";
import type { McpOAuthRuntimeOptions } from "./oauth.js";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import type { McpTelemetryTracker } from "./telemetry.js";

export const DEFAULT_MCP_TIMEOUT_MS = 30_000;
// 存活探测只允许占用很短的时间：它挂在设置页刷新的同步路径上，超时即判死并触发重连。
export const MCP_PING_TIMEOUT_MS = 5_000;
export const MAX_MCP_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const MCP_STDIO_STDERR_LOG_MAX_CHARS = 4_000;
/**
 * span → request id 的暂存条数上限。正常情况下每条都会在同一次 tool call 结束时被取走，
 * 留下的只有无人认领的（如连接期请求），几十条足够，纯为防止长会话下无界增长。
 */
export const MAX_TRACKED_SERVER_REQUEST_IDS = 64;

export interface CreateMcpAdapterOptions {
  clientName?: string;
  clientVersion?: string;
  connectionContext?: McpConnectionContext;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  telemetry?: McpTelemetryTracker;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: import("./network.js").NetworkEgressEnvPolicy;
  /**
   * 官方 Server MCP 鉴权依赖。trustedOrigins 缺失时仍 fail closed；authHeadersPort
   * 可缺省，此时各请求匿名降级并交给服务端做权威判定。
   */
  officialMcpAuth?: {
    authHeadersPort?: OfficialMcpAuthHeadersPort;
    trustedOrigins: OfficialMcpTrustedOriginRegistry;
    /**
     * 当前 ZCode API origin。stdio 形态没有 `url` 可供校验，targetOrigin 只能由宿主给出
     * ——插件因此无法把身份头导向别的 origin。
     * 与 trustedOrigins 的 `resolveZCodeApiOrigin` 必须同源，否则两侧判定会分叉。
     */
    resolveZCodeApiOrigin?: () => string;
    workspaceIdentity?: string;
  };
  workingDirectory?: string;
}

export type McpClient = Client;
export type McpTransport =
  | StdioClientTransport
  | StreamableHTTPClientTransport
  | SSEClientTransport;
export type AuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/**
 * stdio 官方 MCP 的身份头载荷，随每条出站协议消息的 `_meta` 下发。
 *
 * 失败也下发（`ok: false` + 枚举 reason）；stdio 插件拿不到头时不会去打官方端点。HTTP 路径则
 * 由 adapter 发起无身份的 tools/call，让 ZCode server 返回权威结构化错误。把 reason 交给 stdio
 * 插件才能让它把"未登录"与"无 Coding Plan 套餐"如实呈现给用户，而不是静默降级成一句莫名其妙的失败。
 */
export type OfficialMcpAuthMetaPayload =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

export interface McpServerRecord {
  client?: McpClient;
  abortController?: AbortController;
  connecting?: Promise<McpServerStatus>;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: import("@zcode/contracts").McpToolDescriptor[];
  transport?: McpTransport;
}

export interface McpAdapterFields {
  adapterInstanceId: string;
  clientName: string;
  clientVersion: string;
  connectionContext?: McpConnectionContext;
  credentialStore?: SharedZCodeCredentialStore;
  connectionDiagnosticByServer: Map<
    string,
    Pick<McpServerStatus, "failureKind" | "serverRequestId">
  >;
  connectionGenerations: Map<string, number>;
  env?: NodeJS.ProcessEnv;
  lastOfficialAuthKind: Map<string, import("@zcode/shared").OfficialMcpAuthFailureKind>;
  logger?: Logger;
  mcpOAuth?: McpOAuthRuntimeOptions;
  network?: import("./network.js").NetworkEgressEnvPolicy;
  officialMcpAuth?: CreateMcpAdapterOptions["officialMcpAuth"];
  records: Map<string, McpServerRecord>;
  serverRequestIdBySpan: Map<string, string>;
  telemetry?: McpTelemetryTracker;
  workingDirectory?: string;
}
