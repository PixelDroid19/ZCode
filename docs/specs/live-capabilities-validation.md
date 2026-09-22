# Live capability validation

Validated on Linux with Node 24.14.0 and pnpm 10.33.2 on
`feature/live-capability-runtime`. The CLI, native TUI, and Electron Desktop
exercise the same live-capability runtime. Model responses in the acceptance
fixtures are deterministic and served locally; tool execution, filesystem
watching, process boundaries, protocol traffic, and permission decisions are real.

## Automated evidence

The final suite passes **79 tests, with zero failures, cancellations, or skips**.
The native SEA test runs with `ZCODE_SEA_BINARY` pointing to the freshly built
Linux executable. Coverage includes:

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

Reproduce after building, from the repository root:

```sh
ZCODE_SEA_BINARY="$PWD/apps/zcode-cli/packages/cli/dist/zcode-linux-x64" \
node --import tsx --test \
  apps/zcode-cli/packages/adapters/test/*.test.ts \
  apps/zcode-cli/packages/core/test/*.test.ts \
  apps/zcode-cli/packages/bootstrap/test/*.test.ts \
  apps/zcode-cli/packages/cli/test/*.test.ts \
  apps/zcode-cli/packages/cli/test/*.test.mjs \
  apps/zcode-cli/packages/tui/test/*.test.ts \
  apps/zcode-cli/packages/telemetry/test/*.test.ts \
  packages/services/test/liveCapabilitiesNotification.test.ts \
  packages/services/test/mcpProvenance.test.ts \
  packages/ui/test/capabilityStatusRefresh.test.ts \
  packages/ui/test/mentionPanelRows.test.ts
```

## Build and static checks

| Check                                                              | Result                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------ |
| Root `pnpm run typecheck`                                          | Pass                                                   |
| CLI `pnpm --dir apps/zcode-cli run typecheck --force`              | Pass; 27 tasks, no cached results                      |
| Root `pnpm run lint`                                               | 0 errors; 70 warnings                                  |
| CLI `pnpm --dir apps/zcode-cli run lint --force --continue=always` | 14 packages, 1,704 source files, 0 errors; 38 warnings |
| Strict TypeScript check of the eight new TypeScript test files     | Pass, using ES2023 libraries supported by Node 24      |
| `pnpm run architecture:check --changed`                            | 0 violations, baseline 0                               |
| Changed-file formatting and `git diff --check`                     | Pass                                                   |
| CLI dependency build                                               | 15 tasks pass, forced                                  |
| CLI bundle and standard Linux SEA build                            | Pass                                                   |
| Desktop agent bundle and staging                                   | Pass; staged and source bundle SHA-256 match           |

The CLI sources that exceeded the existing 400-line lint rule were split into
cohesive modules across adapters, core, bootstrap, contracts, telemetry, CLI, and
debug UI. No lint rule, ignore, baseline, dependency manifest, or lockfile was
relaxed. See the module-boundary specifications in this directory. Warnings
remain visible; lint success does not mean zero warnings.

Compatibility checks against the feature baseline confirmed all exports of 88
modified entry points, all 22 migration identifiers and SQL bytes, and all 143
projection method bodies with their 39 owner fields and constructor. A separate
baseline comparison covered 28 live, atomic, hydration, and telemetry event
transitions. The gateway retains one state owner and constructor; an independent
review also exercised concurrent resolution, rejection, and disposal of waiters.
No high or medium severity finding remains open in that review's scope.

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

## Interactive acceptance

Electron 41.0.3 ran the real Desktop UI, Host, and rebuilt agent on Linux with a
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

## Limits

- Native Windows and macOS packaged execution, signed installers, and a full mobile
  remote-attachment journey were not run. Service tests cover replayable delivery
  contracts but do not establish that complete mobile journey.
- No external model provider or paid request was used. The local provider fixture
  proves integration behavior, not model quality or comparative performance.
- Manifest v1 supports self-contained JavaScript scripts. Relative module imports
  are not supported by immutable script snapshots; see the
  [executable example](live-tools.md#executable-example-word_count).
- Test profiles, provider settings, and workspaces used temporary directories.
  Desktop startup can still read existing home-level resources; the run is not
  claimed to be a complete operating-system sandbox.
