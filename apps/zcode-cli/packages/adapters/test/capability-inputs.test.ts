import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureSkillPort, fingerprintCapabilityInputs } from "../src/capability-inputs/index.js";

test("content revisions detect equal-size edits, deletion and late directory creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-input-test-"));
  try {
    const directory = join(root, "skills");
    const before = await fingerprintCapabilityInputs([directory]);
    await mkdir(directory);
    const path = join(directory, "SKILL.md");
    await writeFile(path, "first");
    const first = await fingerprintCapabilityInputs([directory]);
    await writeFile(path, "other");
    const second = await fingerprintCapabilityInputs([directory]);
    assert.notEqual(first, second);
    assert.notEqual(before, first);
    assert.equal(second, await fingerprintCapabilityInputs([directory]));
    await rm(path);
    assert.notEqual(second, await fingerprintCapabilityInputs([directory]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an adopted skill port retains its content after files change", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-skill-test-"));
  try {
    const path = join(root, "SKILL.md");
    await writeFile(
      path,
      "---\nname: example\ndescription: Example skill\n---\nOriginal instructions.",
    );
    const outcome = {
      skills: [
        {
          name: "example",
          description: "Example skill",
          path,
          directory: root,
          rootPath: root,
          scope: "project",
          source: "zcode",
          safeToAutoLoad: false,
          frontmatterKeys: [],
        },
      ],
      diagnostics: [],
      totalDiscovered: 1,
    } as any;
    const port = await captureSkillPort(outcome);
    await writeFile(path, "Changed while the model was running");
    const content = await port.loadSkill({ name: "example", workingDirectory: root });
    assert.equal(content.content, "Original instructions.");
    const catalog = await port.discoverSkills({ workingDirectory: root });
    catalog.skills.length = 0;
    assert.equal((await port.discoverSkills({ workingDirectory: root })).skills.length, 1);
    await assert.rejects(
      port.loadSkill({ name: "missing", workingDirectory: root }),
      /unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
