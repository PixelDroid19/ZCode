import { compact } from "./goal-compact-manual.js";
import { pauseGoal, resumeGoal, sendGoalCommand } from "./goal-compact-goal.js";

export { V4GoalCompactRejectedError } from "./goal-compact-error.js";
export { startManualCompact } from "./goal-compact-manual.js";
export { applyGoalCommand, parseGoalObjectiveFromCommandText } from "./goal-compact-goal.js";

export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };
