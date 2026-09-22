import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeFileSystemAdapter } from "../src/fs/index.js";

test("filesystem adapter retains file and text-search behavior after extraction", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-fs-extraction-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const javascript = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
  await javascript.createDirectory({ path: join(root, "nested") });
  await javascript.writeTextFile({
    content: "alpha\nbeta alpha\n",
    createParents: true,
    path: join(root, "nested", "one.txt"),
  });
  await javascript.writeTextFile({ content: "gamma\n", path: join(root, "two.md") });

  const read = await javascript.readTextFile({ path: join(root, "nested", "one.txt") });
  assert.equal(read.content, "alpha\nbeta alpha\n");
  assert.deepEqual((await javascript.searchFiles({ path: root, pattern: "**/*.txt" })).files, [
    join(root, "nested", "one.txt"),
  ]);
  const javascriptSearch = await javascript.searchText({
    path: root,
    pattern: "alpha",
    outputMode: "content",
  });
  assert.equal(javascriptSearch.numMatches, 2);
  assert.equal(javascriptSearch.entries.length, 2);

  const ripgrepSearch = await createNodeFileSystemAdapter().searchText({
    path: root,
    pattern: "alpha",
    outputMode: "count",
  });
  assert.equal(ripgrepSearch.numMatches, 2);
  assert.deepEqual(ripgrepSearch.entries, [{ count: 2, path: join(root, "nested", "one.txt") }]);
});
