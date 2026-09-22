import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const uiSourceDirectory = path.resolve(testDirectory, "../src");
const fixturePagePath = "/packages/ui/test/fixtures/pickerBrowserFixture.html";

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local browser test port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function systemChromiumCandidates() {
  if (process.platform === "win32") {
    return [
      path.join(
        process.env.PROGRAMFILES || "C:\\Program Files",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(process.env.LOCALAPPDATA || "", "Chromium/Application/chrome.exe"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ];
}

async function isExecutableFile(candidate) {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromiumExecutable() {
  const explicitPath = process.env.ZCODE_TEST_CHROMIUM_PATH;
  if (explicitPath) {
    assert.ok(
      await isExecutableFile(explicitPath),
      `ZCODE_TEST_CHROMIUM_PATH does not exist: ${explicitPath}`,
    );
    return explicitPath;
  }

  for (const candidate of [chromium.executablePath(), ...systemChromiumCandidates()]) {
    if (await isExecutableFile(candidate)) return candidate;
  }

  throw new Error(
    "Chromium is required for this browser integration test. Install the Playwright-managed Chromium browser or set ZCODE_TEST_CHROMIUM_PATH to an installed Chromium/Chrome executable. The test is not skipped.",
  );
}

async function callControl(page, method, ...args) {
  return page.evaluate(
    ([controlMethod, controlArgs]) => {
      const control = window.__pickerBrowser;
      if (!control) throw new Error("Picker browser controls are not mounted");
      return control[controlMethod](...controlArgs);
    },
    [method, args],
  );
}

function optionSelector(id) {
  return `[data-option-id="skill:${id}"]`;
}

async function waitForOption(page, id) {
  await page.locator(optionSelector(id)).waitFor({ state: "visible" });
}

async function waitForNoOption(page, id) {
  await page.waitForFunction(
    (selector) => document.querySelector(selector) === null,
    optionSelector(id),
  );
}

async function replaceComposerText(page, text) {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  if (text) await page.keyboard.type(text);
}

test(
  "real picker retains same-authority catalogs through reopen, refresh failure, session change, and reconnect",
  { timeout: 120_000 },
  async () => {
    const executablePath = await resolveChromiumExecutable();
    const port = await findFreePort();
    const viteServer = await createServer({
      configFile: false,
      esbuild: { jsx: "automatic" },
      logLevel: "error",
      plugins: [tailwindcss()],
      resolve: { alias: { "@": uiSourceDirectory } },
      root: repositoryRoot,
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    let browser;
    try {
      await viteServer.listen();
      const address = viteServer.httpServer.address();
      assert.ok(address && typeof address === "object", "Vite fixture server must listen on TCP");
      const fixtureUrl = `http://127.0.0.1:${address.port}${fixturePagePath}`;
      browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const pageErrors = [];
      const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(fixtureUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__pickerBrowser));

      await page.getByTestId("composer-editor").click();
      await page.keyboard.type("$");
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 1,
      );

      const initialSkill = "picker-attachment-a-skill";
      await waitForOption(page, initialSkill);
      await page.screenshot({ path: path.join(tmpdir(), "zcode-picker-retention-desktop.png") });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.screenshot({ path: path.join(tmpdir(), "zcode-picker-retention-mobile.png") });
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.locator(optionSelector(initialSkill)).click();
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
      await waitForOption(page, initialSkill);
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
      await waitForOption(page, "refreshed-skill");
      await waitForNoOption(page, initialSkill);

      await replaceComposerText(page, "");
      await callControl(page, "setNextBehavior", "picker-attachment-a", "skills", "reject");
      await replaceComposerText(page, "$");
      await page.waitForFunction(
        () => window.__pickerBrowser.requestCount("picker-attachment-a", "skills") === 3,
      );
      await waitForOption(page, "refreshed-skill");
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
      await waitForOption(page, "refreshed-skill");

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
      await waitForOption(page, "latest-revision-skill");
      await callControl(page, "resolveRequest", "picker-attachment-a", "skills", 4);
      await waitForOption(page, "latest-revision-skill");
      await waitForNoOption(page, "refreshed-skill");

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
      await waitForNoOption(page, "latest-revision-skill");
      await waitForOption(page, "session-b-skill");
      const sessionRequest = await callControl(
        page,
        "requestParams",
        "picker-attachment-a",
        "skills",
        6,
      );
      assert.equal(sessionRequest.sessionId, "session-b");

      await callControl(page, "switchAttachment", "picker-attachment-b");
      await waitForNoOption(page, "session-b-skill");
      await waitForOption(page, "picker-attachment-b-skill");
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
      await waitForNoOption(page, "picker-attachment-b-skill");
      await waitForOption(page, `${reconnectedLabel}-skill`);
      assert.equal(
        await callControl(page, "requestCount", reconnectedLabel, "skills"),
        1,
        "reconnecting must bootstrap a fresh session catalog",
      );

      assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join(" | ")}`);
    } finally {
      await browser?.close();
      await viteServer.close();
    }
  },
);
