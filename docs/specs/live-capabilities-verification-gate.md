# Live capabilities verification gate

## Purpose

Provide one reproducible pre-push gate for live capabilities and their real CLI
runtime path. The gate covers repository and CLI static checks, architecture
policy, integration tests, and the native Single Executable Application (SEA)
smoke against a binary built from the current checkout.

## Command contract

`pnpm run verify:pre-push` runs these phases serially under the exact Node
version pinned by `mise.toml` and stops at the first failure. The verification
script reads that pin, rejects other Node versions before starting any phase,
and tells the caller how to enter the pinned runtime.

1. Root `typecheck` and `lint`.
2. CLI `typecheck` and `lint`, invoked with explicit
   `pnpm --dir apps/zcode-cli run ...` commands so pnpm cannot interpret the
   package directory as a missing project and auto-install dependencies.
3. Full architecture check. A clean working tree must still validate committed
   changes; `--changed` only discovers files differing from `HEAD`.
4. Build the CLI's workspace dependencies, then its bundle, then only the SEA
   target for the current host. The host target and output filename come from
   the existing `sea-targets.mjs` helpers. The same pinned Node executable
   builds the SEA and runs the integration suite.
5. Discover and execute all `.test.ts` and `.test.mjs` files under the current
   CLI adapter, bootstrap, CLI, core, telemetry, and TUI test directories, plus
   `packages/services/test` and `packages/ui/test`. This includes newly added
   tests in those directories without maintaining a second file inventory.
   Each test directory runs as a package group with the repository's installed
   `tsx` loader and that package's `tsconfig.json` supplied through
   `TSX_TSCONFIG_PATH`. Every group keeps the repository root as its working
   directory so tests retain their workspace-relative path behavior.

The SEA test suite receives `ZCODE_SEA_BINARY` set to the freshly built host
binary. The live protocol integration also receives `ZCODE_PROTOCOL_BUNDLE`
set to the freshly built CLI CJS bundle, so its real protocol fixture exercises
the packaged runtime. The verification script removes the prior host artifact
before building and fails if the build does not produce an executable file, so
a stale artifact cannot make the full gate pass. The standalone integration
runner validates that its supplied `ZCODE_SEA_BINARY` exists and is runnable;
freshness of the SEA and CLI bundle is established by the outer gate's
build-before-test sequence. The gate must fail if the SEA acceptance test
reports a skip. It must not offer a mode that omits building or exercising the
native artifacts.

## State and failure behavior

The root verification script owns phase order and paths to the fresh SEA and
CLI bundle.
The integration runner owns test discovery and rejects an empty test set, a
missing package tsconfig, or an unset/nonexistent `ZCODE_SEA_BINARY`. It does
not build artifacts or select a different binary. Existing target and build
scripts remain the owners of SEA target rules and packaging behavior.

Callers pass an executable and argument array through the existing command
helper instead of composing shell commands. On Windows that helper uses its
existing shell/quoting path for the `pnpm` and `npm` command shims. Commands
inherit the current environment and working tree, with
the pinned Node directory first on `PATH`; integration groups override only
`TSX_TSCONFIG_PATH` to the owning package's checked-in config. Groups run
serially, and a failure in one group does not prevent the remaining groups from
running; the runner aggregates failures and skipped counts afterward. A spawn
error, nonzero exit, signal termination, missing output, or skipped SEA
acceptance test fails the gate and propagates a nonzero result. The gate does
not install dependencies, change lockfiles, use a fallback build, or suppress
failures.

## Acceptance scenarios

- A normal run performs every phase in order and reports the first failed
  phase without starting later phases.
- A current-host SEA build produces the helper-selected filename, and the
  integration suite exercises that exact binary through
  `ZCODE_SEA_BINARY`.
- A missing, stale, or non-runnable SEA artifact cannot result in a green full
  gate.
- A signal-terminated child process fails the gate.
- A newly added test in a supported test directory is included by discovery.
- Package path aliases resolve from the owning `tsconfig.json` while tests keep
  the repository root as their working directory.
- All package groups run after an earlier group fails, then the full gate
  reports a nonzero result with the aggregated failures.
- No suite, especially the SEA executable acceptance, can silently skip and
  still yield a successful gate.
