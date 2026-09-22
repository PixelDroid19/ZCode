import type { ModelToolSideEffectScope, RiskLevel } from "@zcode/contracts";
import type { PermissionContext, PermissionToolCapability } from "./service.js";

export interface ResolvedPermissionCapability {
  allowedInPlanMode: boolean;
  alwaysAsk: boolean;
  destructive: boolean;
  needsApproval: boolean;
  permissionCapabilityGroup?: PermissionToolCapability["permissionCapabilityGroup"];
  permissionName?: string;
  readOnly: boolean;
  requiresUserInteraction: boolean;
  riskLevel: RiskLevel;
  sideEffectScope: ModelToolSideEffectScope;
}

export function isReadOnlyPermissionTool(name: string): boolean {
  return new Set([
    "Read",
    "Glob",
    "Grep",
    "WebSearch",
    "WebFetch",
    "TodoRead",
    "TodoWrite",
    "AskUserQuestion",
    "Agent",
    "Task",
    "Skill",
  ]).has(name);
}

function isWritePermissionTool(name: string): boolean {
  return new Set(["Write", "Edit", "ApplyPatch", "Bash"]).has(name);
}

function isDestructivePermissionTool(name: string): boolean {
  return new Set(["Bash"]).has(name);
}

export function permissionRiskLevel(
  toolName: string,
  toolCapability?: PermissionToolCapability,
): RiskLevel {
  if (toolCapability?.riskLevel) return toolCapability.riskLevel;
  if (isReadOnlyPermissionTool(toolName)) return "low";
  if (isWritePermissionTool(toolName)) return "medium";
  if (isDestructivePermissionTool(toolName)) return "high";
  return "medium";
}

export function resolvePermissionCapability(
  context: PermissionContext,
  toolCapability?: PermissionToolCapability,
): ResolvedPermissionCapability {
  const classifiedReadOnly = isReadOnlyPermissionTool(context.toolName);
  // 工具可以如实声明自身为 readOnly，却没有声明调用未知工具的权限副作用。保留该声明的
  // 输出事实，同时让 fallback approval 仍按工具名分类，避免部分 third-party capability 被误判安全。
  const readOnly = toolCapability?.readOnly ?? classifiedReadOnly;
  return {
    allowedInPlanMode: toolCapability?.allowedInPlanMode ?? false,
    alwaysAsk: toolCapability?.permission?.alwaysAsk ?? toolCapability?.alwaysAsk ?? false,
    readOnly,
    destructive: toolCapability?.destructive ?? isDestructivePermissionTool(context.toolName),
    requiresUserInteraction:
      toolCapability?.requiresUserInteraction ??
      (toolCapability?.permission?.sideEffectScope ?? toolCapability?.sideEffectScope) ===
        "userInteraction",
    sideEffectScope:
      toolCapability?.permission?.sideEffectScope ??
      toolCapability?.sideEffectScope ??
      (classifiedReadOnly ? "none" : "workspace"),
    riskLevel:
      toolCapability?.permission?.riskLevel ??
      permissionRiskLevel(context.toolName, toolCapability),
    needsApproval:
      toolCapability?.permission?.needsApproval ??
      toolCapability?.needsApproval ??
      !classifiedReadOnly,
    permissionCapabilityGroup: toolCapability?.permissionCapabilityGroup,
    permissionName: toolCapability?.permission?.permission,
  };
}
