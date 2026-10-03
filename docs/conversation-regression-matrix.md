# Conversation Sprint 6A regression matrix

Run `pnpm exec tsx --test tests/conversation-regression.test.ts`.

The matrix uses the real shared context runtime, interpretation parser and command
executor, state service, planner, response generator/validator, and message store.
It reuses the existing in-memory state fixture, response-output helper and canonical
demo-context adapter. Provider outputs are controlled proposals; the tests do not
prove that a live model understands the example phrases.

## Coverage

| Sequence | Assertions |
| --- | --- |
| Need → date → time → production booking | Canonical service and goal retained; next missing field; REQUESTED has no confirmation claim; persisted confirmed/pending/review result is truthful; workflow completes only on success |
| Options → yes → date/time corrections → service replacement | Actual option ID/value resolution; confirmation context; unrelated fields preserved; corrected values reach plan; replacement clears old schedule/options |
| Price side question → different primary goal → pause → ambiguous return → explicit resume → cancellation | Answer plus pending question; preserved purpose/expectation; clarification does not resume/cancel; exact next missing field; cancellation clears temporal state and replays idempotently |
| Pause → direct answer → expired option selection | Answer resolves preserved date; planner asks time; expired choice cannot authorize a time or action |
| Human request / complaint during collection | Human-review plan outranks booking; no workflow request or slot lookup; Demo uses its existing review policy |
| Full request → slot/backend failure → retry | FAILED has no success claims; reservation remains without appointment; no premature completion; retry creates one appointment and replays its receipt |
| Generated plan → newer state → persistence/execution | Both stale operations fail with revision conflict; no reply or appointment created |
| Complete Demo request | Same understanding and collection; availability request remains non-executing; no production slot lookup/appointment or confirmation |
| Persisted reply → duplicate request | Store replay retains one message; actual production and Demo entrypoint replay guards return it without another provider call |

Twenty-one tests span consultancy, repair, salon, clinic and photography catalogs.
Production and Demo run the same runtime code. Business-specific phrases appear
only in test fixtures. No production code, schema, AI stage or tier policy changed.

## Boundaries and findings

- Prisma state/message operations use the existing transaction-aware memory fixture.
  Appointment creation and its atomic receipt linkage are simulated at the existing
  appointment adapter boundary. This is not a PostgreSQL concurrency or appointment
  engine integration test.
- Tests compose the real shared runtime, trusted execution and persistence services;
  they do not run the entire WhatsApp webhook, usage-accounting or outbound transport.
  Production writes to services, appointments, memory, follow-ups and notifications
  outside the simulated trusted adapter are guarded against.
- Workflow-provided options and confirmation expectations are seeded through the
  state API. Their language interpretation is a controlled provider output, not a
  new planner or language resolver in the fixture.
- Calling the raw runtime after reply persistence rejects the older interpretation
  revision. This is intentional stale-write protection, not evidence of an endpoint
  replay failure: both actual entrypoint replay guards return the committed message.
- No production defect was established by the completed matrix. Real database
  locking, live provider quality and full delivery orchestration remain outside it.

Verification: the new suite passed 21/21 with zero skips or TODOs. Repository
`pnpm typecheck` is recorded separately in the implementation report; it checks
production sources, not test TypeScript. No existing suites were rerun.
