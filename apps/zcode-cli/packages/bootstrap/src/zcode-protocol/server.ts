export type { ZCodeProtocolAgentDependencies, ZCodeProtocolSessionRecord } from "./server-types.js";

import { ZCodeProtocolAgentServerClientRequests } from "./server-client-requests.js";

export class ZCodeProtocolAgentServer extends ZCodeProtocolAgentServerClientRequests {}
