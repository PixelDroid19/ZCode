import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LiveToolConfigurationError } from "./errors.js";
import type { LiveToolPluginRoot, LoadLiveToolsInput } from "./types.js";

export interface LiveToolSourceRoot {
  owner: string;
  path: string;
  restrictToWorkspace: boolean;
}

/**
 * Produces deterministic source boundaries without loading plugin code. A plugin root is
 * the package root supplied by the enabled-plugin resolver; manifests live in its tools/ child.
 */
export function createLiveToolSourceRoots(
  input: LoadLiveToolsInput,
  workspacePath: string,
): LiveToolSourceRoot[] {
  const roots: LiveToolSourceRoot[] = [
    {
      owner: "workspace:.agents",
      path: join(workspacePath, ".agents", "tools"),
      restrictToWorkspace: true,
    },
    {
      owner: "workspace:.zcode",
      path: join(workspacePath, ".zcode", "tools"),
      restrictToWorkspace: true,
    },
  ];
  const userRoots = input.userRoots ?? [];
  if (!Array.isArray(userRoots)) {
    throw new LiveToolConfigurationError("invalid_root", "userRoots must be an array", {
      path: workspacePath,
    });
  }
  for (const path of userRoots) {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new LiveToolConfigurationError(
        "invalid_root",
        "userRoots entries must be non-empty paths",
        {
          path: workspacePath,
        },
      );
    }
    const resolvedPath = resolve(workspacePath, path);
    roots.push({ owner: `user:${resolvedPath}`, path: resolvedPath, restrictToWorkspace: false });
  }

  const pluginRoots = input.pluginRoots ?? [];
  if (!Array.isArray(pluginRoots)) {
    throw new LiveToolConfigurationError("invalid_root", "pluginRoots must be an array", {
      path: workspacePath,
    });
  }
  const pluginIds = new Set<string>();
  for (const plugin of pluginRoots) {
    validatePluginRoot(plugin, workspacePath);
    const id = plugin.id.trim();
    if (pluginIds.has(id)) {
      throw new LiveToolConfigurationError(
        "duplicate_plugin_root",
        `Plugin root ${id} is declared twice`,
        {
          path: workspacePath,
        },
      );
    }
    pluginIds.add(id);
    const packageRoot = resolve(workspacePath, plugin.path);
    roots.push({
      owner: `plugin:${id}`,
      path: join(packageRoot, "tools"),
      restrictToWorkspace: false,
    });
  }

  const owners = new Set<string>();
  for (const root of roots) {
    if (owners.has(root.owner)) {
      throw new LiveToolConfigurationError(
        "invalid_root",
        `Live tool source owner ${root.owner} is repeated`,
        {
          path: root.path,
        },
      );
    }
    owners.add(root.owner);
  }
  return roots.sort((left, right) => compareText(left.owner, right.owner));
}

export async function resolveLiveToolWorkspacePath(path: string, label: string): Promise<string> {
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch (cause) {
    throw new LiveToolConfigurationError("invalid_root", `${label} must be an existing directory`, {
      cause,
      path,
    });
  }
  try {
    const stat = await lstat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new LiveToolConfigurationError(
        "invalid_root",
        `${label} must be an existing directory`,
        {
          path,
        },
      );
    }
  } catch (cause) {
    if (cause instanceof LiveToolConfigurationError) throw cause;
    throw new LiveToolConfigurationError("invalid_root", `${label} must be an existing directory`, {
      cause,
      path,
    });
  }
  return resolvedPath;
}

function validatePluginRoot(
  value: unknown,
  workspacePath: string,
): asserts value is LiveToolPluginRoot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LiveToolConfigurationError("invalid_root", "pluginRoots entries must be objects", {
      path: workspacePath,
    });
  }
  const plugin = value as Record<string, unknown>;
  if (Object.keys(plugin).some((key) => key !== "id" && key !== "path")) {
    throw new LiveToolConfigurationError(
      "invalid_root",
      "pluginRoots entries only accept id and path",
      {
        path: workspacePath,
      },
    );
  }
  if (
    typeof plugin.id !== "string" ||
    plugin.id.trim().length === 0 ||
    typeof plugin.path !== "string" ||
    plugin.path.trim().length === 0
  ) {
    throw new LiveToolConfigurationError(
      "invalid_root",
      "pluginRoots entries require non-empty id and path",
      {
        path: workspacePath,
      },
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
