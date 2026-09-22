import { computeScopeUnion } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "@zcode/contracts";
import type { AuthorizationCodeOAuthConfig } from "./adapter-types.js";
import { McpAdapterCleanup } from "./adapter-cleanup.js";
import { createMcpTransportFetch } from "./network.js";
import { createCredentialKeyPrefix } from "./oauth.js";
import { loadCredentialPair } from "./oauth-credentials.js";
import {
  MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
  runMcpInteractiveAuthorization,
  type McpInteractiveAuthorizationOutcome,
} from "./oauth-interactive.js";
import type { InteractiveAuthorizationTrigger } from "./oauth-errors.js";
import { createSharedZCodeCredentialStore } from "../auth/shared-credentials.js";

export abstract class McpAdapterInteractive extends McpAdapterCleanup {
  protected async runInteractiveOAuthAuthorization(input: {
    config: Extract<McpServerConfig, { type: "http" | "sse" }>;
    generation: number;
    name: string;
    oauthConfig: AuthorizationCodeOAuthConfig;
    serverUrl: string;
    signal: AbortSignal;
    trigger: InteractiveAuthorizationTrigger;
  }): Promise<McpInteractiveAuthorizationOutcome> {
    try {
      const oauthOptions = this.createAuthorizationCodeOAuthOptions(
        input.config,
        input.name,
        input.generation,
      );
      const credentialStore = oauthOptions?.credentialStore ?? createSharedZCodeCredentialStore();
      const keyPrefix = createCredentialKeyPrefix(input.name, input.serverUrl, input.oauthConfig);
      // 403 step-up 的最终 scope 必须是 config ∪ token.scope ∪ challenge
      // 的并集。只带 challenge scope 重新授权时，授权服务器可能按新请求收回先前授予的 scope，
      // 下一个请求换个 challenge 又 403，形成重授权乒乓。token response 的 scope 允许缺失
      // （RFC 6749 §3.3），所以配置里声明过的 scope 必须显式并入，不能只看 token 回显。
      let requestedScope: string | undefined = input.oauthConfig.scope;
      if (input.trigger.requiredScope) {
        const currentPair = await loadCredentialPair(credentialStore, keyPrefix);
        requestedScope = computeScopeUnion(
          input.oauthConfig.scope,
          currentPair?.tokens?.scope,
          input.trigger.requiredScope,
        );
      }
      return await runMcpInteractiveAuthorization({
        adapterInstanceId: this.adapterInstanceId,
        config: input.oauthConfig,
        credentialStore,
        fetchFn: createMcpTransportFetch({ env: this.env, network: this.network }),
        // 403 step-up：requiredScope 是当前 token scope 的严格超集时 refresh 无法扩权
        // （RFC 6749 §6），必须强制重新授权，否则新 scope 会被静默丢弃并再次 403。
        ...(input.trigger.reason === "insufficient_scope" ? { forceReauthorization: true } : {}),
        keyPrefix,
        logger: this.logger,
        ...(oauthOptions?.onAuthorizationRequired
          ? { onAuthorizationRequired: oauthOptions.onAuthorizationRequired }
          : {}),
        ...(oauthOptions?.openAuthorizationUrl
          ? { openAuthorizationUrl: oauthOptions.openAuthorizationUrl }
          : {}),
        ...(requestedScope ? { requestedScope } : {}),
        ...(input.trigger.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(input.trigger.resourceMetadataUrl) }
          : {}),
        serverName: input.name,
        serverUrl: input.serverUrl,
        signal: input.signal,
        transactionTtlMs: MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS,
      });
    } catch (error) {
      // 本方法的返回类型已经把编排失败建模为 outcome。过去 credential load、
      // authz lease 或 follower callback 的异常会裸 reject，绕过 failConnection，留下
      // status=connecting + rejected record.connecting，并让 connectConfiguredServers 整批失败。
      this.logger?.warn("MCP OAuth authorization orchestration failed", {
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : "unknown",
        event: "mcp.oauth.authorization.orchestration_failed",
        mcpServerName: input.name,
        status: "failed",
      });
      return { status: "failed", error };
    }
  }
}
