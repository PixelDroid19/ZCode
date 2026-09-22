# CLI SEA and Desktop Agent Packaging

## Scope

This specification covers the build-time packaging boundary for the Node CLI
single-executable application (SEA) and the JavaScript agent bundled into the
Desktop application. It does not change CLI runtime behavior, protocol
contracts, or historical workspace package membership.

## Ownership

- `apps/zcode-cli/packages/cli/scripts/sea-tui-assets.mjs` owns discovery of
  the SEA TUI runtime closure. It starts with `@zcode/tui`, follows the
  `dependencies` declared by the packages present in the current workspace,
  and owns the resulting embedded asset manifest.
- `apps/zcode-cli/packages/cli/scripts/build-sea.mjs` owns preparation of that
  closure for a SEA build. It must ensure every discovered workspace package
  has its compiled public `dist` surface before the asset collector stages it.
- `scripts/build-desktop-agent-cli.mjs` owns the ordered prebuild required by
  the Desktop agent bundle before `apps/zcode-cli/packages/cli/scripts/build.mjs
--desktop-agent` produces and stages `zcode.cjs`.

The SEA collector is the sole source of truth for which workspace packages are
embedded. Build lists may only name packages that are required by the current
dependency graph; they must not restore historical internal packages.

## Rules and invariants

1. A SEA build must package compiled `dist` files for every workspace package
   in the current TUI runtime dependency closure. Its staged copy of each
   workspace `package.json` must point runtime entry fields at `dist`, while
   source manifests remain unchanged.
2. The package closure is derived from current `package.json` dependencies and
   workspace directories. A removed package is neither built nor embedded.
3. A current workspace runtime package uses its declared `build` script. A
   current TypeScript workspace package that intentionally has no package
   `build` script uses its own `tsconfig.json` as the build contract. If neither
   path exists, or either path fails to produce its public compiled surface,
   packaging fails before SEA injection with the package name and an actionable
   build error. It must not silently fall back to `src` or omit the package.
4. Asset paths recorded in the SEA manifest use POSIX separators for all
   targets. File inclusion is evaluated using Node path APIs, so Windows,
   macOS, and Linux package trees are enumerated consistently.
5. The Desktop prebuild must include each current compile-time dependency that
   is absent from its nested CLI workspace. The staged agent remains
   `packages/desktop/bundled-agents/<platform>-<arch>/glm/zcode.cjs`, generated
   from the same CLI bundle used by the distribution path.

## Build sequence and failure semantics

```text
current manifests -> runtime closure discovery -> dependency-first workspace builds
                  -> compiled asset staging -> SEA blob -> target injection

Desktop dependency prebuild -> CLI desktop-agent bundle -> shared bundle staging
```

The dependency-first build step is idempotent for a single build invocation.
An asset collector never modifies source manifests. A missing compiled entry,
missing package directory, or failed package build aborts the command with its
original cause; no incomplete executable or Desktop staging marker is claimed
as valid.

## Acceptance scenarios

1. A clean source checkout where `@zcode/model-option-map` has no `dist`
   directory can complete the native Linux SEA build after the current closure
   builds it, and the generated executable responds to `--version` and
   `--help`. Its hidden `__zcode-live-tool-host` command must preserve JSON
   stdin/stdout across an asynchronous script that runs for more than one
   second.
2. The embedded runtime manifest contains `@zcode/model-option-map`'s compiled
   assets and a rewritten staged package entry, without modifying
   `packages/model-option-map/package.json`.
3. A Desktop agent build stages a newly generated `zcode.cjs` into the
   platform-specific `bundled-agents` location used by Desktop distribution.
4. The asset-enumeration regression test exercises POSIX manifest paths and
   platform target handling. Native execution is verified on Linux only;
   Windows and macOS remain source-level coverage until those targets are run.

## Migration boundary

This is a build-pipeline correction only. Existing source package manifests,
runtime imports, and release target definitions remain their current owners.
