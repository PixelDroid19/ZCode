import type {
  ContextSectionSource,
  ContextSectionView,
  ContextSnapshotView,
  ContextUsageCategory,
  ContextUsageMessageBreakdown,
  ContextUsageSkillDetail,
  ContextUsageSnapshotView,
  ContextUsageToolDetail,
} from "../src/shared.js";

import { isRecord, numberValue, stringValue } from "./sources.js";

import type { DbObservation, LoadedObservation, LogRecord } from "./types.js";

import {
  arrayValue,
  categorizeSection,
  compareIsoAsc,
  contextUsageSourceValue,
  estimateTokens,
  isContextBuiltLog,
  isContextUsageSnapshotLog,
  modelName,
  preview,
  slug,
  tokenConfidenceValue,
  tokenMethodValue,
} from "./analyzer-values.js";

export function buildContextSnapshots(
  traceId: string,
  observation: LoadedObservation,
): ContextSnapshotView[] {
  const snapshots: ContextSnapshotView[] = [];

  for (const event of observation.events.records) {
    if (event.traceId !== traceId || event.type !== "model_request") continue;
    const messages = arrayValue(event.payload?.messages).filter(isRecord);
    const systemMessage = messages.find((message) => message.role === "system");
    const systemPrompt = stringValue(systemMessage?.content);
    const sections = systemPrompt
      ? deriveSectionsFromSystemPrompt(systemPrompt)
      : sectionsFromPayload(event.payload);
    snapshots.push(
      finalizeContextSnapshot({
        id: `event:${event.id}:context`,
        at: event.timestamp,
        traceId: event.traceId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        model: modelName(event.payload),
        messageCount: messages.length,
        sections,
        systemPrompt,
        observationLevel: systemPrompt ? "full" : sections.length > 0 ? "metadata" : "inferred",
        warnings: systemPrompt ? [] : ["当前数据源里的 model_request 没有完整 system prompt。"],
      }),
    );
  }

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextBuiltLog(log)) continue;
    const sections = sectionsFromContextBuiltLog(log);
    const hasFullContent = sections.some((section) => section.content);
    snapshots.push(
      finalizeContextSnapshot({
        id: `log:${log.sourcePath}:${log.line}:context`,
        at: log.timestamp,
        traceId: log.traceId,
        sessionId: log.sessionId,
        turnId: log.turnId,
        messageCount: 0,
        sections,
        observationLevel: hasFullContent ? "full" : "metadata",
        warnings: hasFullContent
          ? []
          : ["结构化日志只包含 section 元数据，没有完整 section 文本。"],
      }),
    );
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

export function buildContextUsageSnapshots(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): ContextUsageSnapshotView[] {
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextUsageSnapshotLog(log)) continue;
    const context = log.context ?? {};
    const categories = arrayValue(context.categories)
      .filter(isRecord)
      .map((category, index) => usageCategoryFromRecord(category, index));
    const totalTokens =
      numberValue(context.totalTokens) ??
      categories.reduce((sum, category) => sum + category.tokens, 0);
    const totalChars =
      numberValue(context.totalChars) ??
      categories.reduce((sum, category) => sum + category.chars, 0);
    const categoriesWithPercent = categories.map((category) => ({
      ...category,
      percentTokens:
        numberValue(category.percentTokens) ??
        (totalTokens > 0 ? category.tokens / totalTokens : 0),
    }));

    snapshots.push({
      id: `log:${log.sourcePath}:${log.line}:context-usage`,
      at: log.timestamp,
      traceId: log.traceId,
      sessionId: log.sessionId,
      turnId: log.turnId,
      model: stringValue(context.model),
      totalChars,
      totalTokens,
      tokenMethod: tokenMethodValue(context.tokenMethod),
      confidence: tokenConfidenceValue(context.confidence),
      tokenizer: stringValue(context.tokenizer),
      categories: categoriesWithPercent,
      systemTools: arrayValue(context.systemTools).filter(isRecord).map(usageToolFromRecord),
      mcpTools: arrayValue(context.mcpTools).filter(isRecord).map(usageToolFromRecord),
      skills: arrayValue(context.skills).filter(isRecord).map(usageSkillFromRecord),
      messageBreakdown: arrayValue(context.messageBreakdown)
        .filter(isRecord)
        .map(usageMessageBreakdownFromRecord),
      warnings: arrayValue(context.warnings).filter(
        (warning): warning is string => typeof warning === "string",
      ),
    });
  }

  if (snapshots.length === 0) {
    snapshots.push(...contextUsageSnapshotsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

function contextUsageSnapshotsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): ContextUsageSnapshotView[] {
  if (!db || sessions.size === 0) return [];
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const inputTokens = numberValue(tokens.input) ?? 0;
    if (inputTokens <= 0) continue;

    snapshots.push({
      id: `sqlite:${part.id}:context-usage`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      totalChars: 0,
      totalTokens: inputTokens,
      tokenMethod: "provider_usage",
      confidence: "low",
      categories: [
        {
          id: `sqlite-input:${part.id}`,
          name: "模型输入（SQLite 聚合）",
          source: "other",
          chars: 0,
          tokens: inputTokens,
          percentTokens: 1,
          tokenMethod: "provider_usage",
          confidence: "low",
        },
      ],
      systemTools: [],
      mcpTools: [],
      skills: [],
      messageBreakdown: [],
      warnings: [
        "SQLite step-finish 只保存聚合 input token，无法拆分系统提示、技能、工具和消息。",
        "要看真实上下文分块，需要用 dev 运行形态重新运行被测 CLI。",
      ],
    });
  }

  return snapshots;
}

function usageCategoryFromRecord(
  category: Record<string, unknown>,
  index: number,
): ContextUsageCategory {
  const name = stringValue(category.name) ?? `分类 ${index + 1}`;
  return {
    id: stringValue(category.id) ?? slug(`${index}-${name}`),
    name,
    source: contextUsageSourceValue(category.source),
    chars: numberValue(category.chars) ?? 0,
    tokens: numberValue(category.tokens) ?? 0,
    percentTokens: numberValue(category.percentTokens) ?? 0,
    tokenMethod: tokenMethodValue(category.tokenMethod),
    confidence: tokenConfidenceValue(category.confidence),
    tokenizer: stringValue(category.tokenizer),
  };
}

function usageToolFromRecord(tool: Record<string, unknown>): ContextUsageToolDetail {
  return {
    name: stringValue(tool.name) ?? "unknown",
    source: stringValue(tool.source) === "mcp_tool" ? "mcp_tool" : "system_tool",
    chars: numberValue(tool.chars),
    tokens: numberValue(tool.tokens) ?? 0,
    tokenMethod: tokenMethodValue(tool.tokenMethod),
    confidence: tokenConfidenceValue(tool.confidence),
    tokenizer: stringValue(tool.tokenizer),
    readOnly: typeof tool.readOnly === "boolean" ? tool.readOnly : undefined,
    serverName: stringValue(tool.serverName),
    sideEffectScope: stringValue(tool.sideEffectScope),
  };
}

function usageSkillFromRecord(skill: Record<string, unknown>): ContextUsageSkillDetail {
  return {
    name: stringValue(skill.name) ?? "unknown",
    source: stringValue(skill.source),
    scope: stringValue(skill.scope),
    path: stringValue(skill.path),
    chars: numberValue(skill.chars),
    tokens: numberValue(skill.tokens) ?? 0,
    tokenMethod: tokenMethodValue(skill.tokenMethod),
    confidence: tokenConfidenceValue(skill.confidence),
    tokenizer: stringValue(skill.tokenizer),
  };
}

function usageMessageBreakdownFromRecord(
  message: Record<string, unknown>,
): ContextUsageMessageBreakdown {
  return {
    role: stringValue(message.role) ?? "unknown",
    count: numberValue(message.count) ?? 0,
    chars: numberValue(message.chars) ?? 0,
    tokens: numberValue(message.tokens) ?? 0,
    tokenMethod: tokenMethodValue(message.tokenMethod),
    confidence: tokenConfidenceValue(message.confidence),
    tokenizer: stringValue(message.tokenizer),
  };
}

function finalizeContextSnapshot(
  input: Omit<ContextSnapshotView, "totalChars" | "totalTokens">,
): ContextSnapshotView {
  const totalTokens = input.sections.reduce((sum, section) => sum + section.tokens, 0);
  const totalChars = input.sections.reduce((sum, section) => sum + section.chars, 0);
  const sections = input.sections.map((section) => ({
    ...section,
    percentTokens: totalTokens > 0 ? section.tokens / totalTokens : 0,
  }));
  return {
    ...input,
    totalChars,
    totalTokens,
    sections,
  };
}

function deriveSectionsFromSystemPrompt(systemPrompt: string): ContextSectionView[] {
  const matches = [...systemPrompt.matchAll(/^(#{1,2})\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [
      makeSection({
        id: "system-prompt",
        name: "系统提示",
        source: "system_prompt",
        content: systemPrompt,
        observable: "full",
      }),
    ];
  }

  const sections: ContextSectionView[] = [];
  const firstIndex = matches[0]?.index ?? 0;
  if (firstIndex > 0) {
    const preamble = systemPrompt.slice(0, firstIndex).trim();
    if (preamble.length > 0) {
      sections.push(
        makeSection({
          id: "preamble",
          name: "系统提示",
          source: "system_prompt",
          content: preamble,
          observable: "full",
        }),
      );
    }
  }

  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? systemPrompt.length;
    const name = match[2]?.trim() ?? "段落";
    const content = systemPrompt.slice(start, end).trim();
    sections.push(
      makeSection({
        id: slug(`${index}-${name}`),
        name,
        source: categorizeSection(name),
        content,
        observable: "full",
      }),
    );
  }

  return sections;
}

function sectionsFromPayload(payload?: Record<string, unknown>): ContextSectionView[] {
  const snapshot = isRecord(payload?.contextSnapshot) ? payload.contextSnapshot : undefined;
  const rawSections = arrayValue(snapshot?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `payload-${index}`));
}

function sectionsFromContextBuiltLog(log: LogRecord): ContextSectionView[] {
  const rawSections = arrayValue(log.context?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `log-${index}`));
}

function sectionFromMetadata(
  section: Record<string, unknown>,
  fallbackId: string,
): ContextSectionView {
  const name = stringValue(section.name) ?? fallbackId;
  const preview = stringValue(section.preview);
  return {
    id: stringValue(section.id) ?? slug(name),
    name,
    source: categorizeSection(stringValue(section.source) ?? name),
    chars: numberValue(section.chars) ?? preview?.length ?? 0,
    tokens: numberValue(section.tokens) ?? estimateTokens(preview ?? ""),
    percentTokens: 0,
    preview,
    content: stringValue(section.content),
    observable: stringValue(section.content) ? "full" : "metadata",
  };
}

function makeSection(input: {
  id: string;
  name: string;
  source: ContextSectionSource;
  content: string;
  observable: "full" | "metadata" | "inferred";
}): ContextSectionView {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    percentTokens: 0,
    preview: preview(input.content),
    content: input.content,
    observable: input.observable,
  };
}
