# MCP connection admission

## Ownership and contract

Each MCP pool owns one admission queue shared by every adapter it creates. At most
eight connection attempts may prepare a transport, negotiate MCP, and list tools at
once. Reconnects use the same adapter path and admission owner. A standalone adapter
owns its own queue. The pool's identity and lease rules remain authoritative; admission
does not create a second catalog or a different connection key.

The permit lasts until the actual connection attempt settles, even when a caller's
OAuth wait budget returns an earlier status snapshot. Interactive browser authorization
releases the permit after closing its failed transport; an authorized retry must acquire
a new permit. Waiting for a human must not block every unrelated MCP server.

Queued work observes its existing abort signal and never starts after cancellation.
Closing a pool first stops admission and rejects queued attempts, then closes its
adapters and waits for active attempts to release their permits. A closed or superseded
lease cannot return a newly connected status or resurrect ownership after an await.
Configuration byte and record limits are specified separately in `mcp-input-limits.md`.

```mermaid
sequenceDiagram
  participant Caller as Session / settings / refresh
  participant Pool as Shared pool and lease owner
  participant Adapter as Adapter connection lifecycle
  participant Queue as Pool admission queue
  participant Server as MCP process or remote server
  Caller->>Pool: Connect or revalidate
  Pool->>Adapter: Connect with the same identity
  Adapter->>Queue: Acquire permit with abort signal
  Queue-->>Adapter: Admit at most eight attempts
  Adapter->>Server: Transport, negotiate, list tools
  opt Caller wait budget expires
    Adapter-->>Caller: Current status; attempt retains permit
  end
  Server-->>Adapter: Success or failure
  Adapter->>Queue: Release permit
  Adapter-->>Pool: Final connection result
```

## Acceptance

One integration scenario uses real MCP processes and a local coordination server to
observe overlapping handshakes from several leases. It exercises normal startup,
a caller returning before initialization completes, cancellation while queued,
revalidation, and pool shutdown. It must prove the maximum remains eight, canceled
queued attempts never contact the server, shutdown drains active work, and released
leases cannot report successful ownership. Test the runtime flow, not the queue in
isolation.
