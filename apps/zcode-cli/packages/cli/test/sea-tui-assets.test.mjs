import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import * as seaAssets from "../scripts/sea-tui-assets.mjs";

const sourceExport = { ".": "./src/index.ts" };

async function writePackage(directory, manifest, files = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest, null, 2));
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}

async function createRuntimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-assets-"));
  const repositoryRoot = join(directory, "repository");
  const root = join(repositoryRoot, "apps", "zcode-cli");
  const tuiDirectory = join(root, "packages", "tui");
  const sharedDirectory = join(repositoryRoot, "packages", "shared");
  const modelMapDirectory = join(repositoryRoot, "packages", "model-option-map");

  await writePackage(tuiDirectory, {
    name: "@zcode/tui",
    dependencies: {
      "@mbears/opentui-core": "1.0.0",
      "@mbears/opentui-react": "1.0.0",
      "@zcode/shared": "workspace:*",
      react: "1.0.0",
      "react-devtools-core": "1.0.0",
      ws: "1.0.0",
    },
    exports: sourceExport,
  });
  await writePackage(sharedDirectory, {
    name: "@zcode/shared",
    dependencies: { "@zcode/model-option-map": "workspace:*" },
    exports: sourceExport,
  });
  await writePackage(modelMapDirectory, {
    name: "@zcode/model-option-map",
    exports: sourceExport,
  });

  const nodeModules = join(tuiDirectory, "node_modules");
  for (const packageName of [
    "@mbears/opentui-core",
    "@mbears/opentui-core-linux-x64",
    "@mbears/opentui-core-win32-x64",
    "@mbears/opentui-react",
    "react",
    "react-devtools-core",
    "ws",
  ]) {
    await writePackage(
      join(nodeModules, ...packageName.split("/")),
      {
        name: packageName,
        main: "./index.js",
      },
      { "index.js": "module.exports = {};\n" },
    );
  }

  return {
    directory,
    modelMapDirectory,
    root,
    sharedDirectory,
    tuiDirectory,
  };
}

test("prepares the current external workspace closure before staging cross-platform assets", async () => {
  const fixture = await createRuntimeFixture();
  try {
    assert.equal(typeof seaAssets.collectSeaTuiExternalWorkspaceBuilds, "function");
    const externalBuilds = await seaAssets.collectSeaTuiExternalWorkspaceBuilds({
      root: fixture.root,
      target: "win-x64",
    });
    assert.deepEqual(
      externalBuilds.map(({ packageName }) => packageName),
      ["@zcode/model-option-map", "@zcode/shared"],
    );

    for (const packageDirectory of [
      fixture.modelMapDirectory,
      fixture.sharedDirectory,
      fixture.tuiDirectory,
    ]) {
      await mkdir(join(packageDirectory, "dist"), { recursive: true });
      await writeFile(join(packageDirectory, "dist", "index.js"), "export {};\n");
    }

    const stagingDirectory = join(fixture.directory, "staging");
    const { assets, manifest } = await seaAssets.collectSeaTuiAssets({
      root: fixture.root,
      stagingDirectory,
      target: "win-x64",
    });
    const modelMapAsset = "zcode-tui-runtime/node_modules/@zcode/model-option-map/dist/index.js";
    assert.ok(assets[modelMapAsset]);
    assert.ok(
      manifest.files.some(({ path }) => path === modelMapAsset.replace("zcode-tui-runtime/", "")),
    );
    assert.ok(
      Object.keys(assets).some((assetPath) =>
        assetPath.endsWith("@mbears/opentui-core-win32-x64/index.js"),
      ),
    );
    assert.ok(manifest.files.every(({ path }) => !path.includes("\\")));

    const stagedModelMapManifest = JSON.parse(
      await readFile(
        assets["zcode-tui-runtime/node_modules/@zcode/model-option-map/package.json"],
        "utf8",
      ),
    );
    assert.deepEqual(stagedModelMapManifest.exports, { ".": "./dist/index.js" });
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});
