# Core module boundaries

## Purpose

`@zcode/core` owns the in-process agent runtime, its session state, tool
admission, permission decisions, model-step orchestration, and projections for
callers. This refactor restores the 400-line source-file boundary without
changing runtime behavior, public exports, permissions, or live-capability
reload semantics.

## Ownership and boundaries

| Area                              | Owner                                          | Extracted helpers may own                                                                      | Must remain with the owner                                                                  |
| --------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Runtime methods                   | `AgentRuntime` and installed prototype methods | Pure conversion, selection, serialization, and request-building helpers                        | Mutable runtime fields, turn admission, event emission, leases, and lifecycle transitions   |
| Tool handlers and executor        | Existing tool entry and executor owners        | Argument parsing, result formatting, filesystem-independent planning, and command construction | Permission checks, execution-port calls, cancellation, trace propagation, and tool metadata |
| Session history and forks         | Runtime/history owners                         | Immutable message mapping, validation, and projection helpers                                  | History mutation, persistence calls, revision selection, and parent/child session ownership |
| Permissions, MCP, hooks, workflow | Their existing service/registry owners         | Policy predicates, normalization, and display/value codecs                                     | Approval decisions, registrations, subscriptions, event ordering, and cleanup               |

New helpers remain internal to `packages/core/src`; they do not add a public
package export or create a cross-package import. A helper receives explicit
inputs and returns data or a narrowly scoped operation. It must not reach into
`AgentRuntime` internals except through an explicit receiver or the existing
internal runtime contract passed by its owner.

## Invariants

1. `AgentRuntime` remains the sole owner of mutable session, active-turn,
   capability-snapshot, queue, and projection state.
2. Tool calls continue through the existing executor and permission path before
   external execution. Extracting handlers must not bypass approval, budgets,
   cancellation, trace context, or output limits.
3. Live capability updates keep the existing prepare, adopt, release sequence.
   Invalid candidates retain the previously adopted snapshot and idle watcher
   notifications do not mutate an executing turn.
4. Public imports from `@zcode/core`, method installation, and runtime type
   contracts remain compatible. Internal helpers are imported with relative
   paths only.
5. Refactoring preserves asynchronous order: admission → owner transition →
   side effect through a port → owner event/projection. No extracted helper may
   add independent timers, queues, caches, or subscriptions.

```text
input -> AgentRuntime / service owner -> existing port or executor -> owner event/projection
                    |                         |
                    +-- internal pure helper --+
```

## Failure behavior

Extracted helpers propagate existing errors unchanged unless the original
owner already adds context. They must preserve structured permission denials,
turn cancellation, stale-generation rejection, and failed live-reload
retention. No catch-and-ignore behavior is introduced merely to make the
refactor compile.

## Acceptance

- Every affected `core/src` file is at most 400 lines under the existing lint
  rule; the rule, ignores, and baseline remain unchanged.
- `@zcode/core` typecheck, lint, and build pass with the pinned Node runtime.
- The focused 22-test live-capability suite and the seven-test real
  `createZCodeApp` acceptance suite still pass.
- No runtime behavior, external API, configuration format, permission policy,
  or stored-session migration is added or changed by this refactor.
