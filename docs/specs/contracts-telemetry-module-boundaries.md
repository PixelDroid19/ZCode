# Contracts and telemetry module boundaries

## Preserved behavior

Large public contracts are split by domain concept while their existing import
entrypoints continue to re-export the same types and runtime values. This does not
change schemas, serialization, event order, persistence or accepted inputs.

Event projection keeps one reducer. Independent handler tables separate session,
turn and tool/permission projections without creating additional state owners.

Telemetry keeps one execution runtime and one writer lifecycle. Span writers,
labels, no-op implementations and recorder classification helpers become explicit
modules. Trace propagation, parentage, limits, writer cleanup, error categories and
exporter behavior remain unchanged.

## Validation

The existing 400-line lint rule remains enabled. Run contracts and telemetry
typechecks, lint and builds; run the live runtime and protocol acceptance suites.
Compare public exports and declaration bodies with the pre-refactor source to
catch accidental changes during extraction.

The telemetry regression tests use an in-memory OpenTelemetry exporter with a real
async context manager. They verify turn/model/attempt and tool/command parentage,
background causation links, identity, a shared factory capacity limit, session
isolation and exactly-once writer cleanup.
