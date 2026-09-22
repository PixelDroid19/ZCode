import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type PermissionBrokerPort,
} from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { requestPermission } from "./interaction-broker-permission.js";
import { requestExitPlanModeApproval } from "./interaction-broker-plan-approval.js";
import { requestUserInput } from "./interaction-broker-user-input.js";

/**
 * Adapts the protocol's permission boundary to the dedicated permission,
 * user-input, and plan-approval flows.
 */
export function createProtocolInteractionBroker(
  context: ZCodeProtocolAgentServerContext,
): PermissionBrokerPort {
  return {
    requestPermission(request, options) {
      if (request.toolName === ASK_USER_QUESTION_TOOL_NAME) {
        return requestUserInput(context, request, options);
      }
      if (request.toolName === EXIT_PLAN_MODE_TOOL_NAME) {
        return requestExitPlanModeApproval(context, request, options);
      }
      return requestPermission(context, request, options);
    },
  };
}
