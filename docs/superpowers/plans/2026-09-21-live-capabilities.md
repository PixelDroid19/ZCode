# Live capability implementation plan

Goal: make extension changes usable in existing CLI/TUI/Desktop sessions, including
the next step of the same turn, through a single runtime owner.

Spec: [live-capabilities](../../specs/live-capabilities.md).

## Global constraints

Preserve workspace identity, permissions, explicit session overrides and both
delivery modes. Use public package entries and asynchronous adapter IO. Keep
extension code out of the host discovery process. No cache/performance claims
without measurements. Work on `feature/live-capability-runtime`.

## Workstreams and dependencies

- [x] Core: define the public prepared-capability source, serialized atomic registry
      replacement and model-step adoption; update skill/plugin reads; test rejection,
      deletion, same-turn adoption and calls retaining their original handlers.
- [x] Sources: independently implement validated programmable tool manifests and
      asynchronous content revisions in adapters, plus bootstrap conversion to normal
      tool entries. Test invalid/duplicate manifests, JSON transport, cancellation,
      script edits and deletion. Depends only on the agreed public source contract.
- [x] Bootstrap integration: combine existing config/plugin/skill discovery and MCP
      staging; wire every app entry to the source and lifecycle disposal. Depends on
      core and source APIs. Test real temporary workspaces with scripted model calls.
- [x] Surfaces: expose adopted revision/status via existing catalog queries and
      refresh CLI/TUI/Desktop views through their current services. Depends on core
      status API; no renderer-owned capability registry.
- [x] Independent validation: build affected packages, run focused integration,
      root typecheck/lint/architecture, review adversarially and resolve findings.

## Review focus

Check active query versus model-step races; permissions after tool replacement;
MCP replacement failure and cleanup; workspace isolation; malformed edits preserving
the last valid environment. Each owning workstream adds a regression case before
implementation and records the actual command/result.

## Evidence log

Baseline: clean main, freshness check passed, architecture 0 violations. Existing
root typecheck passed; root lint has 70 warnings and 0 errors.

Implemented on `feature/live-capability-runtime`. Final acceptance and the existing
lint/packaging limitations are recorded in
[the validation report](../../specs/live-capabilities-validation.md).
