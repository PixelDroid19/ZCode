// ============================================================
// Permission Service - Permission checking and decision making
// ============================================================

import {
  AMEND_WORKFLOW_TOOL_NAME,
  type CollaborationMode,
  type ModelToolSideEffectScope,
  type PermissionCapabilityGroup as PermissionCapabilityGroupType,
  type PermissionRuleset,
  type PermissionUpdate,
  type RiskLevel,
  type ToolPermissionSpec,
} from "@zcode/contracts";
import { applyPermissionUpdates } from "../tool/executor/permission-rules.js";
import type { ToolPermissionRulePolicy } from "../tool/types.js";
import {
  permissionRiskLevel,
  resolvePermissionCapability,
  type ResolvedPermissionCapability,
} from "./capability.js";
import {
  checkBuildModeDecision,
  checkEditModeDecision,
  checkPlanModeDecision,
  permissionDecision,
} from "./mode-decisions.js";
import { resolvePlanModeTransitionPermission } from "./plan-mode-policy.js";
import {
  isOwnedWorkflowAmend,
  isPreapprovedWebFetchRequest,
  matchesProjectRules,
} from "./rule-evaluation.js";
import { isPreapprovedWorkflowDraftWrite } from "./workflow-draft-path.js";

// -----------------------------------------------
// Types
// -----------------------------------------------

/** 草稿免确认的规则号。 */
const WORKFLOW_DRAFT_PREAPPROVED_RULE_ID = "tool.workflowDraft.preapproved";

export interface PermissionContext {
  toolName: string;
  input: unknown;
  riskLevel: RiskLevel;
  mode: CollaborationMode;
  planEnabled?: boolean;
  prePlanMode?: Exclude<CollaborationMode, "plan">;
  /**
   * 会话工作目录。判定相对路径的落点用（目前只有 workflow 草稿免确认这一条），
   * 可选：拿不到工作目录的调用方照常按其余规则判定，不会因此少一层确认。
   */
  workingDirectory?: string;
}

export interface PermissionToolCapability {
  allowedInPlanMode?: boolean;
  alwaysAsk?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  riskLevel?: RiskLevel;
  needsApproval?: boolean;
  permissionCapabilityGroup?: PermissionCapabilityGroupType;
  permission?: ToolPermissionSpec;
}

export type PermissionBehavior = "allow" | "ask" | "deny";

export interface PermissionDecisionResult {
  decision: PermissionBehavior;
  allowed: boolean;
  reason?: string;
  modifiedInput?: unknown;
  escalated: boolean;
  mode: CollaborationMode;
  ruleId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  /**
   * 该 ask 来自工具的 alwaysAsk 声明，不是模式或规则推导出来的。下游（PreToolUse hook 的
   * allow 覆盖）靠这个结构化标记识别"不可抹掉的确认"，而不是去匹配 ruleId 字符串。
   */
  alwaysAsk?: boolean;
}

// -----------------------------------------------
// Permission Service
// -----------------------------------------------

export class PermissionService {
  /** 会话级 allow 规则只服务 alwaysAsk gate，并随会话实例销毁。 */
  private sessionRules: PermissionRuleset = { version: 1 };

  constructor(private config: PermissionConfig = defaultPermissionConfig) {}

  grantSessionPermission(updates: PermissionUpdate[]): void {
    this.sessionRules = applyPermissionUpdates(this.sessionRules, updates);
  }

  checkPermission(
    context: PermissionContext,
    toolCapability?: PermissionToolCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    const capability = resolvePermissionCapability(context, toolCapability);
    const planModeTransition = resolvePlanModeTransitionPermission(context);
    if (planModeTransition) {
      return permissionDecision(
        planModeTransition.behavior,
        context,
        capability,
        planModeTransition.ruleId,
        planModeTransition.reason,
      );
    }
    if (capability.requiresUserInteraction) {
      if (this.config.disallowedTools.has(context.toolName)) {
        return permissionDecision(
          "deny",
          context,
          capability,
          "rule.disallowedTools",
          `Tool ${context.toolName} is explicitly disallowed`,
        );
      }
      return permissionDecision(
        "ask",
        context,
        capability,
        "tool.userInteraction",
        `Tool ${context.toolName} requires user interaction`,
      );
    }
    if (capability.alwaysAsk) {
      return this.checkAlwaysAsk(context, capability, projectRules, rulePolicy);
    }
    const planEnabled = context.planEnabled ?? context.mode === "plan";
    if (context.mode === "yolo" && !planEnabled) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "mode.yolo",
        "Yolo mode bypasses permission prompts",
      );
    }
    if (context.mode === "auto") {
      return permissionDecision(
        "deny",
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return permissionDecision(
        "deny",
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }
    if (matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return permissionDecision(
        "deny",
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    if (matchesProjectRules(projectRules, "ask", context, capability, rulePolicy)) {
      return permissionDecision(
        "ask",
        context,
        capability,
        "rule.project.ask",
        `Tool ${context.toolName} requires approval by project permission rules`,
      );
    }
    if (planEnabled) return checkPlanModeDecision(context, capability);
    if (matchesProjectRules(projectRules, "allow", context, capability, rulePolicy)) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "rule.project.allow",
        `Tool ${context.toolName} is allowed by project permission rules`,
      );
    }
    if (isPreapprovedWebFetchRequest(context)) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "tool.webfetch.preapproved",
        "WebFetch URL is preapproved",
      );
    }
    if (
      isPreapprovedWorkflowDraftWrite({
        input: context.input,
        toolName: context.toolName,
        workingDirectory: context.workingDirectory,
      })
    ) {
      return permissionDecision(
        "allow",
        context,
        capability,
        WORKFLOW_DRAFT_PREAPPROVED_RULE_ID,
        "Workflow draft file is preapproved",
      );
    }
    if (this.config.allowedTools.has(context.toolName)) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "rule.allowedTools",
        `Tool ${context.toolName} is explicitly allowed`,
      );
    }
    return context.mode === "edit"
      ? checkEditModeDecision(context, capability, this.config.autoApproveHighRisk)
      : checkBuildModeDecision(context, capability, this.config.autoApproveHighRisk);
  }

  private checkAlwaysAsk(
    context: PermissionContext,
    capability: ResolvedPermissionCapability,
    projectRules?: PermissionRuleset | null,
    rulePolicy?: ToolPermissionRulePolicy,
  ): PermissionDecisionResult {
    if (context.mode === "auto") {
      return permissionDecision(
        "deny",
        context,
        capability,
        "mode.auto.unimplemented",
        "Auto mode is reserved but not implemented yet",
      );
    }
    if (this.config.disallowedTools.has(context.toolName)) {
      return permissionDecision(
        "deny",
        context,
        capability,
        "rule.disallowedTools",
        `Tool ${context.toolName} is explicitly disallowed`,
      );
    }
    if (matchesProjectRules(projectRules, "deny", context, capability, rulePolicy)) {
      return permissionDecision(
        "deny",
        context,
        capability,
        "rule.project.deny",
        `Tool ${context.toolName} is denied by project permission rules`,
      );
    }
    if (matchesProjectRules(this.sessionRules, "allow", context, capability, rulePolicy)) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "rule.session.allow",
        `Tool ${context.toolName} was allowed for this session`,
      );
    }
    if (isOwnedWorkflowAmend(context, AMEND_WORKFLOW_TOOL_NAME)) {
      return permissionDecision(
        "allow",
        context,
        capability,
        "rule.session.workflowOwner",
        `Tool ${context.toolName} amends a run this session started`,
      );
    }
    return permissionDecision(
      "ask",
      context,
      capability,
      "tool.alwaysAsk",
      `Tool ${context.toolName} always requires explicit approval`,
    );
  }

  requiresApproval(context: PermissionContext, toolCapability?: PermissionToolCapability): boolean {
    return this.checkPermission(context, toolCapability).decision === "ask";
  }

  getRiskLevel(toolName: string, toolCapability?: PermissionToolCapability): RiskLevel {
    return permissionRiskLevel(toolName, toolCapability);
  }
}
// -----------------------------------------------
// Configuration
// -----------------------------------------------

export interface PermissionConfig {
  allowedTools: Set<string>;
  disallowedTools: Set<string>;
  autoApproveHighRisk: boolean;
  allowMediumRiskInAutoMode: boolean;
}

export const defaultPermissionConfig: PermissionConfig = {
  allowedTools: new Set(),
  disallowedTools: new Set(),
  autoApproveHighRisk: false,
  allowMediumRiskInAutoMode: false,
};
