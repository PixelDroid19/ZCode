import { ConversationTopicPublisherFrames } from "./conversation-topic-publisher-frames.js";
import type { ConversationTopicPublisherOptions } from "./conversation-topic-publisher-support.js";

export { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher-support.js";

export class ConversationTopicPublisher extends ConversationTopicPublisherFrames {
  protected createRehydrationCandidate(
    options: ConversationTopicPublisherOptions,
  ): ConversationTopicPublisher {
    return new ConversationTopicPublisher(this.sessionId, this.logEpoch, options);
  }
}
