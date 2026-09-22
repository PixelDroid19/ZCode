# Bootstrap module boundaries

## Scope

This change decomposes the Bootstrap production files that exceed the
repository's 400-line source-file limit. It is a structural refactor only: the
current protocol, app, plugin, session, and projection behavior remains the
same.

## Ownership and compatibility

Each existing public module remains the owner of its current exported API and
stateful class or factory. New sibling helper modules own one cohesive group of
private calculations, mappers, handlers, or persistence operations. The public
module re-exports the same compatibility surface and delegates to those
helpers; consumers do not import helper implementation paths.

The refactor must not add a second state owner, queue, cache, or event stream.
For protocol and session flows, the existing host, broker, gateway, or
projection remains the owner. Helpers receive explicit inputs and return a
value, command result, or event projection; they do not create hidden mutable
state or change ordering, idempotency, lease, replay, or stale-result rules.

## Decomposition map

| Existing module                                       | Helper boundary                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `zcode-protocol/interaction-broker.ts`                | request parsing, pending-interaction lifecycle, and response mapping                                            |
| `app/types.ts`                                        | app dependency/type groups                                                                                      |
| `app/workflow-driver.ts`                              | actor construction and workflow-driver operations                                                               |
| `app/session-facade.ts`                               | session lookup/query and mutation delegation                                                                    |
| `app/create-app.ts`                                   | app dependency assembly and startup wiring                                                                      |
| `app/workspace-hook-review-controller.ts`             | review request, supervision, and mutation delegation                                                            |
| `zcode-protocol-v4/command-inbox.ts`                  | admission, queue state, and command dispatch helpers                                                            |
| `zcode-protocol-v4/cold-event-merge.ts`               | event normalization and merge rules                                                                             |
| `zcode-protocol-v4/commands/handlers/goal-compact.ts` | goal commands and compact command helpers                                                                       |
| `zcode-protocol-v4/conversation-topic-publisher.ts`   | topic derivation and publication helpers                                                                        |
| `plugins.ts`                                          | marketplace, installation, and filesystem-oriented plugin operations                                            |
| `zcode-protocol-v4/transcript-hydration.ts`           | transcript parsing, event hydration, and record reconstruction                                                  |
| `zcode-protocol-v4/conversation-telemetry-facts.ts`   | telemetry fact derivation groups                                                                                |
| `app/bundled-plugins.ts`                              | bundled-plugin discovery, manifest mapping, and seed verification                                               |
| `zcode-protocol/v4-bridge.ts`                         | V4 request translation and event/response bridge operations                                                     |
| `zcode-protocol/plugins.ts`                           | protocol-facing plugin request handlers                                                                         |
| `zcode-protocol/server.ts`                            | server registration, dispatch, and lifecycle wiring                                                             |
| `zcode-protocol/subagent-session-query.ts`            | subagent query mapping and aggregation                                                                          |
| `zcode-protocol/session-mapper.ts`                    | session record, message, and event mapping                                                                      |
| `zcode-protocol-v4/v4-gateway.ts`                     | state, dispatch, hydration, query, attachment, command, and lifecycle layers behind the existing gateway facade |
| `zcode-protocol-v4/product-projection.ts`             | product projection row, topic, and derived-state reducers                                                       |

## Invariants

1. Every affected production file under the existing `max-lines` rule, including
   each new helper, stays within 400 lines. Existing files with documented,
   pre-existing suppressions outside this inventory are not part of this claim.
2. Existing public export paths and type names remain available. Internal
   helpers are imported only by their owning public module or its direct
   cohesive collaborators.
3. No lint suppression, baseline update, source minification, generated-code
   workaround, or configuration change is used to bypass the limit.
4. Existing behavior is preserved through the current Bootstrap and CLI test
   suites. Test-only work remains owned by the designated test reviewer and
   does not introduce production state or alternate control paths.

## Acceptance

- `pnpm --dir apps/zcode-cli lint` reports no `max-lines` failures for the
  affected Bootstrap production files.
- `pnpm --filter @zcode/bootstrap typecheck` and build pass with the original
  public imports intact.
- The architecture check reports no new violations.
