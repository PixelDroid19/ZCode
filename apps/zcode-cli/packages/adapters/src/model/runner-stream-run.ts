import type { ModelStreamEvent } from "@zcode/contracts";
import { ModelTransportKind as ModelTransportKindValue } from "@zcode/contracts";
import { isDevelopmentModelIOEnv, shouldRecordModelIO } from "./runner-debug.js";
import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";
import { StreamAttempt } from "./runner-stream-attempt.js";
import type { RunStreamTextInput, StreamRunState } from "./runner-stream-types.js";
import { createStatusContext } from "./runner-status.js";

export async function* runStreamText(input: RunStreamTextInput): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const state: StreamRunState = {
    baseStatusContext: createStatusContext({
      maxAttempts: statusMaxAttempts(0),
      request: input.request,
      resolved: input.resolved,
      transport: ModelTransportKindValue.Sse,
    }),
    emptyCompletionRetryCount: 0,
    isDev: isDevelopmentModelIOEnv(input.env),
    recordModelIO: shouldRecordModelIO(input.env),
    requestMessages: input.request.messages,
    retryBudget,
    signatureRepairAttempted: false,
  };

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(state.signatureRepairAttempted),
    );
    attempt += 1
  ) {
    // 必须委托 async generator：这样 consumer 的 return() 会向内传播，确保 attempt finally
    // 按既有 provider 边界策略清理并归还准入票据；手工 next/yield 转发会吞掉 AsyncIteratorClose。
    const outcome = yield* new StreamAttempt(input, state, attempt, statusMaxAttempts).run();
    if (outcome.kind === "completed") return;
    if (outcome.holdRetryBudget) {
      // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
      attempt -= 1;
    }
  }
}
