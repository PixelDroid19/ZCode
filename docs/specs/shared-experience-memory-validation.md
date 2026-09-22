# Shared experience memory validation

Validated on 2026-09-22 with Node 24.14.0 and pnpm 10.33.2 on Linux x64.
Product rules, ownership, usage and research sources are in
[shared-experience-memory.md](./shared-experience-memory.md).

## Executed acceptance

`pnpm run verify:pre-push` completed successfully:

- Root and CLI type checking passed.
- Root and CLI lint passed with existing warnings and no errors.
- Full architecture check reported zero violations.
- All 15 CLI dependency build tasks passed; the CLI bundle built successfully.
- The current-host native SEA executable built and passed its smoke checks.
- The integration suite passed **124 tests across 8 package groups, with 0 skipped**.

Seven new integration scenarios exercise the real SQLite adapter, application
bootstrap, runtime, executor, durable session store and subagent implementation:

| Flow                   | Evidence                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent store       | Reopen, project isolation, portable user scope, revisions, concurrent revision conflicts, idempotent replay, supersede and forget                                    |
| Cross-session learning | Save an attempt; reopen; confirm it with a real user message; report recurrence; reopen and inspect the retained history                                             |
| Sharing boundaries     | Portable procedure reaches another project; project record cannot be read by ID from that project; another profile and disabled memory do not recall it              |
| Evidence validation    | Assistant text cannot impersonate the user; failing tests, zero-test suites and echo-only package scripts cannot verify a repair; an actual passing test command can |
| Agent collaboration    | A real child reads the parent's experience, writes its observation, and the parent retrieves that observation                                                        |
| Automatic learning     | After-turn extraction receives only Memory, saves an attempt, accepts a short genuine confirmation, and persists it across application sessions                      |
| Extraction backlog     | Twenty-one queued user turns are consumed in bounded batches without skipping their durable evidence                                                                 |

Tests live in `apps/zcode-cli/packages/adapters/test/experience-memory.integration.test.ts`
and `apps/zcode-cli/packages/bootstrap/test/experience-memory-*.integration.test.ts`.
The bootstrap fixture uses a deterministic model while exercising the actual
application stack; it does not mock the memory database or executor.

Independent review inspected scope checks, immutable revisions, conflict handling,
evidence provenance, runner summaries, extraction batching, shutdown, headless
draining and parent/child/workflow wiring. Material findings were resolved before
this acceptance run. The primary agent also inspected the final changes.

## Limits of this evidence

This validates storage and runtime behavior, not the quality of every memory a
provider model chooses to write. The model still interprets the relevance and
meaning of user feedback. A test outcome describes the observed command, not an
independent proof of the entire repair or test quality.

No longitudinal external-model benchmark, accuracy/token reduction claim, cloud
synchronization, embedding retrieval, or new graphical memory browser is included.
CLI, TUI and Desktop share the runtime integration; this run does not claim manual
GUI inspection or native validation on Windows/macOS. Extraction failures retain
their cursor for a later turn; uncommitted background work is cancelled at shutdown.
