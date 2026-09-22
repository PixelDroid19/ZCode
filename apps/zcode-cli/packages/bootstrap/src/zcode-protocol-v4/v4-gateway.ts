import { ConversationV4GatewayLifecycle } from "./v4-gateway-lifecycle.js";

export class ConversationV4Gateway extends ConversationV4GatewayLifecycle {}

export { V4CommandNoopError, V4CommandNotImplementedError } from "./v4-gateway-errors.js";
export type { V4GatewayHost } from "./v4-gateway-types.js";
