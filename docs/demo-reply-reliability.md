# Demo reply reliability fix

## Reproduced failures

The configured PostgreSQL database rejected the contextual interpretation transaction with Prisma P2028 after approximately 5.3 seconds. The same transaction completed in 7.5 seconds with a longer budget, verified using a forced rollback.

A fresh end-to-end demo then exposed `CONVERSATION_PLAN_CONTROL_CHANGED`: demo creation deliberately stores `aiEnabled: false` to disable production automation, but the shared planner incorrectly treated that flag as disabling the separately authorized demo reply path.

## Changes

- Database-only conversation transactions use a configurable bounded timeout: `CONVERSATION_TRANSACTION_TIMEOUT_MS=20000`, with a 10-second transaction acquisition wait. Existing caller-owned transactions retain their owner’s options. No model calls run inside these transactions.
- Demo processing allows `DEMO_AI_PROCESSING_TIMEOUT_MS=90000` for the shared interpretation/response pipeline. Individual provider timeout limits still apply. This signal is a provider cancellation budget, not an HTTP request deadline; database operations have their own bounded budgets.
- After validating tenant ownership, DEMO channel and active session expiry, the planner permits demo replies despite the production `aiEnabled` flag. Human takeover/review still blocks replies. Production conversations still honor `aiEnabled: false`.
- Runtime demo failures include safe reason codes and, where available, a Prisma code. Original exception messages, SQL, prompts, tokens and arbitrary error context are excluded.
- Replay, attempt caps and production side-effect restrictions remain enforced.

## Verification

A new synthetic company-only demo used the configured database and live AI provider. The canonical customer message and AI reply were persisted. Replaying the same client message ID returned the same AI message. The unknown-price response passed through the existing safe deterministic fallback after two model responses failed response policy. The send and replay took approximately 69 seconds. The synthetic session was destroyed after verification.

Regression tests cover explicit transaction budgets, safe timeout diagnostics, retained inbound messages, demo eligibility with production automation disabled, and production/human control enforcement. Shared fixtures now mirror the real demo `aiEnabled: false` setting.

## Operational follow-up

Restart the backend to load the new defaults. Send a new message or start a new demo after an earlier failed attempt: an already claimed failed message is deliberately not reprocessed under the same client ID. No schema migration is required. Database latency and model latency still affect response time; this change does not guarantee every provider response will pass response policy.

## Plan-bound response contract follow-up

A service enquiry reproduced `CONVERSATION_RESPONSE_INVALID`: the planner selected ANSWER with no question, but both model attempts appended a question and failed `QUESTION_COUNT_INVALID`. The generic retry listed a code without spelling out the required correction.

Response generation now specializes the output schema and instructions for each trusted plan: exact purpose, asked field (including null), question count and human-review flag. Corrective generation repeats those explicit requirements. Deterministic validation remains unchanged; a model cannot bypass response policy by supplying valid-looking metadata.

This is shared, industry-neutral behavior. Dental and management consultancy enquiries are test fixtures, not runtime branches or hard-coded business facts.

Verification: 54 response tests and 74 demo tests passed; 6 database integration tests skipped. Both typechecks and build passed. All 8 opt-in live smoke cases passed: dental used one model response, consultancy used one corrective retry, and unknown pricing used the existing safe fallback. Replaying generation against the previously failing stored demo context passed on the first model attempt without saving a reply or modifying the failed inbound message. These checks demonstrate the observed failure is corrected, not that every future model output is guaranteed valid.
