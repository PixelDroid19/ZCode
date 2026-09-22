import assert from "node:assert/strict";
import test from "node:test";
import {
  callControl,
  launchPickerBrowserPage,
  replaceComposerText,
  skillOptionSelector,
  waitForRequestCount,
  waitForSelectedSkill,
  waitForSkillOption,
} from "./fixtures/pickerBrowserHarness.mjs";

function skill(id) {
  return {
    id,
    name: id,
    description: `Description for ${id}`,
    path: `/workspace/.zcode/skills/${id}/SKILL.md`,
    scope: "workspace",
    enabled: true,
  };
}

function plugin(id, conflicts = []) {
  return {
    pluginId: `fixture/${id}`,
    name: id,
    marketplace: "fixture-marketplace",
    enabled: true,
    conflictingPluginIds: conflicts,
    skillQualifiedNames: [],
    mcpServerNames: [],
    subagentNames: [],
  };
}

test(
  "real picker selection follows stable item ids across live catalog changes",
  { timeout: 120_000 },
  async () => {
    const { page, pageErrors, close } = await launchPickerBrowserPage({
      width: 1100,
      height: 800,
    });
    try {
      await page.getByTestId("composer-editor").click();
      await page.keyboard.type("$");
      await waitForRequestCount(page, "picker-attachment-a", "skills", 1);
      await waitForSkillOption(page, "picker-attachment-a-skill");
      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        skill("selection-first"),
        skill("keyboard-target"),
        skill("mouse-target"),
      ]);
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "selection-1",
      );
      await waitForRequestCount(page, "picker-attachment-a", "skills", 2);
      await waitForSkillOption(page, "mouse-target");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await waitForSelectedSkill(page, "mouse-target");

      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        skill("selection-inserted"),
        skill("selection-first"),
        skill("keyboard-target"),
        skill("mouse-target"),
      ]);
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "selection-2",
      );
      await waitForRequestCount(page, "picker-attachment-a", "skills", 3);
      await waitForSelectedSkill(page, "mouse-target");
      await page.keyboard.press("Enter");
      await page.locator('[data-mention-id="skill:mouse-target"]').waitFor({ state: "visible" });

      await replaceComposerText(page, "$");
      await waitForRequestCount(page, "picker-attachment-a", "skills", 4);
      await waitForSkillOption(page, "keyboard-target");
      await page.locator(skillOptionSelector("keyboard-target")).click();
      await page.locator('[data-mention-id="skill:keyboard-target"]').waitFor({ state: "visible" });

      await replaceComposerText(page, "$");
      await waitForRequestCount(page, "picker-attachment-a", "skills", 5);
      await waitForSkillOption(page, "mouse-target");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await waitForSelectedSkill(page, "mouse-target");
      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        skill("selection-inserted"),
        skill("selection-first"),
        skill("keyboard-target"),
      ]);
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "selection-3",
      );
      await waitForRequestCount(page, "picker-attachment-a", "skills", 6);
      await waitForSelectedSkill(page, "selection-inserted");
      await page.keyboard.press("Tab");
      await page
        .locator('[data-mention-id="skill:selection-inserted"]')
        .waitFor({ state: "visible" });

      await callControl(page, "setCatalog", "picker-attachment-a", "plugins", [
        plugin("conflict-first", ["fixture/conflicting-copy"]),
        plugin("enabled-a"),
        plugin("enabled-b"),
      ]);
      await replaceComposerText(page, "@");
      await waitForRequestCount(page, "picker-attachment-a", "plugins", 1);
      await page.locator('[data-option-id="plugin:fixture/enabled-b"]').waitFor({
        state: "visible",
      });
      await page
        .locator('[data-option-id="plugin:fixture/enabled-a"][data-selected="true"]')
        .waitFor({ state: "visible" });
      await page.keyboard.press("ArrowDown");
      await page
        .locator('[data-option-id="plugin:fixture/enabled-b"][data-selected="true"]')
        .waitFor({ state: "visible" });

      await callControl(page, "setCatalog", "picker-attachment-a", "plugins", [
        plugin("conflict-first", ["fixture/conflicting-copy"]),
        plugin("enabled-a"),
        plugin("enabled-b", ["fixture/enabled-b-copy"]),
      ]);
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "selection-4",
      );
      await waitForRequestCount(page, "picker-attachment-a", "plugins", 2);
      await page
        .locator('[data-option-id="plugin:fixture/enabled-a"][data-selected="true"]')
        .waitFor({ state: "visible" });
      await page.keyboard.press("Enter");
      await page
        .locator('[data-mention-id="plugin:fixture/enabled-a"]')
        .waitFor({ state: "visible" });

      assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join(" | ")}`);
    } finally {
      await close();
    }
  },
);
