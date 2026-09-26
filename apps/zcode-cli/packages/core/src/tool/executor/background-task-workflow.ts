import type {
  BackgroundResultOriginMeta,
  DynamicWorkflowRunError,
  DynamicWorkflowRunStopReason,
  WorkflowNotificationMeta,
} from "@zcode/contracts";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import type { ExecutableToolCall } from "../types.js";
import {
  type BashTaskNotificationStatus,
  normalizeBackgroundTaskNotificationStatus,
} from "./background-task-bash.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import type { BackgroundTaskSnapshot } from "./background-task-types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import {
  buildWorkflowReportsManifestSection,
  buildWorkflowReportsNotificationSection,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
import {
  buildWorkflowArtifactsManifestSection,
  buildWorkflowArtifactsNotificationSection,
  toPublishedArtifactSummaries,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";

export type WorkflowTerminalRunStatus = "completed" | "errored" | "stopped";

export function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: BashTaskNotificationStatus;
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // 一句话就要把「怎么结束的」说清：模型读 summary 比读 XML 字段更早。dwf 的三终态词优先；
  // legacy `Workflow` 不带 runStatus，落回追踪器的通用词。
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}

/**
 * dwf 快照上的三终态事实。只有 dwf 那支快照带 `runStatus` / `stopReason` / `failure`
 * （端口契约 `DynamicWorkflowRunSnapshot`）；老端口或 stub 不发它们时按追踪器的通用词折算。
 */
export function workflowSnapshotTerminal(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
):
  | {
      runStatus: WorkflowTerminalRunStatus;
      stopReason?: DynamicWorkflowRunStopReason;
      failure?: DynamicWorkflowRunError;
    }
  | undefined {
  const record = snapshot === undefined ? undefined : (snapshot as Record<string, unknown>);
  const declared = record?.runStatus;
  const runStatus: WorkflowTerminalRunStatus | undefined =
    declared === "completed" || declared === "errored" || declared === "stopped"
      ? declared
      : status === "completed"
        ? "completed"
        : status === "failed"
          ? "errored"
          : status === "cancelled"
            ? "stopped"
            : undefined;
  if (runStatus === undefined) return undefined;
  const reason = record?.stopReason;
  const stopReason =
    runStatus === "stopped" &&
    (reason === "user" ||
      reason === "model" ||
      reason === "provider" ||
      reason === "interrupted" ||
      reason === "superseded")
      ? reason
      : undefined;
  const failure = isRecord(record?.failure)
    ? (record?.failure as unknown as DynamicWorkflowRunError)
    : undefined;
  return {
    runStatus,
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(failure === undefined ? {} : { failure }),
  };
}

export function workflowTaskSubject(
  toolCall: ExecutableToolCall,
  taskId: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  return (
    stringField(input, "description") ??
    (snapshot && "description" in snapshot ? runtimeString(snapshot.description) : undefined) ??
    (snapshot && "name" in snapshot ? runtimeString(snapshot.name) : undefined) ??
    stringField(output, "name") ??
    stringField(input, "name") ??
    stringField(input, "scriptPath") ??
    taskId
  );
}

/**
 * workflow run 终态通知的 workflow originMeta（含 manifest 载荷）。CreateWorkflow / ResumeWorkflowRun
 * 两个入口同构，都经这里铸造：title 与 summary 同源（`workflowTaskSubject`）。
 */
export function buildWorkflowNotificationOriginMeta(
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output: Record<string, unknown> | undefined,
): BackgroundResultOriginMeta {
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const workflowNotification = buildWorkflowTerminalNotification(status, subject, snapshot);
  return {
    backgroundSource: "workflow",
    title: subject,
    workId: taskId,
    ...(workflowNotification ? { workflowNotification } : {}),
  };
}

export function formatWorkflowTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  launchOutput?: Record<string, unknown>,
): string {
  const output =
    snapshot && "output" in snapshot && isRecord(snapshot.output) ? snapshot.output : launchOutput;
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
  // dwf 的三终态词与停止原因从快照读；registry 的 stopInitiator 只作兼容兜底。
  const terminal = workflowSnapshotTerminal(status, snapshot);
  const stopReason =
    terminal?.stopReason ??
    (status === "cancelled" ? deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator : undefined);
  const summary = buildWorkflowTaskSummary({
    lost: status === "lost",
    status: notificationStatus,
    runStatus: terminal?.runStatus,
    stopReason,
    subject,
  });
  // dwf 的顶层返回值不回退到 launch output；legacy Workflow 保留 response 回退。
  const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
    ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
    : stringField(output, "response");
  const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  const reports = isDynamicWorkflow
    ? buildWorkflowReportsNotificationSection(workflowSnapshotReports(snapshot))
    : undefined;
  const artifacts = isDynamicWorkflow
    ? buildWorkflowArtifactsNotificationSection(
        workflowSnapshotArtifacts(snapshot),
        WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
      )
    : undefined;
  const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
  return formatTaskNotification({
    description: subject,
    ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
    ...(scriptPath === undefined
      ? {}
      : { scriptPath: describeWorkflowScriptPath(scriptPath, deps.getWorkingDirectory()) }),
    error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
    ...(reports === undefined ? {} : { reports }),
    ...(artifacts === undefined ? {} : { artifacts }),
    result,
    status: notificationStatus,
    ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
    summary,
    taskId,
    taskType: "local_workflow",
    toolUseId: toolCall.id,
  });
}

/** manifest 载荷（`WorkflowNotificationMeta`）里各字段的界。 */
const WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS = 500;
const WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS = 4_000;
const WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS = 2_000;

function buildWorkflowTerminalNotification(
  status: string,
  summary: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): WorkflowNotificationMeta | undefined {
  const terminalStatus = workflowTerminalNotificationStatus(status);
  if (terminalStatus === undefined || snapshot === undefined) return undefined;

  const terminal = workflowSnapshotTerminal(status, snapshot);
  const meta: Extract<WorkflowNotificationMeta, { kind: "terminal" }> = {
    kind: "terminal",
    status: terminal?.runStatus ?? terminalStatus,
    ...(terminal?.stopReason === undefined ? {} : { stopReason: terminal.stopReason }),
    summary: summary.slice(0, WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS),
  };

  const outputValue = snapshot && "output" in snapshot ? snapshot.output : undefined;
  const serialized = serializeWorkflowArtifact(outputValue);
  if (serialized !== undefined) {
    if (serialized.length > WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS) {
      meta.result = serialized.slice(0, WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS);
      meta.resultTruncated = true;
    } else {
      meta.result = serialized;
    }
    meta.resultForm = typeof outputValue === "string" ? "prose" : "json";
  }

  const error = snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined;
  if (error !== undefined) meta.error = error.slice(0, WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS);

  const reports = buildWorkflowReportsManifestSection(workflowSnapshotReports(snapshot));
  if (reports !== undefined) meta.reports = reports;

  const artifactsSection = buildWorkflowArtifactsManifestSection(
    workflowSnapshotArtifacts(snapshot),
  );
  if (artifactsSection !== undefined) {
    meta.artifacts = artifactsSection.artifacts;
    if (artifactsSection.artifactsTruncated) meta.artifactsTruncated = true;
  }

  const durationMs = workflowNotificationDurationMs(snapshot);
  if (durationMs !== undefined) meta.durationMs = durationMs;

  return meta;
}

function workflowTerminalNotificationStatus(
  status: string,
): "completed" | "errored" | "stopped" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "errored";
    case "cancelled":
      return "stopped";
    default:
      return undefined;
  }
}

function workflowNotificationDurationMs(snapshot: BackgroundTaskSnapshot): number | undefined {
  const startedAt =
    "startedAt" in snapshot && snapshot.startedAt instanceof Date
      ? snapshot.startedAt.getTime()
      : undefined;
  const completedAt =
    "completedAt" in snapshot && snapshot.completedAt instanceof Date
      ? snapshot.completedAt.getTime()
      : undefined;
  // 优先使用端口按 lineage 汇总的活动时长，同时保留当前进程可见时长作为下界和兼容回退。
  const ownLifeMs =
    startedAt === undefined || completedAt === undefined
      ? undefined
      : nonNegativeFinite(completedAt - startedAt);
  const lineageMs =
    "activeDurationMs" in snapshot ? nonNegativeFinite(snapshot.activeDurationMs) : undefined;
  if (ownLifeMs === undefined) return lineageMs;
  return lineageMs === undefined ? ownLifeMs : Math.max(ownLifeMs, lineageMs);
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function workflowSnapshotScriptPath(
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (snapshot === undefined || !("scriptPath" in snapshot)) return undefined;
  return typeof snapshot.scriptPath === "string" && snapshot.scriptPath.length > 0
    ? snapshot.scriptPath
    : undefined;
}

function workflowSnapshotReports(
  snapshot: BackgroundTaskSnapshot | undefined,
): readonly unknown[] | undefined {
  if (snapshot === undefined || !("reports" in snapshot)) return undefined;
  return Array.isArray(snapshot.reports) ? snapshot.reports : undefined;
}

function workflowSnapshotArtifacts(
  snapshot: BackgroundTaskSnapshot | undefined,
): ReturnType<typeof toPublishedArtifactSummaries> {
  if (snapshot === undefined || !("artifacts" in snapshot)) return undefined;
  return toPublishedArtifactSummaries(snapshot.artifacts);
}

function runtimeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
