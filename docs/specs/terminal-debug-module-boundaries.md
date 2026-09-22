# Terminal and debug module boundaries

## Contract

This is a structural repair of existing CLI lint failures. The terminal entrypoint
continues to dispatch internal tool hosts before parsing normal arguments. Command
validation, permission defaults, protocol input/output, diagnostics and exit codes
must retain their existing behavior. Prompt execution retains its lifecycle and
cleanup; command-center routing and hook diagnostics are separate helpers.

The debug application retains its existing views, trace analysis and ordering.
Formatting, network observation, panels and server analysis are separated along
their existing responsibilities. Public package entrypoints do not change.

No size-rule suppression or larger line limit is part of this change. New helper
modules must satisfy the existing 400-line limit and avoid circular dependencies.

## Validation

Run CLI and debug typechecks and lint, build the debug UI, and run the internal
live-tool host regression. The full runtime and protocol acceptance suites verify
that the structural changes preserve invocation and runtime behavior.
