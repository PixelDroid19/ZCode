# Product projection implementation boundaries

`ProductProjection` remains the sole owner of its snapshot, row indexes and
session/turn bookkeeping. Its constructor, atomic clone/adopt transaction and
public signatures retain their behavior. Protocol callers retain the existing
module path.

Reducer methods are grouped by event domain and receive the same instance as
their typed `this` context. A type-only internal contract connects those methods;
it does not allocate another state object or expose private fields to consumers.
Methods are installed once on the existing prototype with the same writable,
configurable, non-enumerable descriptors as class methods. Installation performs
no I/O and creates no queue, cache, timer or subscription.

```mermaid
flowchart LR
  Event[Session event] --> Owner[ProductProjection instance]
  Owner --> Method[Typed reducer for the event domain]
  Method --> State[Same instance: snapshot and indexes]
  State --> Delta[Conversation deltas]
  Delta --> Commit[Existing atomic accept and adopt]
```

Verification must compare every moved method body and public signature with the
original, typecheck the complete bootstrap package, and compare live/replayed
projections and rejection of an atomic candidate against the original reducer.
No line-limit exception or behavior fallback is added.
