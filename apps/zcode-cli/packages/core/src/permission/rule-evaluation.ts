import {
  PermissionCapabilityGroup,
  type PermissionRuleValue,
  type PermissionRuleset,
} from "@zcode/contracts";
import { OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME } from "@zcode/shared";
import type { ToolPermissionRulePolicy } from "../tool/types.js";
import { isWebFetchPreapprovedUrl } from "../tool/webfetch-preapproved.js";
import type { ResolvedPermissionCapability } from "./capability.js";
import { webFetchRuleSubjects, wildcardToRegExp } from "./rule-matching.js";
import type { PermissionBehavior, PermissionContext } from "./service.js";

export function matchesProjectRules(
  ruleset: PermissionRuleset | null | undefined,
  behavior: PermissionBehavior,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
  rulePolicy?: ToolPermissionRulePolicy,
): boolean {
  const rules = ruleset?.[behavior];
  if (!Array.isArray(rules)) return false;
  const toolRules = rules.filter((rule) => matchesRuleScope(rule, context.toolName, capability));
  if (toolRules.length === 0) return false;
  if (rulePolicy) return rulePolicy.evaluateRules(behavior, toolRules);
  return toolRules.some((rule) => matchesRule(rule, context, capability));
}

function matchesRule(
  rule: PermissionRuleValue,
  context: PermissionContext,
  capability: ResolvedPermissionCapability,
): boolean {
  if (!matchesRuleScope(rule, context.toolName, capability)) return false;
  if (!rule.ruleContent) return true;
  const subjects = ruleSubjects(context.input, context.toolName);
  return subjects.some((subject) => matchesRuleContent(subject, rule.ruleContent!));
}

function matchesRuleScope(
  rule: PermissionRuleValue,
  contextToolName: string,
  capability: ResolvedPermissionCapability,
): boolean {
  if (rule.toolName === OFFICIAL_CUA_PERMISSION_RULE_TOOL_NAME) {
    return capability.permissionCapabilityGroup === PermissionCapabilityGroup.OfficialCua;
  }
  return (
    rule.toolName === contextToolName || (contextToolName === "Write" && rule.toolName === "Edit")
  );
}

function ruleSubjects(input: unknown, toolName: string): string[] {
  if (typeof input === "string") return [input];
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  if (toolName === "WebFetch" && typeof record.url === "string") {
    return webFetchRuleSubjects(record.url);
  }
  for (const key of ["command", "url", "file_path", "path", "pattern", "patch_text"]) {
    const value = record[key];
    if (typeof value === "string") return [value];
  }
  return [];
}

function matchesRuleContent(subject: string, ruleContent: string): boolean {
  if (ruleContent.endsWith(":*")) {
    const prefix = ruleContent.slice(0, -2);
    return (
      subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`)
    );
  }
  return ruleContent.includes("*")
    ? wildcardToRegExp(ruleContent).test(subject)
    : subject === ruleContent;
}

export function isPreapprovedWebFetchRequest(context: PermissionContext): boolean {
  if (context.toolName !== "WebFetch" || !context.input || typeof context.input !== "object") {
    return false;
  }
  const url = (context.input as Record<string, unknown>).url;
  return typeof url === "string" && isWebFetchPreapprovedUrl(url);
}

export function isOwnedWorkflowAmend(context: PermissionContext, amendToolName: string): boolean {
  if (context.toolName !== amendToolName || !context.input || typeof context.input !== "object") {
    return false;
  }
  const predecessor = (context.input as Record<string, unknown>).predecessor;
  if (!predecessor || typeof predecessor !== "object") return false;
  const facts = predecessor as Record<string, unknown>;
  return facts.owned_by_this_session === true && facts.stop_reason !== "user";
}
