import type { SessionId, WorkflowEscalatePort, WorkflowSubmitPort } from "@zcode/contracts";
import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import {
  createActorModelActivity,
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import type { ModelFailureHost } from "./workflow-driver-model-failure.js";
import type { EscalationHost } from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  mapViolations,
  mintActorSessionId,
  schemaEpilogue,
} from "./workflow-driver-helpers.js";
import { seedActorSession } from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";
import {
  createActorSessionQuiescence,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";

export abstract class AgentRuntimeWorkflowDriverSession {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  protected readonly sink: WorkflowReportSink;
  protected readonly deps: AgentRuntimeWorkflowDriverDeps;
  protected readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → 其所属会话，供 respondToSubmit / cancelAsk 反查。 */
  protected readonly instanceToSession = new Map<string, SessionState>();
  /** qid → 停驻它的会话，供 respondToEscalation 反查（与 instanceToSession 同族）。 */
  protected readonly qidToSession = new Map<string, SessionState>();
  /** per-run 单调的升级序号；qid 的第二段。与 runId 一起构成无碰撞的 id。 */
  protected escalationSeq = 0;
  /** dispose 幂等门（引擎契约是恰好一次，但门在这里更便宜也更稳）。 */
  protected disposed = false;
  /** 本 run 对治理器 cap 变化的订阅（run 级一次，dispose 时退订）。 */
  protected readonly concurrencyUnsubscribe?: () => void;
  /**
   * 交给升级桥接（workflow-driver-escalation.ts）的宿主面：两张表按引用共享，序号与 record
   * 经闭包回到本类——私有状态不外露，桥接函数也不需要知道类的形状。
   */
  protected readonly escalationHost: EscalationHost;
  /** 交给模型侧失败收容（workflow-driver-model-failure.ts）的宿主面：同一套按引用共享的思路。 */
  protected readonly modelFailureHost: ModelFailureHost;
  /** run 级 stall 时钟：所有 actor 的成功 / 重试节拍汇到这一只表。 */
  protected readonly stallClock: RunStallClock;
  protected readonly quiescence: ActorSessionQuiescenceLedger;

  protected abstract makeSubmitPort(sessionId: SessionId): WorkflowSubmitPort;
  protected abstract makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort;
  protected abstract runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void;
  protected abstract withdrawEscalations(state: SessionState): void;
  protected abstract record(event: RunEvent): void;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // 引擎结算是 ask 的唯一终点；保持事件引用不变供 journal sequence capture 校验。
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
      // 扇出只到在该 key 上有在飞/排队请求的 run，所以订阅本身可以在构造时一次做完。
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  async createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    const sessionId = mintActorSessionId(this.deps.runId ?? "run", actor);
    // resume 会话身份互证：journal 的 dwf_actor.session_id 是**记录**，铸造函数才是权威
    // （按 (runId, actorRef) 纯确定，重挂时必然铸出同一个 id）。两者不一致只可能是铸造规则
    // 漂移（改名/第二处实现）——后果是重水化读错会话、详情页打开不存在的会话，离成因很远，
    // 所以在重挂的第一步就大声失败，携结构化 mismatch（与两个哈希不匹配错误同形）。
    const journaled = this.journal.getActor(
      this.deps.runId ?? "run",
      actor.siteId,
      actor.ordinal,
    )?.sessionId;
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError(
        "DriverError",
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
          `id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } },
      );
    }
    const ref: SessionRef = { id: sessionId };
    // 会话级 submit 端口：closure 绑定本会话，模型无法覆盖路由身份（instance 取自 currentInstance）。
    const submitPort = this.makeSubmitPort(sessionId);
    // 升级端口同构：同样按会话 closure 绑定，同样恒注入（见 ActorRuntimeFactory 的字段注释）。
    // persona 一并入 closure：有效名是**冻结**的（引擎在 createActor 时定下，此后不变），
    // 所以在这里算一次比每次 escalate 现查便宜，也不会中途换名。
    const escalatePort = this.makeEscalatePort(sessionId, actor, persona);
    // 模型活动面：准入端口随 runtime deps 下传（runner 每次尝试先过闸门），
    // waiting / executing 观察只在有在飞 ask、且它还没被引擎结算/取消时上报——迟到的观察对一个
    // 已完结的 ask 没有意义，引擎侧也会再挡一次。state 在下面才建，所以经 closure 晚绑定。
    let state: SessionState | undefined;
    const live = (): InstanceRef | undefined =>
      state === undefined ||
      state.currentInstance === undefined ||
      state.accepted ||
      state.cancelled
        ? undefined
        : state.currentInstance;
    const modelActivity = createActorModelActivity({
      port: this.deps.concurrency,
      runId: this.deps.runId ?? "run",
      live,
      ...(this.deps.seatGate === undefined
        ? {}
        : { seat: { gate: this.deps.seatGate, key: refToString(actor) } }),
      handlers: {
        // 子代理的第一笔工作区写入 ⇒ 引擎关导入缓存。
        onMutating: (instance) => this.sink.askMutating(instance),
        onWaiting: (info) => {
          const instance = live();
          if (instance !== undefined) this.sink.askWaiting(instance, info);
        },
        onExecuting: () => {
          const instance = live();
          if (instance !== undefined) this.sink.askExecuting(instance);
        },
        // run 级 stall 时钟的两个节拍：任一 actor 的成功归零、任一重试上膛。
        onRequestCompleted: () => this.stallClock.noteSuccess(),
        onRetryScheduled: (reason) => this.stallClock.noteRetryScheduled(reason),
      },
    });
    // submit profile：按 actor **站点**查——同一站点
    // 的每个 ordinal（fan-out 的每条 lane）跑的是同一组 ask 站点，profile 自然相同。缺席 = generic。
    const submitProfile =
      this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
    // await：生产工厂在返回前把会话落库并建 task link（FK 要求 session 行先存在）。
    // 引擎的 ensureSession 会 await 本方法，所以第一次 ask 派发前持久化已完成。
    const runtime = await this.deps.runtimeFactory({
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    if (seed !== undefined) {
      await seedActorSession(this.deps, {
        journaledSessionId: journaled,
        runtime,
        seed,
        sessionId,
      });
    }
    state = {
      ref,
      sessionId,
      runtime,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      turnGeneration: 0,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      modelActivity,
      actor,
      actorName: effectiveActorName(persona),
      transientAttempts: 0,
    };
    modelActivity.observe(runtime, sessionId);
    this.sessions.set(sessionId, state);
    return ref;
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      // 理论不会发生（引擎先建会话再 ask）；归一成 DriverError 上报而非静默。
      this.sink.askFailed(
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // 上一个 ask 若在异常路径上留下了停驻项（turn 被 abort 之外的方式打断），在这里一并撤下：
    // 新的 ask 一旦开跑，那些问题就再也不会有人读答案了，留在注册表里只会让快照说谎。
    this.withdrawEscalations(state);
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // per-ask 预算归零（nudge 走的是 runTurn，不经这里——nudge 仍在同一个 ask 里）。
    state.escalationsUsed = 0;
    state.abortController = new AbortController();
    // 上一个 ask 的 waiting / executing 相位、工具计数都不能带到这个 ask 上；瞬态重驱计数同理。
    state.modelActivity.reset();
    this.deps.seatGate?.askStarted(refToString(state.actor), instance);
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // 质量尾注对 typed / untyped 一视同仁；schema 尾注只有 typed 有。两段都在 scheduler 算完
    // inputHash 之后追加，所以不进缓存身份。
    // typed ask 的 schema 尾注按 submit profile 分叉：mono 子代理的 schema 已在工具声明里，尾注只剩
    // 一句；generic 子代理照旧把整份 schema 写进尾注。守卫先跑：静态 profile 与这次 ask 不符时它会
    // 把会话降成 generic（或让 ask 失败），下面读到的就是修正后的形态。
    if (message.typed && !ensureSubmitProfileFits(this.deps, this.sink, state, instance, message)) {
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // 尾注边界：GUI 据此把尾注折进披露。指令正文
    // 之后全是引擎文本，边界就是正文长度；模型收到的仍是全文，持久 text part 也是。
    // fire-and-forget：绝不在 startAsk 内 await turn 完成（Boundary B 契约）。
    this.runTurn(state, instance, input, message.instructions.length);
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    switch (verdict.kind) {
      case "accept": {
        // 标记 accept：该 ask 的 turn resolve 时不再上报 askTurnEnded（引擎已 settleOk）。
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        // 同 turn 内修复：handler 收到 {accept:false} 会抛错 → error tool_result → 模型重试。
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // turn 已结束、无 parked deferred：在同一持久 runtime 上发起一次全新 turn 促其提交。
        // nudge 整条都是引擎文本：边界 0。
        this.runTurn(state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }
}
