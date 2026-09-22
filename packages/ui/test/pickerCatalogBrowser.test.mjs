import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  callControl,
  launchPickerBrowserPage,
  replaceComposerText,
  skillOptionSelector,
  waitForNoSkillOption,
  waitForSkillOption,
} from "./fixtures/pickerBrowserHarness.mjs";

test(
  "real picker retains same-authority catalogs through reopen, refresh failure, session change, and reconnect",
  { timeout: 120_000 },
  async () => {
    const { page, pageErrors, close } = await launchPickerBrowserPage({
      width: 1100,
      height: 800,
    });
    try {
      await page.getByTestId("composer-editor").click();
      await page.keyboard.type("$");
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 1,
      );

      const initialSkill = "picker-attachment-a-skill";
      await waitForSkillOption(page, initialSkill);
      await page.screenshot({ path: path.join(tmpdir(), "zcode-picker-retention-desktop.png") });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.screenshot({ path: path.join(tmpdir(), "zcode-picker-retention-mobile.png") });
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.locator(skillOptionSelector(initialSkill)).click();
      await page.locator(`[data-mention-id="skill:${initialSkill}"]`).waitFor({
        state: "visible",
      });

      await replaceComposerText(page, "");
      await callControl(page, "setNextBehavior", "picker-attachment-a", "skills", "defer");
      await replaceComposerText(page, "$");
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 2,
      );
      // The last successful catalog must stay visible while the reopen request is pending.
      await waitForSkillOption(page, initialSkill);
      await page.locator('[data-section-id="skills"][data-status="loading"]').waitFor({
        state: "visible",
      });

      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        {
          id: "refreshed-skill",
          name: "refreshed-skill",
          description: "Refreshed catalog entry",
          path: "/workspace/.zcode/skills/refreshed-skill/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ]);
      await callControl(page, "resolveRequest", "picker-attachment-a", "skills", 2);
      await waitForSkillOption(page, "refreshed-skill");
      await waitForNoSkillOption(page, initialSkill);

      await replaceComposerText(page, "");
      await callControl(page, "setNextBehavior", "picker-attachment-a", "skills", "reject");
      await replaceComposerText(page, "$");
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 3,
      );
      await waitForSkillOption(page, "refreshed-skill");
      await page
        .locator('[data-section-id="skills"][data-status="error"]')
        .waitFor({ state: "visible" });

      // A newer capability revision wins over an earlier in-flight catalog response.
      await callControl(page, "setNextBehavior", "picker-attachment-a", "skills", "defer");
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "revision-1",
      );
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 4,
      );
      await waitForSkillOption(page, "refreshed-skill");

      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        {
          id: "latest-revision-skill",
          name: "latest-revision-skill",
          description: "Latest revision",
          path: "/workspace/.zcode/skills/latest-revision-skill/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ]);
      await callControl(
        page,
        "publishCapabilityRevision",
        "picker-attachment-a",
        "session-a",
        "revision-2",
      );
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 5,
      );
      await waitForSkillOption(page, "latest-revision-skill");
      await callControl(page, "resolveRequest", "picker-attachment-a", "skills", 4);
      await waitForSkillOption(page, "latest-revision-skill");
      await waitForNoSkillOption(page, "refreshed-skill");

      // Exercise the actual plugin catalog hook through its open/close request lifecycle too.
      await callControl(page, "setPluginProbeEnabled", true);
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "plugins") === 1,
      );
      await page.getByTestId("plugin-probe-entry-picker-attachment-a-plugin").waitFor();
      await callControl(page, "setPluginProbeEnabled", false);
      await callControl(page, "setNextBehavior", "picker-attachment-a", "plugins", "defer");
      await callControl(page, "setPluginProbeEnabled", true);
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "plugins") === 2,
      );
      await page.getByTestId("plugin-probe-entry-picker-attachment-a-plugin").waitFor();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="plugin-catalog-probe"]')?.dataset.loading ===
          "true",
      );

      await callControl(page, "setCatalog", "picker-attachment-a", "plugins", [
        {
          pluginId: "fixture/refreshed-plugin",
          name: "refreshed-plugin",
          marketplace: "fixture-marketplace",
          enabled: true,
          conflictingPluginIds: [],
          skillQualifiedNames: [],
          mcpServerNames: [],
          subagentNames: [],
        },
      ]);
      await callControl(page, "resolveRequest", "picker-attachment-a", "plugins", 2);
      await page.getByTestId("plugin-probe-entry-refreshed-plugin").waitFor();

      await callControl(page, "setPluginProbeEnabled", false);
      await callControl(page, "setCatalog", "picker-attachment-a", "skills", [
        {
          id: "session-b-skill",
          name: "session-b-skill",
          description: "Session B catalog",
          path: "/workspace/.zcode/skills/session-b-skill/SKILL.md",
          scope: "workspace",
          enabled: true,
        },
      ]);
      await callControl(page, "setSessionId", "session-b");
      await waitForNoSkillOption(page, "latest-revision-skill");
      await waitForSkillOption(page, "session-b-skill");
      const sessionRequest = await callControl(
        page,
        "requestParams",
        "picker-attachment-a",
        "skills",
        6,
      );
      assert.equal(sessionRequest.sessionId, "session-b");

      await callControl(page, "switchAttachment", "picker-attachment-b");
      await waitForNoSkillOption(page, "session-b-skill");
      await waitForSkillOption(page, "picker-attachment-b-skill");
      const attachmentRequest = await callControl(
        page,
        "requestParams",
        "picker-attachment-b",
        "skills",
        1,
      );
      assert.equal(attachmentRequest.remoteSessionId, "picker-attachment-b");

      const reconnectedLabel = await callControl(
        page,
        "reconnectAttachment",
        "picker-attachment-b",
      );
      await waitForNoSkillOption(page, "picker-attachment-b-skill");
      await waitForSkillOption(page, `${reconnectedLabel}-skill`);
      assert.equal(
        await callControl(page, "requestCount", reconnectedLabel, "skills"),
        1,
        "reconnecting must bootstrap a fresh session catalog",
      );

      assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join(" | ")}`);
    } finally {
      await close();
    }
  },
);
