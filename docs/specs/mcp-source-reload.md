# MCP executable source reload

## Contract

Live capability discovery watches explicit MCP command files even when they
have no extension or use `.exe`. An explicit path is absolute, equals `.` or
`..`, starts with `./` or `../` (using the platform separator), or contains a
platform path separator. A bare command name, including `.hiddenCommand`,
continues to resolve through `PATH` and is not treated as a workspace file.
Relative `cwd` resolves against the workspace first; relative command and script
argument paths then resolve against that `cwd`. Windows paths retain the current
platform's path semantics.

Existing argument discovery remains in place: arguments ending in the supported
script extensions (`.js`, `.mjs`, `.cjs`, `.ts`, `.py`, `.sh`) continue to be
watched relative to `cwd` or workspace path. This behavior supports wrappers
that launch scripts. The loader does not add runtime-specific command-line
parsers or remove arguments that were already treated as script inputs.

The source file content, resolved target path, and executable permission bits are part of the capability
revision, including files without a recognized source extension. A POSIX mode-only
change can make a command runnable or prevent its next spawn, so it also triggers
reconciliation. Retargeting a symlink also changes executable identity, even when
the target bytes match, because relative resources can change. Missing explicit files are fingerprinted
as missing so creating or removing one changes the next candidate. A source edit
during preparation rejects the candidate; the currently adopted generation
remains callable until a complete replacement commits. Explicit command and
script files are streamed through a bounded hash (256 MiB per file, 512 MiB in
total) so a binary executable can be tracked without loading it wholly into
memory.

## Acceptance

- Editing or removing an extensionless executable or `.exe` entry script changes
  the candidate revision after its watched path is refreshed.
- A bare command is not watched as a file, while known-extension script arguments
  remain tracked even when the command itself is a wrapper resolved by `PATH`.
- A dot-prefixed bare command without a separator is still resolved through `PATH`.
- Relative `cwd` resolves against the workspace; explicit commands and supported
  script arguments then resolve against that `cwd` or workspace path.
