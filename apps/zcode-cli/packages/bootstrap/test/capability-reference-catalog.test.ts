import assert from "node:assert/strict";
import test from "node:test";
import { getPluginReferenceCatalog } from "../src/zcode-protocol/plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";

const workspace = { workspacePath: process.cwd(), workspaceKey: process.cwd() };
const adoptedStatus = { revision: "revision-a", status: "ready" as const };

function contextFor(app: object) {
  return {
    deps: {},
    sessions: new Map([["session-a", { app }]]),
  } as any;
}

test("session skill catalogs refresh before reading the adopted snapshot", async () => {
  const calls: string[] = [];
  const result = await getSkillReferenceCatalog(
    contextFor({
      async refreshCapabilities() {
        calls.push("refresh");
        return adoptedStatus;
      },
      async getSkillCatalog() {
        calls.push("catalog");
        return {
          skills: [
            {
              name: "example-skill",
              description: "Example skill",
              path: "/workspace/.agents/skills/example/SKILL.md",
              scope: "project",
              source: "workspace",
            },
          ],
        };
      },
    }),
    { workspace, sessionId: "session-a" },
  );

  assert.deepEqual(calls, ["refresh", "catalog"]);
  assert.deepEqual(result, {
    authority: "session",
    capabilityStatus: adoptedStatus,
    skills: [
      {
        id: "glm:workspace:/workspace/.agents/skills/example/SKILL.md",
        name: "example-skill",
        description: "Example skill",
        path: "/workspace/.agents/skills/example/SKILL.md",
        scope: "workspace",
        enabled: true,
      },
    ],
  });
});

test("session plugin catalogs carry the status of the adopted capability snapshot", async () => {
  const calls: string[] = [];
  const result = await getPluginReferenceCatalog(
    contextFor({
      async refreshCapabilities() {
        calls.push("refresh");
        return adoptedStatus;
      },
      getPluginReferenceCatalog() {
        calls.push("catalog");
        return {
          plugins: [
            {
              pluginId: "example@official",
              name: "Example",
              marketplace: "official",
              enabled: true,
              conflictingPluginIds: [],
              skillQualifiedNames: [],
              mcpServerNames: [],
              subagentNames: [],
            },
          ],
        };
      },
    }),
    { workspace, sessionId: "session-a" },
  );

  assert.deepEqual(calls, ["refresh", "catalog"]);
  assert.deepEqual(result, {
    authority: "session",
    capabilityStatus: adoptedStatus,
    plugins: [
      {
        pluginId: "example@official",
        name: "Example",
        marketplace: "official",
        enabled: true,
        conflictingPluginIds: [],
        skillQualifiedNames: [],
        mcpServerNames: [],
        subagentNames: [],
      },
    ],
  });
});
