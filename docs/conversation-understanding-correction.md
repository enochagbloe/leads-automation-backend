# Urgent conversation understanding correction

This patch extends the existing interpreter → validated state commands → planner → response → validation architecture. It applies to production and demo conversations across industries. Sprint 5 is out of scope.

## Root causes and reused architecture

Ordinary semantic mutations used `max(AI_MIN_CONFIDENCE, AI_AUTO_CONFIRM_MIN_CONFIDENCE)`, normally 0.85. The auto-confirm setting therefore governed language understanding. The response prompt also suggested an option-specific clarification without requiring relevant choices. The planner had no explicit greeting signal, so a greeting could be forced through a no-question answer/repeated-greeting policy.

The existing appointment adapter already collects date/time before catalog mapping and does not require a customer to diagnose a problem or name a service merely to start collecting appointment details. It was reused unchanged. Existing scope checks, revision checks, evidence validation, atomic state batches, interpretation receipts and message persistence were reused.

Live checks found additional contract inconsistencies: missing workflow fields were being treated as semantic ambiguity; an unchanged historical date could be revalidated against a later message; and several compatible option candidates could be reduced to one by a conflicting model-selected position.

## Implementation

- Semantic confidence now uses `AI_MIN_CONFIDENCE`, normally **0.75**, for overall interpretation and relevant entities/selections/confirmations. Below-threshold and ambiguous results remain non-mutating.
- `AI_AUTO_CONFIRM_MIN_CONFIDENCE`, normally **0.85**, remains in appointment settings and `evaluatePremiumAppointmentAutoConfirmation`. No appointment/payment/human-review authorization threshold was lowered. An isolated test proves a 0.80 interpretation cannot auto-confirm; 0.90 still cannot bypass payment or human-review requirements.
- The existing interpreter now explicitly understands typos, transpositions, informal grammar, missing punctuation, shortened words, repetition, speech-to-text, phonetic spelling and casing. Confidence measures meaning, not grammatical quality. Evidence must still quote the original literal message, never a corrected transcript.
- Missing date/time is distinguished from an unclear booking goal. A bounded consistency rule handles the structured provider codes MISSING_DATE, MISSING_TIME and MISSING_DATE_TIME only for high-confidence booking goals, exact supplied entities, genuinely absent fields, and no competing reference/confirmation/topic ambiguity. All evidence, type, reference and workflow validation still runs. Invalid evidence, low confidence and approximate values cannot use this rule. This normalizes provider metadata; it does not recognize customer phrases. Approximate/ambiguous time remains uncertain and uncommitted. A single evidenced uncertain temporal field can become a narrow clarification target.
- Optional `conversationAct: GREETING` annotates the existing GENERAL_QUESTION intent. The planner can request a greeting and one offer of help; it grants no workflow/action permission. Substantive messages that begin with a greeting use their actual intent. Existing interpretation receipts remain compatible; no migration is needed.
- High-confidence structured YES/NO responses can inherit the intent of their actual pending confirmation workflow. No pending confirmation, low confidence, conflicting workflow or topic interruption cannot use that normalization.
- Unchanged, properly evidenced CONVERSATION_CONTEXT entities retain their canonical value and provenance instead of rewriting it or re-anchoring an old relative date.
- More than one final compatible option candidate remains ambiguous even when a model simultaneously selects a position. Scope and reference validation remain mandatory.
- Clarification options must be fresh and relevant to the pending option-selection field/reason. A bounded validator rejects option/choice/ordinal wording and option IDs when those choices are absent, stale or unrelated. One existing corrective regeneration is allowed, followed by the neutral validated fallback when needed.
- Demo reply wording is checked against its existing conservative booking safety gate before acceptance. The limited unavailable-availability fallback explains that live availability/booking are not connected, without claiming execution. The downstream safety gate is unchanged.

No typo dictionary, phrase-specific message handler, preprocessing model, spellcheck call, separate demo engine, or new workflow module was added. Normal execution remains one interpretation call plus one response call. The pre-existing single corrective response attempt remains available.

## Changed files

- `src/services/conversation-interpretation-policy.ts`: threshold, pending-confirmation normalization, ambiguous-candidate protection, unchanged historical values.
- `src/services/conversation-interpretation.schema.ts` and `conversation-interpretation-output.ts`: optional greeting annotation and semantic contract guidance.
- `src/services/conversation-interpreter.service.ts`: noisy language, literal evidence, clear goals versus missing details, corrections and genuine ambiguity instructions.
- `src/services/conversation-planner.service.ts`: greeting response directive and narrow temporal clarification.
- `src/services/conversation-response.service.ts` and `conversation-response-policy.service.ts`: grounded clarification, greeting behavior and demo wording safety.
- `tests/conversation-interpreter.test.ts`, `tests/conversation-response.test.ts`: controlled-provider validation, planner, evidence, threshold and safety regressions.
- `tests/conversation-understanding.live.test.ts`: opt-in real-provider multi-turn dental and consultancy sequences, in-memory persistence, no production effects.
- `docs/conversation-system-sprint-2.md`: corrected confidence documentation.
- This report.

## Exact live reproduction

The final real-model run on 2026-09-16 used synthetic demo contexts and in-memory database adapters. The shared runtime, state policy, planner, response validator, demo safety gate and atomic reply persistence ran normally. No external business effects were enabled.

| Input | Observed result |
| --- | --- |
| `hello` then `hrllo` | Both GENERAL_QUESTION with greeting behavior; `Hello! How can I assist you today?`; no typo explanation or clarification. |
| `right its a typo my teeth hurts and i want to check on it` followed by `i dont know what is actually wrong but when can i come in` in the same message | BOOKING_INTENT, APPOINTMENT topic, APPOINTMENT_BOOKING state and reason retained; ASK_FOR_FIELD preferredDate. Reply: `When would you prefer to come in for your appointment?` |
| `i wnt to book tomorow at 2` | With explicit prior afternoon context: preferredDate 2026-09-17 in Africa/Accra and preferredTime 14:00. Demo explains live availability is unavailable; no appointment created or confirmed. |
| `can i com at 12` | With prior noon/afternoon context: preferredTime becomes 12:00, existing date preserved. |
| Equivalent consultancy problem and visit request | Same appointment state and date collection, followed by the same date/time corrections. |

Both five-turn sequences passed. All ten turns used two model requests, no fallback in that final multi-turn run, no option-selection clarification, no diagnosis in the replies and no claims of successful booking. Earlier live failures drove the missing-field, evidence and safety corrections; those failures were not counted as passes.

## Verification

Required deterministic suites: interpreter 64 passed, planner 31 passed, response 65 passed, state 9 passed / 1 database integration skipped, demo 74 passed / 6 database integrations skipped. Total: **243 passed, 7 skipped**. Typecheck, test typecheck and build were executed successfully.

The final combined opt-in interpreter/response smoke command reported 12 passed and one provider timeout. A focused correction retry exposed MISSING_DATE despite a clear time correction; after the bounded consistency fix, that focused live case passed. All 13 smoke scenarios therefore have observed passing results, but the combined command itself was not claimed to pass. The two new multi-turn live tests passed using synthetic data with real provider calls. These are sampled model-quality checks, not deterministic guarantees.

## Limits

Bare numbers need reliable AM/PM context. Ranges, approximate times and missing referents remain clarification cases. Model output still varies; a passing sample does not prove every future utterance will be interpreted correctly. The existing bounded regeneration/fallback behavior remains. The reply prose can still be repetitive, and this patch does not implement the later natural conversation planner/tone redesign. The generic low-confidence safety gate remains in force. No production database concurrency suite or actual appointment creation was run in this task.

Restart the backend to load the patch. A previously failed message ID remains protected by the existing claim/replay policy; use a fresh message or demo session for frontend verification.
