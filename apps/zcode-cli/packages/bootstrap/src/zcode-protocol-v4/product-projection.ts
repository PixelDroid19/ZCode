import type { SessionEvent } from "@zcode/contracts";
import type {
  ConversationDelta,
  ConversationSnapshot,
  CuaAppIdentity,
  MutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import { type ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import * as reducersBackgroundWork from "./product-projection-background-work.js";
import * as reducersCompaction from "./product-projection-compaction.js";
import * as reducersDispatch from "./product-projection-dispatch.js";
import * as reducersEventApplication from "./product-projection-event-application.js";
import * as reducersGoals from "./product-projection-goals.js";
import * as reducersHookReviews from "./product-projection-hook-reviews.js";
import * as reducersHooks from "./product-projection-hooks.js";
import type { ProductProjectionMethods } from "./product-projection-methods.js";
import * as reducersModelStreams from "./product-projection-model-streams.js";
import * as reducersModelUsage from "./product-projection-model-usage.js";
import * as reducersPermissions from "./product-projection-permissions.js";
import * as reducersQueueAdmission from "./product-projection-queue-admission.js";
import * as reducersQueueControl from "./product-projection-queue-control.js";
import * as reducersQueueDrain from "./product-projection-queue-drain.js";
import * as reducersRewind from "./product-projection-rewind.js";
import * as reducersRowState from "./product-projection-row-state.js";
import * as reducersSeeds from "./product-projection-seeds.js";
import * as reducersSubagentLifecycle from "./product-projection-subagent-lifecycle.js";
import * as reducersSubagentRows from "./product-projection-subagent-rows.js";
import {
  ContextWindowProjectionState,
  ConversationEditTarget,
  FileToolInputPreviewState,
  PendingSessionHookInvocation,
  TurnModelBaseline,
} from "./product-projection-support.js";
import * as reducersTargets from "./product-projection-targets.js";
import * as reducersToolResults from "./product-projection-tool-results.js";
import * as reducersToolRows from "./product-projection-tool-rows.js";
import * as reducersTurnCompletion from "./product-projection-turn-completion.js";
import * as reducersTurnStart from "./product-projection-turn-start.js";
import { createInitialConversationSnapshot } from "./projection-state.js";
export class ProductProjection {
  private snapshot: ConversationSnapshot;

  // reducer 内部的 rowId 查找必须与 rows.window 同步；冷恢复过去每次 find 都扫描全表，
  // tool/turn 终态越多退化越明显。普通归约增量维护，rewind 才重建。
  private rowIndexById = new Map<number, number>();

  private hydrationAccumulator: MutableConversationSnapshotAccumulator | null = null;

  private nextRowId = 1;

  private streamingTextRowId: number | null = null;

  private streamingReasoningRowId: number | null = null;

  // output-token Continue 是同一 product turn 内的请求级恢复，不应泄漏成新的正文行。
  // 这里只保留上一条满足 length/zero-tool/视觉紧邻条件的 text row，任何真实边界都会清空。
  private outputContinuationTextRowId: number | null = null;

  private toolRowIdByCallId = new Map<string, number>();

  private latestListAppsSnapshot = new Map<number, CuaAppIdentity>();

  // snapshot 是权威状态；该 Set 只是 TurnComplete 缺终态兜底的派生索引，避免每轮扫描全表。
  private openForegroundToolCallIds = new Set<string>();

  private fileToolInputPreviewByCallId = new Map<string, FileToolInputPreviewState>();

  private subagentRowIdByAgentId = new Map<string, number>();

  private hookRowIdByInvocationId = new Map<string, number>();

  // resume SessionStart 没有 turnId；先保留在 CLI projection，下一条真实 user-intent
  // TurnStarted 到达后再分配 rowId/turnId。不得构造 session-hooks:* synthetic turn。
  private pendingSessionHookInvocations = new Map<string, PendingSessionHookInvocation>();

  // rewind 后 async Hook 的 terminal 仍可能迟到；保留 invocation 墓碑，避免被删旧分支
  // 因找不到原 row 而被 terminal-only 兼容路径重新 append。
  private rewoundHookInvocationIds = new Set<string>();

  // 冷恢复 transcript 可能含旧版本先发布、后持久化失败的 ghost child。store seed 后
  // 必须持续排除，而不是只覆盖一次 snapshot；否则下一条无关事件会从历史 row 再物化它。
  private invalidSubagentChildSessionIds = new Set<string>();

  // rowId → 权威 messageId 侧表。forkAssistant/editUserQuery 的命令载荷用 rowId
  // 定位，但旧 fork/rewind operations 用 messageId（history target）——桥接层经本表翻译。
  // 不进 row schema（客户端只发 rowId，messageId 是服务端内部锚点，避免污染冻结的行结构）。
  private messageIdByRowId = new Map<number, string>();

  // Continue 复用 rowId 后，动作锚点推进到最后一条 assistant message；旧 partial messageId
  // 仍需能命中同一 row，供 compact coverage、rewind 和整轮文件事实恢复使用。
  private outputContinuationRowIdByMessageId = new Map<string, number>();

  private entityIdByRowId = new Map<number, string>();

  // canonical command target 只按稳定实体身份寻址；rowId 仅是本次 materialization 的
  // transient lookup，刷新/replay 后变化也不会改变 target identity。
  private editTargetByEntityId = new Map<string, ConversationEditTarget>();

  private currentEditableEntityId: string | null = null;

  private stableCompactCoverageBoundaryRowId: number | null = null;

  private turnHeaderRowIdByTurnId = new Map<string, number>();

  private compactMarkerRowIdByOperationId = new Map<string, number>();

  // goal verify boundary 身份 = targetId_goalIteration
  // （verificationId 仅 attempt alias——同 iteration 重试携带新 verificationId，
  // 旧实现按 verificationId keying 会长出第二个 marker）。
  private goalVerifyMarkerRowIdByLifecycleKey = new Map<string, number>();

  // queue drain 在同一 runtimeTurn 内切出新的
  // product turn。runtimeTurnId → 当前 productTurnId 映射；后续事件行经 turnIdOf
  // 归入最新 productTurn。steer（guide）不切轮，内联当前轮。
  private productTurnIdByRuntimeTurnId = new Map<string, string>();

  private runtimeTurnIdByProductTurnId = new Map<string, string>();

  private productTurnSplitOrdinalByRuntimeTurnId = new Map<string, number>();

  private currentProductTurnStartedAtMs: number | null = null;

  // 投递语义侧表：TurnSteerQueued 时按事件 payload（或 followupMode 兜底）记录，
  // drain 时决定切轮 vs 内联；账本落地后以账本为准。
  private deliveryByPendingInputId = new Map<string, "guide" | "queue">();

  private currentTurnId: string | null = null;

  // 当前 runtime turn 是否由 model-only TurnStarted 建立（manual /compact、
  // goal continuation 等维护 turn）。SessionStart 摘要的 pending 归位不得以维护
  // turn 为收口目标，必须等下一条 user-visible 真实 turn。
  private currentTurnStartedModelOnly = false;

  // contextWindow=null 时协议不暴露分母与已用量，但 reducer 仍需保留最新 context 用量，
  // 以便 registry 后续恢复已知容量时原子重建 usage，而不是错误归零。
  private contextWindowState: ContextWindowProjectionState = {
    maxTokens: null,
    touchedByEvent: false,
    usedTokens: 0,
  };

  // modelChange marker 在「下一个 turn 开始时」生成。
  // silentInitial 保持普通 Main 首轮静默；sourceLess 表示显式 ∅→X；known 保存上一轮
  // 实际使用的 provider/model。thought 只随基线记录，不触发模型身份变化。
  private lastTurnModel: TurnModelBaseline = { kind: "silentInitial" };

  // 种子守卫：事件（权威日志）触碰过的 config 区块不再接受种子覆盖。
  private configModelTouchedByEvent = false;

  // 旧 ModelSelected 不含能力集合；独立守卫允许 runtime seed 补齐旧日志，
  // 又避免后续种子覆盖新事件已原子发布的模型能力。
  private configThoughtLevelsTouchedByEvent = false;

  private configModeTouchedByEvent = false;

  // assistant 守恒：非运行期拒收的正文流计数（gateway 据此置 stale）。
  private droppedContentStreamEventCount = 0;

  // 读取期 legacy fallback 必须可观测；否则 normalizer 缺字段后仍会退化为“可见但不可寻址”。
  private normalizationDiagnostics: ConversationNormalizationDiagnostic[] = [];

  constructor(sessionId: string, logEpoch: string) {
    this.snapshot = createInitialConversationSnapshot(sessionId, logEpoch);
  }

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   */
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot) => boolean,
  ): ConversationDelta[] | null {
    const candidate = this.cloneProjection();
    const deltas = candidate.applyEvent(event);
    if (!accept(candidate.snapshot)) return null;
    this.adoptProjection(candidate);
    return deltas;
  }

  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.snapshot = this.snapshot;
    clone.rowIndexById = new Map(this.rowIndexById);
    clone.hydrationAccumulator = null;
    clone.nextRowId = this.nextRowId;
    clone.streamingTextRowId = this.streamingTextRowId;
    clone.streamingReasoningRowId = this.streamingReasoningRowId;
    clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
    clone.toolRowIdByCallId = new Map(this.toolRowIdByCallId);
    // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
    clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
    clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
    clone.fileToolInputPreviewByCallId = new Map(
      [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [
        toolCallId,
        { ...state },
      ]),
    );
    clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
    clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
    clone.pendingSessionHookInvocations = new Map(
      [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
        invocationId,
        {
          firstEvent: pending.firstEvent,
          content: {
            ...pending.content,
            executions: pending.content.executions.map((execution) => ({ ...execution })),
          },
        },
      ]),
    );
    clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
    clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
    clone.messageIdByRowId = new Map(this.messageIdByRowId);
    clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
    clone.entityIdByRowId = new Map(this.entityIdByRowId);
    clone.editTargetByEntityId = new Map(this.editTargetByEntityId);
    clone.currentEditableEntityId = this.currentEditableEntityId;
    clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
    clone.turnHeaderRowIdByTurnId = new Map(this.turnHeaderRowIdByTurnId);
    clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
    clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
    clone.productTurnIdByRuntimeTurnId = new Map(this.productTurnIdByRuntimeTurnId);
    clone.runtimeTurnIdByProductTurnId = new Map(this.runtimeTurnIdByProductTurnId);
    clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
      this.productTurnSplitOrdinalByRuntimeTurnId,
    );
    clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
    clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
    clone.currentTurnId = this.currentTurnId;
    clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
    clone.contextWindowState = { ...this.contextWindowState };
    clone.lastTurnModel = { ...this.lastTurnModel };
    clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
    clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
    clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
    clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
    clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
    return clone;
  }

  private adoptProjection(candidate: ProductProjection): void {
    this.snapshot = candidate.snapshot;
    this.rowIndexById = candidate.rowIndexById;
    this.hydrationAccumulator = null;
    this.nextRowId = candidate.nextRowId;
    this.streamingTextRowId = candidate.streamingTextRowId;
    this.streamingReasoningRowId = candidate.streamingReasoningRowId;
    this.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
    this.toolRowIdByCallId = candidate.toolRowIdByCallId;
    this.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
    this.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
    this.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
    this.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
    this.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
    this.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
    this.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
    this.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
    this.messageIdByRowId = candidate.messageIdByRowId;
    this.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
    this.entityIdByRowId = candidate.entityIdByRowId;
    this.editTargetByEntityId = candidate.editTargetByEntityId;
    this.currentEditableEntityId = candidate.currentEditableEntityId;
    this.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
    this.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
    this.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
    this.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
    this.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
    this.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
    this.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
    this.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
    this.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
    this.currentTurnId = candidate.currentTurnId;
    this.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
    this.contextWindowState = candidate.contextWindowState;
    this.lastTurnModel = candidate.lastTurnModel;
    this.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
    this.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
    this.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
    this.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
    this.normalizationDiagnostics = candidate.normalizationDiagnostics;
  }

  declare getSnapshot: ProductProjectionMethods["getSnapshot"];
  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  declare getDroppedContentStreamEventCount: ProductProjectionMethods["getDroppedContentStreamEventCount"];

  declare getNormalizationDiagnostics: ProductProjectionMethods["getNormalizationDiagnostics"];
  /** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
  declare establishedStreamingAppend: ProductProjectionMethods["establishedStreamingAppend"];
  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */
  declare seedConfig: ProductProjectionMethods["seedConfig"];
  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */
  declare seedSharedContextImport: ProductProjectionMethods["seedSharedContextImport"];

  declare seedUsage: ProductProjectionMethods["seedUsage"];
  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */
  declare seedSubagents: ProductProjectionMethods["seedSubagents"];
  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  declare getMessageIdForRow: ProductProjectionMethods["getMessageIdForRow"];

  declare getEntityIdForRow: ProductProjectionMethods["getEntityIdForRow"];

  declare resolveEditTarget: ProductProjectionMethods["resolveEditTarget"];

  declare resolveEditTargetByEntityId: ProductProjectionMethods["resolveEditTargetByEntityId"];
  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */
  declare resolveRowActionTarget: ProductProjectionMethods["resolveRowActionTarget"];
  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */
  declare getMessageIdsForTurnRow: ProductProjectionMethods["getMessageIdsForTurnRow"];
  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */
  declare isLatestAssistantSegmentRow: ProductProjectionMethods["isLatestAssistantSegmentRow"];
  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */
  declare resolveStableForkCandidate: ProductProjectionMethods["resolveStableForkCandidate"];
  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
  declare isLatestRetryAssistantRow: ProductProjectionMethods["isLatestRetryAssistantRow"];
  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
  declare isLatestEditableUserRow: ProductProjectionMethods["isLatestEditableUserRow"];
  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
  declare getTurnIdForRow: ProductProjectionMethods["getTurnIdForRow"];
  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
  declare applyEvent: ProductProjectionMethods["applyEvent"];
  /**
   * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
   * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
   */
  declare beginHydrationReplay: ProductProjectionMethods["beginHydrationReplay"];

  declare applyHydrationEvent: ProductProjectionMethods["applyHydrationEvent"];
  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */
  declare completeHydrationReplay: ProductProjectionMethods["completeHydrationReplay"];

  declare private applyEventInternal: ProductProjectionMethods["applyEventInternal"];
  /**
   * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
   * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
   * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
   */
  declare private materializeCommandRowActions: ProductProjectionMethods["materializeCommandRowActions"];

  declare private attachRevision: ProductProjectionMethods["attachRevision"];

  declare private reduce: ProductProjectionMethods["reduce"];
  /** A persisted started-only Hook cannot still be running after a real runtime resume. */
  declare private onSessionResumed: ProductProjectionMethods["onSessionResumed"];

  declare private onHookRunLifecycle: ProductProjectionMethods["onHookRunLifecycle"];
  /**
   * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
   * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
   * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
   */
  declare private hookBlockErrorDelta: ProductProjectionMethods["hookBlockErrorDelta"];

  declare private flushPendingSessionHookInvocations: ProductProjectionMethods["flushPendingSessionHookInvocations"];

  declare private hookExecutionState: ProductProjectionMethods["hookExecutionState"];

  declare private hookExecutionOutcome: ProductProjectionMethods["hookExecutionOutcome"];

  declare private hookInvocationState: ProductProjectionMethods["hookInvocationState"];

  declare private hookInvocationLane: ProductProjectionMethods["hookInvocationLane"];
  /**
   * rewind/edit/retry 的 live 投影截断（editUserQuery/retryTurn 的
   * `row.removed(target 起)`）。RewindTriggered 带 targetMessageId → 反查 rowId →
   * 从该行所属 turn 的首行（turnHeader）起整段移除，让 live 订阅者即时看到截断，
   * 后续 editRerun 新 turn 走既有事件路径追加。冷订阅/刷新的 truncated transcript
   * 由 transcript 合成 hydration 兜底重建。
   * messageId 反查不到（user 行暂无 messageId、或迟到）时返回空，不误删。
   */
  declare private onRewindTriggered: ProductProjectionMethods["onRewindTriggered"];
  /** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
  declare private rowIdForMessageId: ProductProjectionMethods["rowIdForMessageId"];
  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */
  declare getTurnRewindAnchor: ProductProjectionMethods["getTurnRewindAnchor"];

  declare private rewindAnchorForRows: ProductProjectionMethods["rewindAnchorForRows"];
  /**
   * real-user row 的展示身份与命令身份必须原子登记。
   * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
   * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
   */
  declare private registerCanonicalUserRowTarget: ProductProjectionMethods["registerCanonicalUserRowTarget"];

  declare private onSessionCreated: ProductProjectionMethods["onSessionCreated"];

  declare private onSessionTitleUpdated: ProductProjectionMethods["onSessionTitleUpdated"];

  declare private onTurnStarted: ProductProjectionMethods["onTurnStarted"];

  declare private applyBackgroundTaskNotification: ProductProjectionMethods["applyBackgroundTaskNotification"];

  declare private onTurnComplete: ProductProjectionMethods["onTurnComplete"];
  /**
   * draft 只有一种离场方式：第一轮收口。phase `draft` 的定义是「纯内存、从未有过真实内容、CLI 重启即
   * 消失」；一条 controlOnly 轮一旦收口，会话已有一段持久化的可见历史，再叫 draft 就与
   * 冷恢复矛盾——store 种子会给它一个终态 phase，而活投影却停在 draft。中枢直接启动
   * 的会话只有一条 controlOnly 启动轮，活投影 phase 恒为 draft，sessions-index 摘要因此被 task-index
   * syncer 当 draft 丢弃，侧栏要等重启才出现。所以 controlOnly 收口只在**会话仍是 draft**时推进 phase
   * （成功 → completedSuccess，取消 → completedInterrupted，失败 → error）；非 draft 会话上的控制轮
   * 照旧不碰 session control（goal 的可见 query 轮不得伪造 running / 工时，见 onTurnStarted）。
   */
  declare private leaveDraftAfterControlOnlyTurn: ProductProjectionMethods["leaveDraftAfterControlOnlyTurn"];

  declare private onTurnError: ProductProjectionMethods["onTurnError"];

  declare private onModelNetworkStatus: ProductProjectionMethods["onModelNetworkStatus"];

  declare private onStreamRecoveryStarted: ProductProjectionMethods["onStreamRecoveryStarted"];

  declare private onStreamRecoveryTailDiscarded: ProductProjectionMethods["onStreamRecoveryTailDiscarded"];

  declare private onStreamRecoveryRetryStarted: ProductProjectionMethods["onStreamRecoveryRetryStarted"];

  declare private streamRecoveryApiRetry: ProductProjectionMethods["streamRecoveryApiRetry"];

  declare private setApiRetry: ProductProjectionMethods["setApiRetry"];

  declare private acceptsActiveModelEvent: ProductProjectionMethods["acceptsActiveModelEvent"];

  declare private onModelStreaming: ProductProjectionMethods["onModelStreaming"];

  declare private openTextRow: ProductProjectionMethods["openTextRow"];

  declare private closeTextRow: ProductProjectionMethods["closeTextRow"];

  declare private onAssistantFeedbackUpdated: ProductProjectionMethods["onAssistantFeedbackUpdated"];

  declare private openReasoningRow: ProductProjectionMethods["openReasoningRow"];

  declare private closeReasoningRow: ProductProjectionMethods["closeReasoningRow"];

  declare private closeStreamingRows: ProductProjectionMethods["closeStreamingRows"];

  declare private closeOpenToolRows: ProductProjectionMethods["closeOpenToolRows"];

  declare private isOpenForegroundToolRow: ProductProjectionMethods["isOpenForegroundToolRow"];

  declare private updateToolIndexesAfterDeltas: ProductProjectionMethods["updateToolIndexesAfterDeltas"];

  declare private pruneRemovedSubagentIndexes: ProductProjectionMethods["pruneRemovedSubagentIndexes"];

  declare private openToolRow: ProductProjectionMethods["openToolRow"];

  declare private appendStreamingToolInput: ProductProjectionMethods["appendStreamingToolInput"];

  declare private flushStreamingToolInput: ProductProjectionMethods["flushStreamingToolInput"];

  declare private takePendingStreamingToolInput: ProductProjectionMethods["takePendingStreamingToolInput"];

  declare private finalizeStreamingToolInput: ProductProjectionMethods["finalizeStreamingToolInput"];

  declare private onToolCallScheduled: ProductProjectionMethods["onToolCallScheduled"];

  declare private onToolCallActivity: ProductProjectionMethods["onToolCallActivity"];

  declare private onToolCallResult: ProductProjectionMethods["onToolCallResult"];
  /**
   * TodoWrite 同时投影 live plan 与当前 goal iteration。
   * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
   * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
   */
  declare private todoPlanDeltas: ProductProjectionMethods["todoPlanDeltas"];

  declare private onToolCallError: ProductProjectionMethods["onToolCallError"];

  declare private onPermissionRequested: ProductProjectionMethods["onPermissionRequested"];

  declare private createPendingInteractionFromPermissionEvent: ProductProjectionMethods["createPendingInteractionFromPermissionEvent"];

  declare private onPermissionResolved: ProductProjectionMethods["onPermissionResolved"];

  declare private onPermissionDenied: ProductProjectionMethods["onPermissionDenied"];

  declare private onWorkspaceHookReviewRequested: ProductProjectionMethods["onWorkspaceHookReviewRequested"];

  declare private onWorkspaceHookReviewSettled: ProductProjectionMethods["onWorkspaceHookReviewSettled"];

  declare private onWorkspaceHookReviewSuperseded: ProductProjectionMethods["onWorkspaceHookReviewSuperseded"];

  declare private removeWorkspaceHookReview: ProductProjectionMethods["removeWorkspaceHookReview"];
  /**
   * 软门禁:处理 WorkspaceHookAdmissionUpdated 事件。
   *
   * pendingCount > 0 → 写入 snapshot.workspaceHookAdmission(提示条出现);
   * pendingCount === 0 → 置 null(提示条消失)。
   */
  declare private onWorkspaceHookAdmissionUpdated: ProductProjectionMethods["onWorkspaceHookAdmissionUpdated"];

  declare private onUserInputAutoResolutionUpdated: ProductProjectionMethods["onUserInputAutoResolutionUpdated"];

  declare private settlePermission: ProductProjectionMethods["settlePermission"];

  declare private onTurnSteerQueued: ProductProjectionMethods["onTurnSteerQueued"];

  declare private onTurnSteerDispatchChanged: ProductProjectionMethods["onTurnSteerDispatchChanged"];

  declare private onTurnSteerDeliveryChanged: ProductProjectionMethods["onTurnSteerDeliveryChanged"];

  declare private onTurnSteerDrained: ProductProjectionMethods["onTurnSteerDrained"];
  /**
   * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
   * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
   * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
   */
  declare private splitProductTurn: ProductProjectionMethods["splitProductTurn"];

  declare private activeMsForCompletion: ProductProjectionMethods["activeMsForCompletion"];

  declare private onTurnSteerDiscarded: ProductProjectionMethods["onTurnSteerDiscarded"];

  declare private onSessionInputPromoted: ProductProjectionMethods["onSessionInputPromoted"];
  /** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
  declare private onTurnSteerReordered: ProductProjectionMethods["onTurnSteerReordered"];

  declare private onQueueAutoDrainChanged: ProductProjectionMethods["onQueueAutoDrainChanged"];

  declare private onFollowupModeChanged: ProductProjectionMethods["onFollowupModeChanged"];
  /**
   * switchCollaborationMode：SessionModeChanged → config.mode。
   * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
   * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
   */
  declare private onSessionModeChanged: ProductProjectionMethods["onSessionModeChanged"];
  /**
   * Subagent row 与摘要投影在同一个 event transaction 内 materialize。
   * 旧 UI 在 spawn 后另查 session/subagents；7 个并发 child 中查询若恰好落在
   * 最后一个 session 持久化前，就会永久缓存 6，直到切换 Session 才重查。现在 renderer
   * 只消费这里随 row 一起提交的完整态，不再存在事件/查询双时钟。
   */
  declare private shouldMaterializeSubagentProjection: ProductProjectionMethods["shouldMaterializeSubagentProjection"];

  declare private materializeSubagentProjection: ProductProjectionMethods["materializeSubagentProjection"];

  declare private prospectiveSubagentRow: ProductProjectionMethods["prospectiveSubagentRow"];

  declare private onSubagentSpawned: ProductProjectionMethods["onSubagentSpawned"];

  declare private resumedSubagentBackgroundWorkDelta: ProductProjectionMethods["resumedSubagentBackgroundWorkDelta"];

  declare private onSubagentMessage: ProductProjectionMethods["onSubagentMessage"];

  declare private onSubagentStopped: ProductProjectionMethods["onSubagentStopped"];

  declare private onBackgroundTaskLifecycle: ProductProjectionMethods["onBackgroundTaskLifecycle"];

  declare private onDynamicWorkflowRunProgress: ProductProjectionMethods["onDynamicWorkflowRunProgress"];

  declare private removeQueueItems: ProductProjectionMethods["removeQueueItems"];

  declare private onModelSelected: ProductProjectionMethods["onModelSelected"];

  declare private onModelComplete: ProductProjectionMethods["onModelComplete"];

  declare private onCompactLifecycle: ProductProjectionMethods["onCompactLifecycle"];

  declare private onTargetChanged: ProductProjectionMethods["onTargetChanged"];

  declare private onTargetVerification: ProductProjectionMethods["onTargetVerification"];
  /** goal verify boundary 身份：targetId_goalIteration。 */
  declare private goalVerifyLifecycleKey: ProductProjectionMethods["goalVerifyLifecycleKey"];

  declare private goalVerifyTurnId: ProductProjectionMethods["goalVerifyTurnId"];

  declare private onSessionForked: ProductProjectionMethods["onSessionForked"];

  declare private controlPatch: ProductProjectionMethods["controlPatch"];

  declare private goalPatch: ProductProjectionMethods["goalPatch"];

  declare private queuePatch: ProductProjectionMethods["queuePatch"];

  declare private deriveContext: ProductProjectionMethods["deriveContext"];

  declare private upsertTurnHeader: ProductProjectionMethods["upsertTurnHeader"];

  declare private openGuidedWorkSegment: ProductProjectionMethods["openGuidedWorkSegment"];

  declare private completeWorkSegments: ProductProjectionMethods["completeWorkSegments"];

  declare private turnHeaderForEvent: ProductProjectionMethods["turnHeaderForEvent"];

  declare private markStableForkAssistant: ProductProjectionMethods["markStableForkAssistant"];

  declare private isRunning: ProductProjectionMethods["isRunning"];

  declare private isMirroredSubagentToolEvent: ProductProjectionMethods["isMirroredSubagentToolEvent"];

  declare private openAssistantSegments: ProductProjectionMethods["openAssistantSegments"];

  declare private openSegmentIdentity: ProductProjectionMethods["openSegmentIdentity"];

  declare private rowBase: ProductProjectionMethods["rowBase"];

  declare private turnIdOf: ProductProjectionMethods["turnIdOf"];

  declare private ms: ProductProjectionMethods["ms"];

  declare private findRow: ProductProjectionMethods["findRow"];

  declare private updateRowIndexAfterImmutableApply: ProductProjectionMethods["updateRowIndexAfterImmutableApply"];

  declare private findToolRow: ProductProjectionMethods["findToolRow"];

  declare private findSubagentRow: ProductProjectionMethods["findSubagentRow"];

  declare private findSubagentLifecycleRow: ProductProjectionMethods["findSubagentLifecycleRow"];

  declare private subagentAgentId: ProductProjectionMethods["subagentAgentId"];

  declare private stringPayload: ProductProjectionMethods["stringPayload"];

  declare private mapSubagentStatus: ProductProjectionMethods["mapSubagentStatus"];
}

// 保留 class 方法的 prototype 描述符；所有 reducer 仍操作同一个实例。
for (const methods of [
  reducersSeeds,
  reducersTargets,
  reducersEventApplication,
  reducersDispatch,
  reducersHooks,
  reducersRewind,
  reducersTurnStart,
  reducersTurnCompletion,
  reducersModelStreams,
  reducersToolRows,
  reducersToolResults,
  reducersPermissions,
  reducersHookReviews,
  reducersQueueAdmission,
  reducersQueueDrain,
  reducersQueueControl,
  reducersSubagentRows,
  reducersSubagentLifecycle,
  reducersBackgroundWork,
  reducersModelUsage,
  reducersCompaction,
  reducersGoals,
  reducersRowState,
]) {
  for (const [name, method] of Object.entries(methods)) {
    Object.defineProperty(ProductProjection.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
  }
}
export type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
  StableForkCandidate,
  StableForkCandidateResolution,
} from "./product-projection-support.js";
