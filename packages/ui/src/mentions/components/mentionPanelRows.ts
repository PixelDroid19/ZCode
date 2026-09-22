export interface MentionPanelRowOption {
  id: string;
}

export interface MentionPanelRowSection<TOption extends MentionPanelRowOption> {
  id: string;
  title: string;
  options: TOption[];
  emptyText: string;
  loadingText?: string;
  loading?: boolean;
  errorText?: string | null;
}

export type MentionPanelVirtualRow<TOption extends MentionPanelRowOption> =
  | {
      kind: "section_header";
      sectionId: string;
      title: string;
    }
  | {
      kind: "status";
      sectionId: string;
      content: "loading" | "error" | "empty";
      text: string;
    }
  | {
      kind: "option";
      sectionId: string;
      option: TOption;
      flatOptionIndex: number;
    };

/**
 * A capability reload failure does not invalidate the runtime's adopted catalog.
 * Keep a supplemental status row separate from its still-selectable last-good options.
 */
export function buildMentionPanelVirtualRows<TOption extends MentionPanelRowOption>(
  sections: MentionPanelRowSection<TOption>[],
): MentionPanelVirtualRow<TOption>[] {
  const rows: MentionPanelVirtualRow<TOption>[] = [];
  let flatOptionIndex = 0;
  const shouldRenderSectionHeader = sections.length > 1;

  for (const section of sections) {
    if (shouldRenderSectionHeader && section.title.trim().length > 0) {
      rows.push({
        kind: "section_header",
        sectionId: section.id,
        title: section.title,
      });
    }

    const status = section.errorText
      ? {
          content: "error" as const,
          text: section.errorText,
        }
      : section.loading
        ? {
            content: "loading" as const,
            text: section.loadingText ?? section.emptyText,
          }
        : undefined;
    if (status) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        ...status,
      });
    }
    if (section.options.length === 0 && !status) {
      rows.push({
        kind: "status",
        sectionId: section.id,
        content: "empty",
        text: section.emptyText,
      });
    }
    for (const option of section.options) {
      rows.push({
        kind: "option",
        sectionId: section.id,
        option,
        flatOptionIndex,
      });
      flatOptionIndex += 1;
    }
  }

  return rows;
}
