import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer as createNetServer } from "node:net";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import tailwindcss from "@tailwindcss/vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../../..");
const uiSourceDirectory = path.resolve(testDirectory, "../../src");
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

function chromiumCandidates() {
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
  for (const candidate of [chromium.executablePath(), ...chromiumCandidates()]) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    "Chromium is required for this browser integration test. Install the Playwright-managed Chromium browser or set ZCODE_TEST_CHROMIUM_PATH to an installed Chromium/Chrome executable. The test is not skipped.",
  );
}

export async function launchPickerBrowserPage(viewport) {
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
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage({ viewport });
    const pageErrors = [];
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}${fixturePagePath}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => Boolean(window.__pickerBrowser));
    return {
      page,
      pageErrors,
      close: async () => {
        await browser?.close();
        await viteServer.close();
      },
    };
  } catch (error) {
    await browser?.close();
    await viteServer.close();
    throw error;
  }
}

export async function callControl(page, method, ...args) {
  return page.evaluate(
    ([controlMethod, controlArgs]) => {
      const control = window.__pickerBrowser;
      if (!control) throw new Error("Picker browser controls are not mounted");
      return control[controlMethod](...controlArgs);
    },
    [method, args],
  );
}

export function skillOptionSelector(id) {
  return `[data-option-id="skill:${id}"]`;
}

export async function waitForSkillOption(page, id) {
  await page.locator(skillOptionSelector(id)).waitFor({ state: "visible" });
}

export async function waitForNoSkillOption(page, id) {
  await page.waitForFunction(
    (selector) => document.querySelector(selector) === null,
    skillOptionSelector(id),
  );
}

export async function waitForSelectedSkill(page, id) {
  await page
    .locator(`${skillOptionSelector(id)}[data-selected="true"]`)
    .waitFor({ state: "visible" });
}

export async function waitForRequestCount(page, label, kind, count) {
  await page.waitForFunction(
    ([currentLabel, currentKind, currentCount]) =>
      window.__pickerBrowser.requestCount(currentLabel, currentKind) === currentCount,
    [label, kind, count],
  );
}

export async function replaceComposerText(page, text) {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  if (text) await page.keyboard.type(text);
}
