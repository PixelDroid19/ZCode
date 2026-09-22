import {
  zcodeProtocolNotifications,
  zcodeSessionCapabilitiesChangedNotificationSchema,
  type ZCodeSessionCapabilitiesChangedNotification,
} from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** Publishes the runtime-owned capability status without introducing a second session state owner. */
export function notifySessionCapabilitiesChanged(
  context: Pick<ZCodeProtocolAgentServerContext, "notify">,
  notification: ZCodeSessionCapabilitiesChangedNotification,
): void {
  context.notify({
    method: zcodeProtocolNotifications.sessionCapabilitiesChanged,
    params: zcodeSessionCapabilitiesChangedNotificationSchema.parse(notification),
  });
}
