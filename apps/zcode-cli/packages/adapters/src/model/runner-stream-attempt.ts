import type { ModelStreamEvent } from "@zcode/contracts";
import { StreamAttemptFailure } from "./runner-stream-attempt-failure.js";
import type { StreamAttemptOutcome } from "./runner-stream-types.js";

export class StreamAttempt extends StreamAttemptFailure {
  async *run(): AsyncGenerator<ModelStreamEvent, StreamAttemptOutcome> {
    await this.admit();
    try {
      return yield* this.runAttemptBody();
    } catch (error) {
      return await this.handleAttemptFailure(error);
    } finally {
      await this.cleanupAttempt();
    }
  }
}
