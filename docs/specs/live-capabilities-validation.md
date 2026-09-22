# Live capability validation

Validated on Linux with Node 24.14.0 and pnpm 10.33.2 on
`feature/live-capability-runtime`. The CLI, native TUI, and Electron Desktop
exercise the same live-capability runtime. Model responses in the acceptance
fixtures are deterministic and served locally; tool execution, filesystem
watching, process boundaries, protocol traffic, and permission decisions are real.

## Automated evidence

The final gate passes **102 tests across 37 files and eight package groups, with
zero failures, cancellations, or skips**.
The native SEA test runs with `ZCODE_SEA_BINARY` pointing to the freshly built
Linux executable. Coverage includes:

- A real workspace, capability loader, session runtime and tool subprocess recover
  from an invalid manifest after restoring the original bytes, without relying on
  a watcher notification or inventing a new revision.
- Failed MCP processes recover through the manual refresh operation. An active
  retry holds the adopted runtime lease while a replacement generation commits.
- Sixteen real stdio MCP servers share a maximum of eight simultaneous handshakes.
  The same journey covers early caller return, queued cancellation, health checks,
  release during a pending health check, and shutdown with queued work.
- Directory MCP configuration limits reject the entire oversized candidate while
  a real server from the last accepted generation remains callable. Coverage
  includes the merged record count, disabled entries, UTF-8 byte limits and fields.
- Explicit executable changes include extensionless files, `.exe` paths, relative
  working directories, removal, POSIX execute permissions and symlink retargeting.
- Real React/Lexical browser journeys preserve picker catalogs through reopening,
  failed and out-of-order refreshes, session/attachment changes and reconnects.
  Keyboard and mouse selection preserve capability identity after catalog changes;
  removing or disabling the selection chooses an available entry.
- The native executable and source host report syntax, runtime and missing-module
  errors with useful locations, bounded cause details and credential redaction,
  then execute a repaired script. JSON stdout remains usable by the caller.
- A model writes a manifest and script through `Write`, then discovers and invokes
  the new tool within the same turn. Idle edits, deletion, malformed-edit retention,
  and watcher notifications operate on the existing session.
- Skill gates, installed-plugin enable/disable settings, allowlists, permission
  denials, child inheritance, and workspace isolation.
- Atomic registry replacement, serialized refresh, idle-to-active races, rollback,
  throwing observers, context rebuilding, and resource draining.
- Real pooled stdio MCP processes, callable old generations, failed replacement
  retention, handshake source changes, and workspace identity preservation.
- Directory MCP precedence, disabled-entry tombstones, complete session overrides,
  provenance validation, and Desktop/replayable service propagation. Credentials
  are not transferred to changed process targets.
- A real CLI `app-server` process communicating through NDJSON and a loopback model
  server. It creates, invokes, updates, rejects an invalid edit, and removes a tool
  in one session. See [protocol acceptance](live-protocol-acceptance.md).
- Projection snapshots checked against fixtures captured before modularization,
  telemetry parentage and shared writer limits, filesystem behavior, marketplace
  dependency installation and failed-refresh retention, and gateway construction.
- Early streaming return releases admission exactly once in both provider-boundary
  modes. Partial third-party `readOnly` metadata retains the existing approval
  requirement and workspace side-effect classification.
- SEA runtime dependency discovery and an actual native executable running an
  asynchronous live-tool script beyond the normal CLI exit watchdog, preserving
  JSON stdin/stdout and literal arguments.

Run the complete gate from the repository root with the pinned Node on `PATH`:

```sh
pnpm run verify:pre-push
```

The gate performs static checks, checks the full architecture, rebuilds the CLI
and native executable, and discovers existing tests plus integration acceptance
in the affected CLI, services and UI packages. It fails on skipped tests. Tests
run in package groups with each package's explicit TypeScript configuration,
while preserving the repository working directory used by fixtures. This lets
`tsx` resolve aliases such as the UI's `@/lib` without applying another package's
configuration. See [verification contract](live-capabilities-verification-gate.md).

New acceptance coverage uses integrated runtime, process, protocol and browser
journeys. The total also includes pre-existing focused tests; it is not a count
of distinct end-to-end scenarios.

## Build and static checks

| Check                                                              | Result                                            |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Root `pnpm run typecheck`                                          | Pass                                              |
| CLI `pnpm --dir apps/zcode-cli run typecheck --force`              | Pass; 27 tasks, no cached results                 |
| Root `pnpm run lint`                                               | 0 errors; 70 warnings                             |
| CLI `pnpm --dir apps/zcode-cli run lint --force --continue=always` | 14 packages, 0 errors; 38 warnings                |
| Strict TypeScript check of seven affected integration test files   | Pass, using ES2023 libraries supported by Node 24 |
| `pnpm run architecture:check`                                      | 0 violations, baseline 0                          |
| Changed-file formatting and `git diff --check`                     | Pass                                              |
| CLI dependency build                                               | 15 tasks pass, forced                             |
| CLI bundle and standard Linux SEA build                            | Pass                                              |
| Desktop agent bundle and staging                                   | Pass; staged and source bundle SHA-256 match      |

The CLI sources that exceeded the existing 400-line lint rule were split into
cohesive modules across adapters, core, bootstrap, contracts, telemetry, CLI, and
debug UI. No lint rule, ignore, baseline, dependency manifest, or lockfile was
relaxed. See the module-boundary specifications in this directory. Warnings
remain visible; lint success does not mean zero warnings.

The earlier baseline validation at `15548a9` confirmed all exports of 88
modified entry points, all 22 migration identifiers and SQL bytes, and all 143
projection method bodies with their 39 owner fields and constructor. A separate
baseline comparison covered 28 live, atomic, hydration, and telemetry event
transitions. The gateway retains one state owner and constructor; an independent
review also exercised concurrent resolution, rejection, and disposal of waiters.
The current hardening changes received independent review as well; material
findings about retry lease lifetime, retired connection revalidation, diagnostic
redaction, executable permissions and picker selection were resolved and checked.

The source-comment audit traced documented bug notes and TODO markers through
their current callers. It found no additional confirmed functional defect in
that scope; unsupported or unused paths were not turned into speculative fixes.
The repository has GitHub issues disabled, and this branch had no pull request
with external review comments to process.

During validation, pnpm displaced package-local dependencies into `.ignored`,
causing contracts to resolve root Zod 4 instead of their declared Zod 3 dependency.
The original local dependency directories were restored without overwriting other
packages or changing manifests. The final package builds and checks above were
rerun afterward. Use the pinned package manager and explicit `pnpm run` commands;
an isolated lint invocation that discovers no files is not validation evidence.

## Packaging correction

The standard SEA failure came from an incomplete build dependency closure:
`@zcode/model-option-map` exists in the repository, but the nested CLI build did
not prepare every root workspace package consumed by the TUI. SEA preparation
now derives those packages from current manifests and builds them in dependency
order before asset staging. Source manifests stay unchanged. See
[packaging rules](cli-sea-desktop-agent-packaging.md).

The native Linux build and Desktop agent can be reproduced with Node 24 on PATH:

```sh
pnpm exec turbo --skip-infer --cwd apps/zcode-cli run build --filter='!@zcode/cli' --force
pnpm --dir apps/zcode-cli/packages/cli run build
node apps/zcode-cli/packages/cli/scripts/build-sea.mjs --target linux-x64
node scripts/build-desktop-agent-cli.mjs
```

The final command stages the Desktop bundle into
`packages/desktop/bundled-agents/linux-x64/glm/zcode.cjs`. It also replaces the
working CLI JavaScript bundle with the Desktop variant; the previously generated
native SEA executable remains available for CLI/TUI use.

The current Desktop agent was rebuilt and staged after the full gate. Its source
and staged bundles have the same SHA-256:
`ec053f972fe1ea0887c59c29c24d2d5e59dde4a7556c9b5ec68057ca0e185c40`.
The existing protocol integration then passed **1/1** while launching that
staged file directly. It created a tool, invoked it, adopted an edit, retained
the working revision after a malformed edit, and removed the tool in one session.

Reproduce that artifact check after staging:

```sh
ZCODE_PROTOCOL_BUNDLE="$PWD/packages/desktop/bundled-agents/linux-x64/glm/zcode.cjs" \
TSX_TSCONFIG_PATH="$PWD/apps/zcode-cli/packages/cli/tsconfig.json" \
node --import tsx --test apps/zcode-cli/packages/cli/test/live-protocol-acceptance.test.ts
```

## Earlier interactive acceptance

The baseline pass recorded at `15548a9` ran Electron 41.0.3 with the real Desktop
UI, Host, and rebuilt agent on Linux with a
local OpenAI-compatible SSE fixture. The development Host loaded the same bundle
bytes as the staged Desktop artifact. In one conversation:

1. `live_readiness_count` ran as a subprocess and returned `{count: 3, revision: "v1"}`.
2. Editing its script changed the next result to revision `v2` without restarting.
3. An invalid manifest displayed **Capability refresh failed** while the last good
   `v2` tool remained callable.
4. Deleting the manifest removed the tool from the model's next request.
5. After rebuilding and restarting Desktop, the persisted conversation reopened
   and executed the restored tool with revision `final`.

Each Desktop execution used the normal **Allow only this time** permission flow.
The final result was inspected in the rendered UI. The native SEA TUI was also
operated through an interactive terminal: one process exercised update, invalid
edit retention, and deletion; a fresh process using the final executable returned
`{count: 3, revision: "final"}`. TUI tests used full-access mode only for the
temporary fixture workspace.

The shared `MentionPanel` was separately inspected at 360 px and 720 px widths,
including loading, empty, ready, and failed-reload states. Selection of a retained
item after a failed reload worked. Its multiline status rows use measured heights
to avoid overlap on narrow screens.

The current hardening pass additionally runs the shared picker in a real browser
with the production React/Lexical components and styled desktop/mobile layouts.
Its service RPC is controlled at the boundary. This does not establish a fresh
full Electron or mobile remote-attachment journey for the later commits.

## Limits

- Native Windows and macOS packaged execution, signed installers, and a full mobile
  remote-attachment journey were not run. Service tests cover replayable delivery
  contracts but do not establish that complete mobile journey.
- No external model provider or paid request was used. The local provider fixture
  proves integration behavior, not model quality or comparative performance.
- The admission branch that releases a permit during interactive browser OAuth
  and reacquires it afterward was reviewed but not exercised with a real OAuth
  provider. Local MCP transport and lifetime journeys were executed.
- Diagnostic redaction handles the supported credential/input patterns; it is
  not a guarantee for every unlabeled secret embedded in arbitrary error text.
- Manifest v1 supports self-contained JavaScript scripts. Relative module imports
  are not supported by immutable script snapshots; see the
  [executable example](live-tools.md#executable-example-word_count).
- Test profiles, provider settings, and workspaces used temporary directories.
  Desktop startup can still read existing home-level resources; the run is not
  claimed to be a complete operating-system sandbox.
