import type {
  SessionId,
  SubmitResultRequest,
  SubmitVerdict as ContractsSubmitVerdict,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type InstanceRef,
  type PersonaSpec,
  type RunEvent,
  type WorkflowDriver,
  type WorldReadOp,
} from "@zcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { executeWorldRead } from "./workflow-world-read.js";
import { handleModelTurnFailure } from "./workflow-driver-model-failure.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
} from "./workflow-driver-escalation.js";
import {
  defer,
  isTurnCancelled,
  rejectWith,
  reportTurnObservations,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { countSessionTranscript, journalAskMessageBoundary } from "./workflow-driver-transcript.js";
import type { SessionState } from "./workflow-driver-types.js";
import { AgentRuntimeWorkflowDriverSession } from "./workflow-driver-session.js";

export class AgentRuntimeWorkflowDriverTurns
  extends AgentRuntimeWorkflowDriverSession
  implements WorkflowDriver
{
  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    // 引擎主动取消（repair/nudge 预算耗尽、run 取消/失败）：中止在飞 turn，并解开可能挂起的 submit
    // deferred，避免 handler 永久阻塞；标记 cancelled 使 turn reject 不再上报 askFailed。
    state.cancelled = true;
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // 停驻中的升级问答与 submit deferred **同待遇**：一并拒绝，否则 `escalate` handler 会在一个
    // 已被取消的 ask 里永久阻塞。这条正是「无答案 = 无限期阻塞」的逃生舱（按设计不设超时）：
    // run cancel 与 CLI 进程亡故的行为因此与今天逐字节一致——ask 拒 Cancelled、run 转
    // Interrupted，resume 后该 ask 重跑、actor 重新提问并得到新 qid。
    this.withdrawEscalations(state);
    // 退避等待中的重驱一并撤下：ask 已被引擎结算，再起一轮只会对着一个没人听的节点烧 token。
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * run 结算后的资源释放（引擎在 run-settled 之后恰好调一次，见 WorkflowDriver.dispose）。
   *
   * 对每个 actor runtime 跑 app 关会话的**同一条**链——`closeBrowserSession` 内部依次
   * beginShutdown、node_repl 会话释放、浏览器会话关闭；不另造一套子代理关闭链，那会漂移。
   * 不关 execution / MCP / session store：子代理不拥有它们。有在飞 turn 的会话等它落地再关
   * （见 SessionState.turn）；关闭失败只 warn，结算不因它抛。三张表随之清空。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    for (const state of this.sessions.values()) {
      state.modelActivity.unsubscribe();
      state.cancelRedrive?.();
      state.cancelRedrive = undefined;
      const close = (): void => this.closeActorRuntime(state);
      if (state.turn === undefined) close();
      else state.turn.then(close, close);
    }
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  protected closeActorRuntime(state: SessionState): void {
    // Promise.resolve().then(...)：把同步抛出也归到同一条 warn 路径（最小 stub runtime 没有这个方法）。
    void Promise.resolve()
      .then(async () => {
        try {
          await state.runtime.closeBrowserSession();
        } finally {
          await state.runtime.disposeCapabilities?.();
        }
      })
      .catch((error: unknown) => {
        this.deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.actor_runtime.close_failed",
          module: "bootstrap.app",
          sessionId: state.sessionId,
        });
      });
  }

  /**
   * 结算一个停驻中的升级问答（run service 经注册表调进来）。实现体在
   * workflow-driver-escalation.ts（{@link respondToParkedEscalation}），这里只做委托。
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /** 撤下某会话上所有停驻中的升级问答；实现体见 {@link withdrawSessionEscalations}。 */
  protected withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * 世界读取：整段委托给 {@link executeWorldRead}（workflow-world-read.ts）。
   *
   * 这里只做转发，是因为世界读取与本文件的其余部分**没有共同状态**：它不碰 actor 会话、
   * 不碰 turn、不碰 submit 桥接，只需要三样东西（两个端口加一个 cwd）。分出去之后本文件
   * 只剩"会话与 turn 的编排"这一件事，而 op 元数、上限执行、git 的固定 argv 集中在一处。
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return await executeWorldRead(this.deps, op, args);
  }

  /**
   * 用户面产物的发布：整段委托给 {@link executeArtifactPublish}（workflow-artifact-publish.ts），
   * 理由与上面的世界读取逐字相同——它与本文件没有共同状态，只需要两个端口、一个 cwd 与
   * 一个会话 id。
   *
   * 方法在 Boundary B 上是**可选**的（`executeArtifactPublish?`），而本 driver 恒实现它：
   * 「有没有存储」是装配事实，由 deps 里的 `artifactStore` 表达并在那一侧大声失败，不该由
   * 「方法在不在」这条第二条通道再表达一次（两条通道会给同一件事两种失败形态）。
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    return await executeArtifactPublish(this.deps, request);
  }

  // ——————————————————————————————— 内部：turn 编排 ———————————————————————————————

  protected runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    const abortSignal = state.abortController?.signal;
    state.turnGeneration++;
    state.turn = state.runtime
      .executeTurn(input, undefined, {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
      })
      .then(
        (result) => this.onTurnResolved(state, instance, result),
        (error) => this.onTurnRejected(state, instance, error),
      );
  }

  protected onTurnResolved(state: SessionState, instance: InstanceRef, result: TurnResult): void {
    // 一次 turn 解析的两条回报（进度先于用量），顺序与载荷都在 reportTurnObservations 里。
    reportTurnObservations(this.sink, state, instance, result);
    if (this.deps.actorTranscriptStore === undefined) {
      // 无转录存取面：原样的同步路径，一个 await 都不多欠（边界记账整体缺席，见 deps 字段注释）。
      this.reportTurnOutcome(state, instance, result);
      return;
    }
    void this.settleExchange(state, instance, result);
  }

  /**
   * 报告一个 turn 的终局，并回答「这次 ask 的交换到此为止了吗」。
   *
   * accept 之外只有一条路：把最终文本交给引擎（typed → nudge 或耗尽失败；untyped → 据此结算）。
   * nudge 时引擎会在**本调用栈内**经 respondToSubmit 起一轮全新 turn，于是 turnGeneration 变了——
   * 那正是"交换尚未结束"的判据（repair 轮不在此列：它们在同一个 turn 里，本方法根本不会被调用）。
   */
  protected reportTurnOutcome(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): boolean {
    // 已提交并被引擎 accept：ask 已结算，turn 结束只是确认，不再上报 askTurnEnded。
    if (state.accepted) return true;
    const generation = state.turnGeneration;
    this.sink.askTurnEnded(instance, result.response);
    return state.turnGeneration === generation;
  }

  /**
   * 一次交换的收尾：数消息 → 报终局 → 交换真的结束了就把边界写进 ask 的 journal 行。
   *
   * **先数后报**，顺序是载荷性的：报出去之后引擎可能立刻在同一个会话上派发这个 actor 的下一个
   * ask（per-actor FIFO 只保证串行，不保证之间有空隙），那一轮的消息会落进同一个会话，把本次
   * 计数撑大。先数下来，读到的就是这次交换结束那一刻的长度。
   */
  protected async settleExchange(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): Promise<void> {
    const boundary = await countSessionTranscript(this.deps, state, instance);
    const ended = this.reportTurnOutcome(state, instance, result);
    if (!ended || boundary === undefined) return;
    journalAskMessageBoundary(this.deps, state, instance, boundary);
  }

  protected onTurnRejected(state: SessionState, instance: InstanceRef, error: unknown): void {
    // turn 死了就没有人再读工具结果了：停驻中的升级问答必须一并撤下，否则它们会永远留在
    // 快照的 pendingQuestions 里，请主代理去回答一个没有听众的问题。
    this.withdrawEscalations(state);
    if (state.cancelled || isTurnCancelled(error)) {
      // 引擎发起的取消（abort）：引擎已结算该 ask，driver 不重复上报。
      return;
    }
    // 模型侧错误的收容住在 workflow-driver-model-failure.ts（策略表判 stop / context_exceeded /
    // 瞬态重驱）；不是模型层错误才是 driver 侧失败。
    if (handleModelTurnFailure(this.modelFailureHost, state, instance, error)) return;
    this.sink.askFailed(instance, toWorkflowError(error));
  }

  // ——————————————————————————————— 内部：submit 桥接 ———————————————————————————————

  /** 造一个会话级 submit 端口：submit_result handler mid-turn 调用它并阻塞等裁决。 */
  protected makeSubmitPort(sessionId: SessionId): WorkflowSubmitPort {
    return {
      respond: (request: SubmitResultRequest): Promise<ContractsSubmitVerdict> => {
        const state = this.sessions.get(sessionId);
        const instance = state?.currentInstance;
        if (state === undefined || instance === undefined) {
          // 无在飞 ask 却收到 submit：不路由到引擎，直接拒绝（避免悬挂）。
          return Promise.resolve(rejectWith("no active ask is awaiting a submitted result"));
        }
        // Untyped ask 守卫：设计上「全 untyped 的 actor 不注册 submit_result」，
        // 但 driver 在 createActorSession 时拿不到 actor 的聚合 typed 信息（需 site graph，未透传），故
        // 一律注册。为不依赖引擎「submitAttempted 对 untyped 早退」的行为（那会让 deferred 永久悬挂），
        // 这里在 driver 内部直接拦截：untyped ask 收到 submit 时立即回一条合成 rejection 让模型改用纯文本，
        // 绝不上报 askSubmitAttempted。后续版本可据 actor-graph 投影把 per-actor typed 信息透传进来，
        // 真正在 untyped-only actor 上跳过注册（关系到 prompt-cache 的 frozen-tools 不变式）。
        if (!state.currentTyped) {
          return Promise.resolve(
            rejectWith(
              "this ask does not accept submit_result; provide your answer as your final message",
            ),
          );
        }
        // 单前实例不变式：至多一个挂起 deferred。若已有（不应发生），先拒旧的避免泄漏。
        state.pendingSubmit?.reject(
          new WorkflowError("DriverError", "This submit was superseded by a newer submit."),
        );
        const deferred = defer<ContractsSubmitVerdict>();
        state.pendingSubmit = deferred;
        // 同步上报：引擎在本调用栈内校验并经 respondToSubmit 回裁决（同步解开 deferred）。
        this.sink.askSubmitAttempted(instance, request.result);
        return deferred.promise;
      },
    };
  }

  // ——————————————————————————————— 内部：升级问答桥接 ———————————————————————————————

  /**
   * 造一个会话级升级端口；实现体在 workflow-driver-escalation.ts（{@link makeSessionEscalatePort}），
   * 与 {@link makeSubmitPort} 逐条对称的论证也写在那边。
   */
  protected makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   * 一条 driver 侧事件的双轨落地：durable 进 `dwf_event`，实时经 emit 扇出。
   *
   * 与引擎的 `record()`（engine.ts）逐字节同形，且顺序不可换：launch 侧的 sequence 截取靠
   * 「appendEvent 之后同步紧接着 emit、同一个事件对象引用」这个前提把刚分配到的 sequence 交给
   * emit（dynamic-workflow-run-launch.ts 的 createJournalSequenceCapture）。
   */
  protected record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}
