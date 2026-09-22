import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { loadPersistentCommandFacts } from "../zcode-protocol-v4/persistent-command-facts.js";
import { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import { type SessionId } from "@zcode/contracts";
import { createProtocolLogger, type ZCodeProtocolAgentServerContext } from "./server-types.js";
import { createV4BridgeAutoDrain } from "./v4-bridge-auto-drain.js";
import {
  createV4BridgeCoreHostFoundation,
  createV4BridgeCoreHostProjection,
} from "./v4-bridge-core-host.js";
import { createV4BridgeCoreHostAdmission } from "./v4-bridge-core-admission.js";
import { createV4BridgeCoreHostSessions } from "./v4-bridge-core-sessions.js";
import {
  createV4BridgeGatewayCommandApi,
  createV4BridgeGatewaySessionApi,
  createV4BridgeStoredSessionSummaryLoader,
} from "./v4-bridge-gateway-api.js";
import { createV4BridgeGatewayHydration } from "./v4-bridge-hydration.js";

// v4 网关 binder。
// 定位：ConversationV4Gateway 是域无关的通道运行时，本文件把它绑到协议服务器上下文：
// - 帧出口 = context.notify（stdio NDJSON notification，与旧 session/event 同一条管道并存）；
// - 命令执行 = V4CommandExecutor（zcode-protocol-v4/commands/，原生直驱 core）；
//   20 命令全部原生，supports() 未命中（未知命令）→ notImplemented。
// - 过渡钩子（ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession）在此注入旧协议实现，随旧协议一同删除。
//
// 不做桥接：依赖方向只允许 旧目录 → v4 目录。
// 本文件在旧目录，import v4 executor 合法；v4 目录禁止反向 import 本目录任何模块。
export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const { autoDrainV4QueueIfReady } = createV4BridgeAutoDrain(context, () => nativeExecutor);
  const coreHost: V4CommandCoreHost = {
    ...createV4BridgeCoreHostFoundation(context),
    ...createV4BridgeCoreHostAdmission({ context, persistentCommands }),
    ...createV4BridgeCoreHostProjection(context),
    ...createV4BridgeCoreHostSessions({ autoDrainV4QueueIfReady, context }),
  };
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = createV4BridgeStoredSessionSummaryLoader(context);
  return new ConversationV4Gateway({
    ...createV4BridgeGatewaySessionApi({
      autoDrainV4QueueIfReady,
      context,
      loadStoredSessionSummaries,
      log,
    }),
    ...createV4BridgeGatewayCommandApi({
      context,
      coreHost,
      nativeExecutor,
      persistentCommands,
    }),
    ...createV4BridgeGatewayHydration({ context, log }),
  });
}
