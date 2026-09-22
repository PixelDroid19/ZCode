// ============================================================
// AgentRuntime-backed WorkflowDriver（Boundary B）
// ============================================================
// 把 dynamic-workflow 引擎核心的向下副作用端口 WorkflowDriver 落到真实 ZCode AgentRuntime 上：
// 每个 actor 一个**持久** child runtime（重复 executeTurn 累积 messageHistory），每次 ask 一次
// executeTurn，typed ask 的结果经会话级 WorkflowSubmitPort 桥接回引擎裁决。
//
// Boundary B 的另外两半——`executeWorldRead` 与 `executeArtifactPublish`——分别住在
// workflow-world-read.ts 与 workflow-artifact-publish.ts，本文件只做转发。两者与这里没有
// 共同状态（不碰会话、turn、submit 桥接），所以分开之后本文件只剩「会话与 turn 的编排」
// 这一件事。
//
// 三条时序（本文件的核心不变式）：
//   1. accept：模型调用 submit_result → handler 阻塞在 port.respond → 本 driver 上报
//      askSubmitAttempted → 引擎校验通过 → respondToSubmit(accept) → 解开 deferred 为 {accept:true}
//      → handler 返回成功（挂 turnControl 停 turn）→ executeTurn resolve → 只上报 askStats（不再上报
//      askTurnEnded，因为该 ask 已被引擎结算）。
//   2. reject（同 turn 内修复）：respondToSubmit(reject, violations) → 解开 deferred 为
//      {accept:false, violations} → handler 抛错 → error tool_result（无 turnControl）→ 同一 turn 继续
//      → 模型重试 → 又一次 respond → 又一次 deferred。repair 预算耗尽时引擎改调 cancelAsk。
//   3. nudge（turn 结束未提交）：executeTurn resolve 且未 accept → 上报 askTurnEnded → 引擎决定 nudge
//      → respondToSubmit(nudge)（此时**无** parked deferred，turn 已结束）→ 在同一持久 runtime 上发起
//      一次**全新** executeTurn（nudge 提示）。
//
// 三值→二值裁决映射（引擎 SubmitVerdict 三值；contracts WorkflowSubmitPort 二值）：
//   accept → {accept:true}；reject → {accept:false, violations}（Violation 1:1 映射）；nudge → 无 deferred，
//   起新 turn。见 respondToSubmit。
//
// 第四条时序（升级问答）与上面三条**同层**：
//   4. escalate：模型调用 escalate → handler 阻塞在 escalatePort → driver 铸 qid、停驻 deferred、
//      把问题登记进升级注册表，并双轨发出 escalation-raised（journal + emit）→ 主代理经 run
//      service 的 resolveQuestion 查表 → driver.respondToEscalation 解开 deferred 并发出
//      escalation-resolved → 工具结果 = 答案文本 → actor 的轮次就地继续，ask 照常 settle。
//      引擎核心对此**零感知**：升级发生在 driver 执行 ask 的边界内（与 repair/nudge 轮次同层），
//      不写 dwf_node 行。逃生舱是 cancelAsk——它连同停驻的升级 deferred 一起拒绝。
//
// amend-resume 给本文件加了两件 driver 私有的事，两件都只
// 关乎会话转录，所以机制住在 workflow-actor-transcript.ts，这里只做编排（编排的三个实现体在
// workflow-driver-transcript.ts）：
//   - **ask 边界记账**：一次交换（含 repair / nudge 轮与 submit 之后的收尾消息）结束后，把该 actor
//     会话已落库的消息条数写进这个 ask 的 journal 行。每个 ask 都写——任何 run 都是未来修订的
//     潜在前驱。
//   - **转录截断**：`createActorSession` 带种子时，把源会话的前 N 条消息复制进新铸的会话再重水化。

import type { WorkflowDriver, WorkflowReportSink } from "@zcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import { AgentRuntimeWorkflowDriverTurns } from "./workflow-driver-turns.js";

class AgentRuntimeWorkflowDriver extends AgentRuntimeWorkflowDriverTurns {}

/**
 * 造一个绑定了 deps 的 driver 工厂，直接充当 harness 的 makeDriver。journal 与 emit 由 deps 提供，
 * 调用方（测试/生产）持有其引用以做断言与 Boundary C 扇出。
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
