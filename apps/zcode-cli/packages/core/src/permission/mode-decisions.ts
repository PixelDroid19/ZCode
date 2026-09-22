import type { ResolvedPermissionCapability } from "./capability.js";
import type { PermissionContext, PermissionDecisionResult } from "./service.js";

export function permissionDecision(
  decision: "allow" | "ask" | "deny",
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  ruleId: string,
  reason?: string,
): PermissionDecisionResult {
  return {
    decision,
    allowed: decision === "allow",
    escalated: decision === "ask",
    mode: context.mode,
    reason,
    riskLevel: capability.riskLevel,
    ruleId,
    sideEffectScope: capability.sideEffectScope,
    ...(capability.alwaysAsk ? { alwaysAsk: true } : {}),
  };
}

export function checkPlanModeDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): PermissionDecisionResult {
  if (capability.readOnly && !capability.destructive) {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.plan.readOnly",
      "Plan mode allows read-only tool execution",
    );
  }
  if (capability.permissionName === "mcp" && !capability.destructive) {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.plan.mcp",
      "Plan mode allows non-destructive MCP tool execution",
    );
  }
  if (
    capability.allowedInPlanMode &&
    capability.sideEffectScope === "session" &&
    !capability.destructive &&
    !capability.needsApproval
  ) {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.plan.explicitSessionCapability",
      "Plan mode allows this explicit non-destructive session control action",
    );
  }
  return permissionDecision(
    "deny",
    context,
    capability,
    "mode.plan.nonReadOnly",
    "Plan mode only allows read-only, non-destructive tools",
  );
}

export function checkBuildModeDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  autoApproveHighRisk: boolean,
): PermissionDecisionResult {
  if (capability.readOnly && !capability.destructive && !capability.needsApproval) {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.build.readOnly",
      "Build mode allows read-only tools",
    );
  }
  if (capability.riskLevel === "critical") {
    return permissionDecision(
      "ask",
      context,
      capability,
      "mode.build.criticalRisk",
      "Critical risk tools require explicit approval",
    );
  }
  if (capability.riskLevel === "high" && !autoApproveHighRisk) {
    return permissionDecision(
      "ask",
      context,
      capability,
      "mode.build.highRisk",
      "High risk tools require explicit approval",
    );
  }
  if (
    capability.sideEffectScope === "session" &&
    capability.riskLevel === "low" &&
    !capability.destructive &&
    !capability.needsApproval
  ) {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.build.sessionState",
      "Build mode allows low-risk session-local state updates",
    );
  }
  if (capability.needsApproval || capability.destructive || capability.sideEffectScope !== "none") {
    return permissionDecision(
      "ask",
      context,
      capability,
      "mode.build.sideEffect",
      "Tool has side effects and requires approval",
    );
  }
  return permissionDecision(
    "allow",
    context,
    capability,
    "mode.build.lowRisk",
    "Build mode allows low-risk tool execution",
  );
}

export function checkEditModeDecision(
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  autoApproveHighRisk: boolean,
): PermissionDecisionResult {
  if (capability.permissionName === "edit" && capability.sideEffectScope === "workspace") {
    return permissionDecision(
      "allow",
      context,
      capability,
      "mode.edit.fileEdit",
      "Edit mode allows file edit tools",
    );
  }
  return checkBuildModeDecision(context, capability, autoApproveHighRisk);
}
