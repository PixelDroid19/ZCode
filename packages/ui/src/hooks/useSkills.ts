import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import {
  capabilityStatusError,
  capabilityStatusRefreshSignal,
} from "@/hooks/capabilityStatusRefresh.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface ConversationSkillCatalogState {
  skills: ZCodeSkillReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface ScopedConversationSkillCatalogState {
  authorityScope: object | null;
  requestScope: object | null;
  value: ConversationSkillCatalogState;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  loading: false,
  error: null,
};

const EMPTY_SCOPED_STATE: ScopedConversationSkillCatalogState = {
  authorityScope: null,
  requestScope: null,
  value: EMPTY_STATE,
};

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string;
}

/**
 * Composer 的 Skill catalog。
 * 无 prewarm 的 draft 以 workspace 当前扫描为 authority；prewarm/已有 Session 以对应
 * AgentRuntime 冻结快照为 authority。workspace/session/remote attachment/runtime 代次变化时，
 * 旧异步结果一律不得回填。
 */
export function useSkills(options: UseSkillsOptions): ConversationSkillCatalogState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.preferredRemoteSessionId,
    options.workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedConversationSkillCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  const capabilityStatusSignalRef = useRef<string | null>(null);
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options.preferredRemoteSessionId ?? undefined;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${options.sessionId ?? "draft"}|runtime:${runtimeRevision}`;
  // The authority scope intentionally excludes the runtime revision. A revision refresh may keep
  // the current session catalog on screen, while a service/workspace/session change must blank it.
  // Picker 开关只控制请求生命周期，不改变 catalog authority；把 enabled 放进依赖会让关闭再打开时
  // 产生新 scope，last-good 条目在刷新完成前消失。
  const authorityScope = useMemo(
    () => ({}),
    [
      options.sessionId,
      options.workspaceIdentity,
      options.workspacePath,
      remoteSessionId,
      rpcReady,
      services,
    ],
  );

  useEffect(() => {
    if (!options.enabled || !options.sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // runtime 重建后 workspace/session key 不变，旧 catalog 会继续命中。
      // 显式推进代次，使冷恢复后的新 runtime 必须重新提供一次 Session authority。
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [options.enabled, options.sessionId, rpcReady, services, workspaceKey]);

  useEffect(() => {
    const sessionId = options.sessionId;
    if (!options.enabled || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onDynamicCapabilitiesChanged({
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    })((event) => {
      const signal = capabilityStatusRefreshSignal(
        {
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(remoteSessionId ? { remoteSessionId } : {}),
          sessionId,
        },
        event,
      );
      if (!signal || signal === capabilityStatusSignalRef.current) return;
      capabilityStatusSignalRef.current = signal;
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    remoteSessionId,
    rpcReady,
    services,
  ]);

  // 用 scope 身份隔离渲染：key 切换后的 effect 尚未执行时也只返回空态，避免旧 Session
  // 或旧 remote attachment 的 Skill 在一帧内泄漏到新 Composer。
  const requestScope = useMemo(() => ({}), [authorityScope, requestKey]);

  useEffect(() => {
    if (!options.enabled || !options.workspacePath || !rpcReady) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState((current) => {
      const retained = current.authorityScope === authorityScope ? current.value : EMPTY_STATE;
      return {
        authorityScope,
        requestScope,
        value: { ...retained, loading: true, error: null },
      };
    });
    const params = {
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
    services.zcodeAgentService
      .getSkillReferenceCatalog(params)
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          authorityScope,
          requestScope,
          value: {
            skills: result.skills,
            authority: result.authority,
            loading: false,
            error: capabilityStatusError(result.capabilityStatus),
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useSkills] 拉取对话 Skill catalog 失败", {
          error: message,
          requestKey,
        });
        setScopedState((current) => {
          if (current.authorityScope !== authorityScope || current.requestScope !== requestScope) {
            return current;
          }
          return {
            ...current,
            value: { ...current.value, loading: false, error: message },
          };
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    authorityScope,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
  ]);

  if (
    !options.enabled ||
    !options.workspacePath ||
    !rpcReady ||
    scopedState.authorityScope !== authorityScope
  ) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
