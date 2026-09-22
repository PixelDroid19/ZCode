import type * as reducersBackgroundWork from "./product-projection-background-work.js";
import type * as reducersCompaction from "./product-projection-compaction.js";
import type * as reducersDispatch from "./product-projection-dispatch.js";
import type * as reducersEventApplication from "./product-projection-event-application.js";
import type * as reducersGoals from "./product-projection-goals.js";
import type * as reducersHookReviews from "./product-projection-hook-reviews.js";
import type * as reducersHooks from "./product-projection-hooks.js";
import type * as reducersModelStreams from "./product-projection-model-streams.js";
import type * as reducersModelUsage from "./product-projection-model-usage.js";
import type * as reducersPermissions from "./product-projection-permissions.js";
import type * as reducersQueueAdmission from "./product-projection-queue-admission.js";
import type * as reducersQueueControl from "./product-projection-queue-control.js";
import type * as reducersQueueDrain from "./product-projection-queue-drain.js";
import type * as reducersRewind from "./product-projection-rewind.js";
import type * as reducersRowState from "./product-projection-row-state.js";
import type * as reducersSeeds from "./product-projection-seeds.js";
import type * as reducersSubagentLifecycle from "./product-projection-subagent-lifecycle.js";
import type * as reducersSubagentRows from "./product-projection-subagent-rows.js";
import type * as reducersTargets from "./product-projection-targets.js";
import type * as reducersToolResults from "./product-projection-tool-results.js";
import type * as reducersToolRows from "./product-projection-tool-rows.js";
import type * as reducersTurnCompletion from "./product-projection-turn-completion.js";
import type * as reducersTurnStart from "./product-projection-turn-start.js";
type Implementations = typeof reducersSeeds &
  typeof reducersTargets &
  typeof reducersEventApplication &
  typeof reducersDispatch &
  typeof reducersHooks &
  typeof reducersRewind &
  typeof reducersTurnStart &
  typeof reducersTurnCompletion &
  typeof reducersModelStreams &
  typeof reducersToolRows &
  typeof reducersToolResults &
  typeof reducersPermissions &
  typeof reducersHookReviews &
  typeof reducersQueueAdmission &
  typeof reducersQueueDrain &
  typeof reducersQueueControl &
  typeof reducersSubagentRows &
  typeof reducersSubagentLifecycle &
  typeof reducersBackgroundWork &
  typeof reducersModelUsage &
  typeof reducersCompaction &
  typeof reducersGoals &
  typeof reducersRowState;
export type ProductProjectionMethods = {
  [K in keyof Implementations]: OmitThisParameter<Implementations[K]>;
};
