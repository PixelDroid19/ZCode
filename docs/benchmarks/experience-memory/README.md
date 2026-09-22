# Experience memory measurements — 2026-09-22

The current evidence supports durable storage and useful keyword retrieval. It does
**not** yet establish improved agent success, token savings, or superiority to Engram.
Paraphrase retrieval is a concrete weakness of the current lexical search.

## Executed retrieval diagnostic

Runtime commit: `41cabf8`. Node `24.14.0`, Linux x64. Eight synthetic software incidents,
1,000 repetitive UI-catalog distractors and three scope/revision records. SQLite was
closed and reopened before queries. The target had to appear among the first six results.

| Query group                             | Correct target in top 6 |  Rate | Reciprocal rank @6 |
| --------------------------------------- | ----------------------: | ----: | -----------------: |
| Exact technical keywords                |                   8 / 8 |  100% |              1.000 |
| Spanish paraphrases                     |                   3 / 8 | 37.5% |              0.375 |
| English questions about Spanish records |                   2 / 8 |   25% |              0.250 |

The project-isolation, portable-user-record and superseded-record checks all passed.
Across 480 repeated warm searches, p50 was **0.153 ms** and p95 **0.265 ms** on this
machine. These timings cover SQLite search only, excluding model calls, application
startup and extraction. The small target set and repetitive distractors limit
generalization; the rates are not production accuracy estimates.

For example, the record describing a stale task owner and `fencingToken` was found by
those keywords, but not by “Un ejecutor que ya había perdido la concesión seguía marcando
el trabajo como terminado; ¿qué verificamos al cerrar?” This exposes a relevant failure
mode when a later session describes the same problem with different wording.

Every question, returned topic and timing is retained in
[the raw retrieval report](2026-09-22-retrieval.json). The source hash in that report
identifies the exact diagnostic files. Records were manually seeded through the real
store API, so this diagnostic does **not** test automatic extraction or LLM answers.

## Live paired evaluation: blocked

The configured model was `opencode-zen-responses / muse-spark-1.3-contributor-free`, with
reasoning disabled. The first OFF teaching call failed with **HTTP 403 / auth_failed**.
There were **zero evaluated questions** and no provider token usage. Missing usage is
reported as unavailable, never as a zero-cost successful run. No A/B improvement score
can be calculated from this attempt.

[The partial live report](2026-09-22-live-blocked.json) retains the failure evidence.
The planned pilot contains eight cases per arm and two synthetic replicas. It exercises
the actual application, automatic extraction, new sessions, recurrence, corrected facts,
cross-project user preferences and abstention; all model and extraction costs are counted.
An enabled ZCode provider is required to finish it.

The earlier 124 passing integration tests checked mechanics using deterministic fixtures.
They must not be presented as 124 successful real-model benchmark cases.

## Validation of this measurement change

- `pnpm verify:pre-push` passed: types, lint, architecture, CLI builds/native Linux smoke,
  and the existing 124 integration tests across eight package groups (zero skipped).
- The benchmark's separate TypeScript check and lint passed. Repository lint still has
  70 existing warnings and zero errors; the benchmark files have zero warnings/errors.
- One end-to-end integration check uses a local deterministic HTTP provider to validate
  the actual model adapter, automatic extraction, cold-session ON/OFF recall, copied DB
  integrity and measurement attribution. This check is separate from the utility score.
- An independent review inspected the methodology and harness. Findings about output
  leakage, incomplete usage, failure accounting and snapshot integrity were addressed.

## Reproduction and next decision

Commands, ownership, isolation, scoring and limitations are specified in
[the benchmark protocol](../../specs/shared-experience-memory-benchmark.md).
The harness is opt-in and never incurs external model calls during normal CI.

The immediate product improvement to evaluate is semantic or hybrid retrieval, tested
against an expanded held-out corpus and these retained failures. Separately, complete
the paired live evaluation before claiming that automatic memory improves the agent's
task success or reduces total tokens. This measurement change does not alter production
memory behavior or introduce a speculative retrieval fix.
