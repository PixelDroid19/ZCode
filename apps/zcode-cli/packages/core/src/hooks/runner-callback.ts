import type { HookInput, HookJSONOutput } from "@zcode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import {
  HOOK_TIMEOUT_ABORT_REASON,
  createHookCancelledError,
  createHookTimeoutError,
  linkAbortSignal,
} from "./runner-helpers.js";
import type { HookCallbackDiagnostics, HookCallbackResult, HookRegistration } from "./types.js";

export async function runHookCallbackWithTimeout(input: {
  defaultTimeoutMs: number;
  hook: HookRegistration;
  hookIndex: number;
  parentSignal?: AbortSignal;
  request: HookInput;
}): Promise<HookJSONOutput | HookCallbackResult | void> {
  const timeoutMs = input.hook.timeoutMs ?? input.defaultTimeoutMs;
  const controller = new AbortController();
  const unlink = linkAbortSignal(input.parentSignal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await new Promise<HookJSONOutput | HookCallbackResult | void>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(createHookCancelledError());
        return;
      }

      timer = setTimeout(() => {
        controller.abort(HOOK_TIMEOUT_ABORT_REASON);
        reject(createHookTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      controller.signal.addEventListener(
        "abort",
        () => {
          reject(
            controller.signal.reason === HOOK_TIMEOUT_ABORT_REASON
              ? createHookTimeoutError(timeoutMs)
              : createHookCancelledError(),
          );
        },
        { once: true },
      );

      Promise.resolve(
        input.hook.callback(input.request, {
          hookIndex: input.hookIndex,
          signal: controller.signal,
        }),
      ).then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    unlink();
  }
}

export function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  diagnostics: HookCallbackDiagnostics | undefined;
  output: HookJSONOutput | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

export function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}
