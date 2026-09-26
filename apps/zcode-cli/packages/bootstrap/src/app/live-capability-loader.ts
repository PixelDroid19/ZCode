import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConfig, type ConfigResult } from "@zcode/adapters/config";
import {
  captureSkillPort,
  fingerprintCapabilityInputs,
  fingerprintExplicitCapabilityFiles,
} from "@zcode/adapters/capability-inputs";
import { createNodeSkillAdapter, resolveDefaultSkillRoots } from "@zcode/adapters/skills";
import { loadLiveTools } from "@zcode/adapters/live-tools";
import { loadDirectoryMcpServers } from "@zcode/adapters/directory-mcp";
import { buildPluginReferenceCatalog, computeOfficialCuaServerNames } from "@zcode/core";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome, SkillRoot } from "@zcode/contracts";
import { resolveZCodePlugins } from "../plugins.js";
import { collectDisabledPaths } from "../skill-command-overrides.js";
import { loadPluginAgentProfiles, loadZCodeAgentProfiles } from "../subagents.js";
import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";
import type { LoadedCapabilityEnvironment } from "./live-capability-source.js";
import { prepareLiveToolEntries } from "./live-tool-entries.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveAppRuntimeConfig } from "./runtime-config.js";
import { resolveLiveToolNodeRuntime } from "./live-tool-node-runtime.js";
import { getPluginStorageRoot } from "./paths.js";
import { applyDirectoryMcpAugmentations } from "./live-mcp-configuration.js";
import { resolveMcpCodePaths } from "./live-mcp-command-paths.js";
import type { ZCodeAppOptions } from "./types.js";

export interface LiveCapabilityLoaderOptions {
  options: ZCodeAppOptions;
  initialConfig: ConfigResult;
  initialPlugins: PluginLoadOutcome;
  bundledSkillRoots?: readonly SkillRoot[];
  initialRuntimeConfig: AgentRuntimeConfig;
  cliStorageRoot: string;
  storageRoot: string;
  workingDirectory: string;
  logger: Logger;
  transformMcpServers?: (
    servers: Record<string, McpServerConfig>,
    features: AgentRuntimeConfig["runtimeFeatures"],
  ) => Record<string, McpServerConfig>;
  onWatchPaths?: (paths: readonly string[]) => void;
}

/** Legacy parsers remain behind their adapter API; unchanged content avoids reparsing. */
export function createLiveCapabilityLoader(input: LiveCapabilityLoaderOptions) {
  const { options, workingDirectory } = input;
  if (
    options.mcpServersSource === "directory" &&
    options.runtimeConfig?.mcp?.servers !== undefined &&
    options.mcpServersBase === undefined
  ) {
    throw new Error("Directory MCP runtime maps require their unaugmented base");
  }
  const homeDirectory = options.env?.HOME || options.env?.USERPROFILE || homedir();
  let paths = capabilityInputPaths(input.initialConfig, input.initialPlugins, input);
  let mcpCodePaths: string[] = [];
  let committedFingerprint: string | undefined;
  let committedMcpContentRevision: string | undefined;
  let lastRevision: string | undefined;
  return {
    initialPaths: paths,
    async load(adoptedRevision?: string): Promise<LoadedCapabilityEnvironment | undefined> {
      const fingerprint = await fingerprintCapabilityInputs(paths, {
        skipContentsForPaths: mcpCodePaths,
      });
      const currentMcpContentRevision = await fingerprintExplicitCapabilityFiles(mcpCodePaths);
      if (
        fingerprint === committedFingerprint &&
        currentMcpContentRevision === committedMcpContentRevision &&
        adoptedRevision === lastRevision
      )
        return undefined;
      const config = resolveEffectiveConfigResult(
        createConfig({
          env: options.env,
          projectConfigPath: options.projectConfigPath,
          workingDirectory,
          workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
          skipUserConfig: options.skipUserConfig,
          userConfigPath: options.userConfigPath,
          cliOverrides: createConfigCliOverrides(options),
        }),
        options,
      );
      if (
        [...config.sources.user.diagnostics, ...config.sources.project.diagnostics].some(
          (diagnostic) => diagnostic.severity === "error",
        )
      ) {
        throw new Error("Capability configuration is invalid; correct the configuration to reload");
      }
      const plugins = resolveZCodePlugins({
        configResult: config,
        workingDirectory,
        env: options.env,
        logger: input.logger,
        officialPluginRoots: options.officialPluginRoots,
        pluginStorageRoot: options.pluginStorageRoot,
      });
      if (plugins.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        throw new Error("Plugin configuration is invalid; the previous capabilities remain active");
      }
      const profiles = await loadZCodeAgentProfiles({
        logger: input.logger,
        storageRoot: input.storageRoot,
        workingDirectory,
      });
      const pluginProfiles = loadPluginAgentProfiles({
        logger: input.logger,
        plugins: plugins.plugins,
        reservedProfileNames: profiles.profiles.map((profile) => profile.name),
        modelSelectionOverrides: profiles.pluginAgentModelSelectionOverrides,
      });
      const features = resolvePluginRuntimeFeatures(plugins);
      const directoryMcp =
        options.mcpServersSource === "directory"
          ? await loadDirectoryMcpServers({ homeDirectory, workspacePath: workingDirectory })
          : undefined;
      // 显式 session map 是完整覆盖；只有有来源标记的目录投影才随文件重读。
      const mcpServers = directoryMcp
        ? applyDirectoryMcpAugmentations(
            directoryMcp.servers,
            options.mcpServersBase,
            options.runtimeConfig?.mcp?.servers,
          )
        : (options.runtimeConfig?.mcp?.servers ?? config.config.mcp.servers);
      const { runtimeConfig } = resolveAppRuntimeConfig({
        cliStorageRoot: input.cliStorageRoot,
        configResult: config,
        options: {
          ...options,
          runtimeConfig: {
            ...options.runtimeConfig,
            mcp: {
              ...options.runtimeConfig?.mcp,
              servers: mcpServers,
            },
          },
        },
        pluginHooks: plugins.hooks,
        pluginMcpServers: plugins.mcpServers,
        builtInMcpServers: resolveBuiltInNodeReplMcpServers({
          pluginOutcome: plugins,
          workingDirectory,
        }),
        pluginRuntimeFeatures: features,
        builtInSubagentModelSelectionOverrides: profiles.builtInModelSelectionOverrides,
        subagentOutputRootDir: join(input.cliStorageRoot, "agents"),
        subagentProfiles: [...profiles.profiles, ...pluginProfiles.profiles],
        storageRoot: input.storageRoot,
        workingDirectory,
        workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      });
      if (runtimeConfig.mcp?.servers && input.transformMcpServers) {
        runtimeConfig.mcp.servers = input.transformMcpServers(runtimeConfig.mcp.servers, features);
      }
      const skillOptions = {
        homeDirectory,
        extraRoots: config.config.skills.roots,
        // reload 必须保留随 CLI 分发的技能，不能把它们误当作已卸载插件的资源。
        extraResolvedRoots: [...plugins.skillRoots, ...(input.bundledSkillRoots ?? [])],
        disabledPaths: [
          ...collectDisabledPaths(config.config.skillOverrides),
          ...(input.initialRuntimeConfig.dynamicWorkflowEnabled === false
            ? collectDynamicWorkflowDisabledSkillPaths(input.bundledSkillRoots ?? [])
            : []),
        ],
      };
      const skillRoots = await resolveDefaultSkillRoots(workingDirectory, skillOptions);
      const nextMcpCodePaths = resolveMcpCodePaths(
        runtimeConfig.mcp?.servers ?? {},
        workingDirectory,
      );
      const discoveryPaths = [
        ...capabilityInputPaths(config, plugins, input),
        ...(directoryMcp?.watchPaths ?? []),
        ...skillRoots.map((root) => root.path),
        ...nextMcpCodePaths,
      ];
      const preparationFingerprint = await fingerprintCapabilityInputs(discoveryPaths, {
        skipContentsForPaths: nextMcpCodePaths,
      });
      const skillAdapter = options.skillPort ?? createNodeSkillAdapter(skillOptions);
      const skillsEnabled = config.config.features.skill && config.config.skills.enabled;
      const skills = skillsEnabled
        ? await skillAdapter.discoverSkills({ workingDirectory })
        : { skills: [], diagnostics: [], totalDiscovered: 0 };
      if (
        skills.diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" ||
            [
              "skill_invalid_frontmatter",
              "skill_missing_name",
              "skill_read_failed",
              "skill_scan_failed",
            ].includes(diagnostic.code),
        )
      ) {
        throw new Error("Skill configuration is invalid; the previous capabilities remain active");
      }
      const liveTools = await loadLiveTools({
        workspacePath: workingDirectory,
        userRoots: [
          join(homeDirectory, ".zcode", "tools"),
          join(homeDirectory, ".agents", "tools"),
        ],
        pluginRoots: plugins.plugins
          .filter((plugin) => plugin.enabled)
          .map((plugin) => ({ id: plugin.id, path: plugin.rootPath })),
      });
      const nextPaths = [
        ...discoveryPaths,
        ...liveTools.watchPaths,
        ...skills.skills.map((skill) => skill.path),
      ];
      input.onWatchPaths?.(nextPaths);
      // 空目录不等于关闭功能；关闭时必须撤掉端口，否则 core 仍会注册 Skill。
      const frozenSkillPort = skillsEnabled
        ? (options.skillPort ?? (await captureSkillPort(skills)))
        : undefined;
      const mcpContentRevision = samePaths(mcpCodePaths, nextMcpCodePaths)
        ? currentMcpContentRevision
        : await fingerprintExplicitCapabilityFiles(nextMcpCodePaths);
      const finalFingerprint = await fingerprintCapabilityInputs(nextPaths, {
        skipContentsForPaths: nextMcpCodePaths,
      });
      // 重读已知输入，拒绝扫描过程中被改写的混合版本；下一边界自然重试。
      if (
        (await fingerprintCapabilityInputs(paths, { skipContentsForPaths: mcpCodePaths })) !==
          fingerprint ||
        (await fingerprintCapabilityInputs(discoveryPaths, {
          skipContentsForPaths: nextMcpCodePaths,
        })) !== preparationFingerprint ||
        (await fingerprintExplicitCapabilityFiles(nextMcpCodePaths)) !== mcpContentRevision
      ) {
        throw new Error(
          "Capability sources changed during preparation; retrying at the next boundary",
        );
      }
      const revision = createHash("sha256")
        .update(finalFingerprint)
        .update(mcpContentRevision)
        .update(liveTools.revision)
        .update(
          JSON.stringify({ skills, mcp: runtimeConfig.mcp, profiles: runtimeConfig.subagents }),
        )
        .digest("hex");
      paths = nextPaths;
      mcpCodePaths = nextMcpCodePaths;
      if (revision === adoptedRevision) {
        committedFingerprint = finalFingerprint;
        committedMcpContentRevision = mcpContentRevision;
        lastRevision = revision;
        return undefined;
      }
      const prepared = await prepareLiveToolEntries(liveTools.tools, {
        nodeRuntime: resolveLiveToolNodeRuntime(),
      });
      committedFingerprint = finalFingerprint;
      committedMcpContentRevision = mcpContentRevision;
      lastRevision = revision;
      return {
        revision,
        tools: prepared.tools,
        disposeTools: prepared.dispose,
        skills,
        instructions: LIVE_CAPABILITY_INSTRUCTIONS,
        skillPort: frozenSkillPort,
        pluginReferenceCatalog: buildPluginReferenceCatalog(plugins.plugins),
        mcp: runtimeConfig.mcp ?? { enabled: false },
        mcpContentRevision,
        async verifyMcpContentRevision() {
          if ((await fingerprintExplicitCapabilityFiles(nextMcpCodePaths)) !== mcpContentRevision) {
            throw new Error("MCP source changed during capability preparation");
          }
        },
        network: {
          httpProxy: config.config.network.httpProxy,
          noProxy: config.config.network.noProxy,
          caCertFile: config.config.network.caCertFile,
        },
        officialCuaServerNames: computeOfficialCuaServerNames(
          runtimeConfig.mcp?.servers ?? {},
          new Set(runtimeConfig.mcp?.trustedOfficialCuaServerNames ?? []),
        ),
        runtimeConfig: {
          hooks: runtimeConfig.hooks,
          subagents: runtimeConfig.subagents,
          skillMetadataBudget: runtimeConfig.skillMetadataBudget,
          runtimeFeatures: features,
        },
        watchPaths: paths,
      };
    },
  };
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

const LIVE_CAPABILITY_INSTRUCTIONS = `You can create reusable local tools during this session.
Write a manifest in .zcode/tools/<id>.json (or .agents/tools) and a self-contained JavaScript script beside it.
Manifest shape: {"version":1,"id":"example","tools":[{"name":"example_tool","description":"Describe its purpose","inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object"},"command":{"script":"./example.mjs"}}]}.
Use .mjs, .cjs or .js; relative imports are unsupported. Read one JSON value from stdin and write exactly one JSON value to stdout; diagnostics go to stderr. Commands have a 30-second deadline and 64 KiB output limits and require normal tool permission approval.
File changes are validated between model steps: valid additions/edits/deletions become available on your next request in this turn, while invalid changes preserve the last valid revision. Skills, enabled plugin contributions and MCP configuration also reload. Do not overwrite built-in tool names.`;

function capabilityInputPaths(
  config: ConfigResult,
  plugins: PluginLoadOutcome,
  input: LiveCapabilityLoaderOptions,
): string[] {
  const home = input.options.env?.HOME || input.options.env?.USERPROFILE || homedir();
  return [
    config.sources.user.path,
    ...config.sources.project.paths,
    join(input.workingDirectory, ".zcode", "config.json"),
    join(input.workingDirectory, ".agents", "mcp.json"),
    join(input.workingDirectory, ".agents", "settings.json"),
    join(home, ".agents", "mcp.json"),
    ...[input.workingDirectory, home].flatMap((root) =>
      [".zcode", ".agents"].flatMap((scope) =>
        ["skills", "tools", "commands", "agents"].map((kind) => join(root, scope, kind)),
      ),
    ),
    join(
      input.options.pluginStorageRoot ?? getPluginStorageRoot(input.cliStorageRoot),
      "installed_plugins.json",
    ),
    ...plugins.plugins.map((plugin) => plugin.rootPath),
    ...config.config.plugins.dirs,
    ...plugins.skillRoots.map((root) => root.path),
    ...(input.bundledSkillRoots ?? []).map((root) => root.path),
  ];
}
