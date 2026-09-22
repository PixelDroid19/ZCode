import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMentionPanelVirtualRows,
  type MentionPanelRowSection,
} from "../src/mentions/components/mentionPanelRows.js";

interface TestOption {
  id: string;
  label: string;
  description: string;
}

type TestSection = MentionPanelRowSection<TestOption>;

function section(input: Partial<TestSection> & Pick<TestSection, "id">): TestSection {
  return {
    emptyText: "No options",
    options: [],
    title: input.id,
    ...input,
  };
}

test("reload status rows retain selectable last-good options and their flat indices", () => {
  const rows = buildMentionPanelVirtualRows([
    section({
      id: "plugins",
      errorText: "Capability refresh failed",
      options: [
        { id: "plugin:a", label: "A", description: "" },
        { id: "plugin:b", label: "B", description: "" },
      ],
    }),
    section({
      id: "skills",
      loading: true,
      loadingText: "Refreshing skills",
      options: [{ id: "skill:a", label: "A", description: "" }],
    }),
  ]);

  assert.deepEqual(
    rows
      .filter((row) => row.kind === "status")
      .map((row) => ({ content: row.content, sectionId: row.sectionId, text: row.text })),
    [
      { content: "error", sectionId: "plugins", text: "Capability refresh failed" },
      { content: "loading", sectionId: "skills", text: "Refreshing skills" },
    ],
  );
  assert.deepEqual(
    rows
      .filter((row) => row.kind === "option")
      .map((row) => ({
        flatOptionIndex: row.flatOptionIndex,
        id: row.option.id,
        sectionId: row.sectionId,
      })),
    [
      { flatOptionIndex: 0, id: "plugin:a", sectionId: "plugins" },
      { flatOptionIndex: 1, id: "plugin:b", sectionId: "plugins" },
      { flatOptionIndex: 2, id: "skill:a", sectionId: "skills" },
    ],
  );
});
