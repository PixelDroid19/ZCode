import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  localTtftFactsSchema,
  localTtftNow,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { LocalTtftRecorder } from "./local-ttft.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

import type {
  BinaryReadCacheEntry,
  ConversationV4GatewayOptions,
  FlushState,
  HydrationBuffer,
  ProjectionEventCommitWaiter,
  RawSequenceState,
  V4GatewayHost,
} from "./v4-gateway-types.js";
import { defaultLogEpoch, rowTargetActionForCommand } from "./v4-gateway-utils.js";

export class ConversationV4GatewayState {
  protected readonly publishers = new Map<string, ConversationTopicPublisher>();
  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  protected readonly indexPublishers = new SessionsIndexPublisherRegistry();
  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  protected readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();
  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  protected readonly hydratedSessions = new Set<string>();
  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  protected readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();
  /** cold activation 到 hydration 的 READY 水位；只阻塞本次恢复期间的 command/query。 */
  protected readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();
  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  protected readonly hydrationBuffers = new Map<string, HydrationBuffer>();
  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  protected readonly rawSequenceStates = new Map<string, RawSequenceState>();
  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  protected readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();
  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  protected readonly detachedLiveSessions = new Set<string>();
  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  protected readonly detachedChildParent = new Map<string, string>();
  protected readonly detachedChildrenByParent = new Map<string, Set<string>>();
  protected readonly detachedTerminalAt = new Map<string, number>();
  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  protected readonly coldResume: ColdSessionResumeCoordinator;
  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  protected readonly flushStates = new Map<string, FlushState>();
  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  protected readonly controlReservations = new WeakSet<object>();
  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  protected readonly pausedConnections = new Set<string>();
  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  protected readonly projectionFaultedSessions = new Set<string>();
  protected readonly inbox: CommandInbox;
  protected readonly attachmentUploads: AttachmentUploadRegistry;
  protected readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();
  protected binaryReadCacheBytes = 0;
  protected readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );
  protected readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  protected readonly now: () => number;
  protected readonly createLogEpoch: (sessionId: string) => string;
  protected readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();
  protected readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();
  protected readonly telemetryEventIds = new Set<string>();
  protected disposed = false;

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */

  constructor(
    protected readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      getRevision: (sessionId) => {
        if (!this.host.sessionExists(sessionId)) return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }
}
