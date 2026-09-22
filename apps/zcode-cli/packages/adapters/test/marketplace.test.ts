import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  addMarketplace,
  describeMarketplacePlugin,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  uninstallMarketplacePlugin,
  updateMarketplace,
} from "../src/plugins/marketplace.js";

test("local marketplaces preserve dependency installs and the last valid source after refresh failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-marketplace-test-"));
  const storageRoot = join(directory, "storage");
  const source = join(directory, "source");
  try {
    for (const name of ["base", "example"]) {
      await mkdir(join(source, name, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(source, name, ".zcode-plugin", "plugin.json"),
        JSON.stringify({ name, version: "1.0.0" }),
      );
      await writeFile(join(source, name, "fixture.txt"), `fixture ${name}`);
    }
    await writeFile(
      join(source, "marketplace.json"),
      JSON.stringify({
        name: "readiness",
        plugins: [
          { name: "base", source: "./base" },
          { name: "example", source: "./example", dependencies: ["base"] },
        ],
      }),
    );
    const record = await addMarketplace({
      source: { source: "directory", path: source },
      storageRoot,
    });
    assert.equal(record.id, "readiness");
    const installed = await installMarketplacePlugin({
      marketplace: "readiness",
      name: "example",
      storageRoot,
    });
    assert.deepEqual(installed.closure, ["base@readiness", "example@readiness"]);
    assert.equal(listInstalledPluginRecords(storageRoot).length, 2);
    for (const plugin of installed.installed) {
      assert.equal(
        await readFile(join(plugin.installPath, "fixture.txt"), "utf8"),
        `fixture ${plugin.name}`,
      );
    }
    const description = await describeMarketplacePlugin({
      marketplace: "readiness",
      name: "example",
      storageRoot,
    });
    assert.deepEqual(
      description.diagnostics.filter((item) => item.severity === "error"),
      [],
    );

    const lastValidManifest = loadMarketplaceManifestSync(storageRoot, "readiness");
    await writeFile(join(source, "marketplace.json"), "{invalid");
    assert.deepEqual(await updateMarketplace({ marketplace: "readiness", storageRoot }), []);
    assert.ok(
      loadKnownMarketplacesSync(storageRoot).find((item) => item.id === "readiness")
        ?.lastRefreshFailure,
    );
    assert.deepEqual(loadMarketplaceManifestSync(storageRoot, "readiness"), lastValidManifest);

    await uninstallMarketplacePlugin({
      pluginId: "example@readiness",
      storageRoot,
      removeCache: true,
    });
    assert.deepEqual(
      listInstalledPluginRecords(storageRoot).map((item) => item.name),
      ["base"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
