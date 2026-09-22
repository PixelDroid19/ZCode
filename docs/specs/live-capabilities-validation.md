# Live capability validation

Validated with Node 24.14.0 and pnpm 10.33.2 on Linux. Changes are on
`feature/live-capability-runtime`.

## Automated evidence

The 17 focused test files pass **63 tests**. They exercise the real app/runtime
with deterministic model responses and actual tool subprocesses, without provider
credentials or paid requests. Coverage includes:

- A model writes a manifest and script with `Write`, then invokes its new tool in
  the same turn. Idle edits, deletion, malformed-edit rollback and watcher updates
  are also exercised.
- Both skill gates and an installed plugin's enable/disable setting update tools
  and catalogs in the existing session. Allowlist inclusion/exclusion and permission
  denial remain effective; separate workspaces do not share tools.
- Atomic registry replacement, serialized refresh, idle-to-active races, context
  rebuilding, rollback, throwing observers, child inheritance and resource drains.
- Actual pooled stdio MCP processes retain callable old generations, reject failed
  replacements, and reconnect with the adopted revision and workspace identity.
  A source edit during handshake rejects the candidate.
- Directory MCP precedence and disabled-entry tombstones; complete session overrides
  (including empty maps); strict provenance schemas; Desktop and replayable service
  propagation; host credentials are not transferred to changed process targets.
- Runtime catalog notifications and UI status rows preserving last-good options.

Reproduce from the repository root:

```sh
node --import tsx --test \
  apps/zcode-cli/packages/adapters/test/*.test.ts \
  apps/zcode-cli/packages/core/test/*.test.ts \
  apps/zcode-cli/packages/bootstrap/test/*.test.ts \
  apps/zcode-cli/packages/cli/test/*.test.ts \
  apps/zcode-cli/packages/tui/test/*.test.ts \
  packages/services/test/liveCapabilitiesNotification.test.ts \
  packages/services/test/mcpProvenance.test.ts \
  packages/ui/test/capabilityStatusRefresh.test.ts \
  packages/ui/test/mentionPanelRows.test.ts
```

## Build and static checks

| Check                                          | Result                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| Root `pnpm typecheck`                          | Pass                                                             |
| CLI `pnpm --dir apps/zcode-cli typecheck`      | Pass; 27 tasks                                                   |
| Root `pnpm lint`                               | 0 errors; 70 existing warnings                                   |
| CLI-wide lint                                  | Fails on existing `max-lines` violations; not claimed as passing |
| Explicit lint of 25 new source files           | 0 errors or warnings                                             |
| `pnpm architecture:check --changed`            | 0 violations                                                     |
| Changed-file formatting and `git diff --check` | Pass                                                             |
| CLI bundle build                               | Pass                                                             |

The CLI scripts needed the repository's `node_modules/.bin` on `PATH` to locate
the already-installed Turbo executable. The CLI lint run reported 29 `max-lines`
errors in existing files, including `debug/src/App.tsx`, `debug/server/analyzer.ts`
and `cli/src/prompt-command.ts`; these are outside this feature's new source files.

The compiled CLI bundle and an isolated Linux Node SEA containing that bundle both
passed the internal tool-host smoke: JSON stdin/stdout, literal arguments and an
asynchronous script running longer than the ordinary CLI exit watchdog. The standard
full SEA release build remains blocked by its existing reference to missing
`@zcode/model-option-map` distribution files. No removed dependency was restored.

## Visual validation and limits

Inspected the real shared `MentionPanel` in a temporary browser harness at 360 px
and 720 px widths. Ready, loading, empty and failed-reload states were checked, and
a retained item was selected successfully after an error. This found and fixed a
mobile overlap: virtual rows now measure multiline status content.

This is not a full Electron application or mobile remote-attachment E2E run. macOS
and Windows packaged execution and a real external model provider were not exercised.
Manifest v1 deliberately supports self-contained JavaScript scripts; relative module
imports are not supported by immutable script snapshots. See
[the executable example](live-tools.md#executable-example-word_count).
