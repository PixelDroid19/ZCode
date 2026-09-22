# Picker catalog retention

## Ownership

The session runtime owns the adopted capability catalog. The picker hook owns only
the current UI projection while a catalog request is pending. A catalog authority
is identified by the workspace identity (falling back to workspace path), session,
remote attachment, and service instance. Whether the picker is open and which
refresh request is current do not change that authority.

## Behavior

- Opening a picker may re-read its catalog. While that read is pending, retain the
  last successful entries for the same authority and show the loading state.
- A failed refresh for the same authority retains those entries and shows the
  refresh error alongside them.
- Changing workspace, session, remote attachment, or service authority clears the
  prior entries immediately. A late response from the old authority cannot refill
  the picker.
- Concurrent requests are ordered by request generation. Only the latest request
  for the current authority may publish its result or error.
- Reconnecting to a remote service creates a new service authority and bootstraps
  the session catalog through the existing session-scoped catalog RPC. No missed
  capability notification is treated as a replayed catalog.

## Acceptance

Use a browser integration harness that mounts the real React hooks and Lexical
`MentionPlugin`, with catalog RPCs controlled at the service boundary. Exercise
opening and selecting an entry, closing and reopening while a read is delayed,
retention after a failed read, out-of-order responses, session changes, and service
replacement. Assert the visible entries, loading/error states, and inserted mention
identity; do not test a copied state helper in isolation.
