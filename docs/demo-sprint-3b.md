# Demo replies — Sprint 3B

`POST /api/demo/session/messages` requires the opaque demo bearer token and `{ "text": "Do you offer roofing?", "clientMessageId": "<uuid>" }`. It stores or restores the canonical inbound message, commits that transaction, then synchronously generates or restores the AI reply for that exact stored message ID. No separate AI request is needed. The low-level `demoMessageService.create` remains storage-only; `demoConversationService.send` composes storage and the shared runtime. Scope comes from `authenticateDemo`; session, business, customer and DEMO conversation are checked before claiming an input and again before storing the reply. Setup must be `READY` or `READY_PARTIAL`.

The input must be a nondeleted CUSTOMER / INBOUND / TEXT message in that conversation. Retrying a clientMessageId processes its original canonical ID even when newer messages exist. The compatibility `POST /api/demo/session/ai/process-latest` still accepts no body/query parameters and processes the latest eligible customer message through the same internal function. It is not a backlog-draining worker.

## Shared runtime

- `demo-business-context.provider.ts` adapts `demoContextService.getBusinessContext(actor)` into `AiBusinessContext`, preserving normalized facts and explicit nulls. It does not query production Knowledge Hub, prompt configuration, subscription or customer memory records. Tone uses the existing PROFESSIONAL default; plan is null.
- `loadAiConversationHistory` in `ai-context-builder.service.ts` is also used by the production context builder. It bounds history to the configured message limit and the triggering message.
- `generateContextReply` in `ai-reply-runtime.service.ts` is used by the production reply engine and demo orchestration. Both use `aiPromptContextFormatter` and the same `aiProvider.generateReply` provider/parser stack.
- `aiSafetyService.evaluate` still checks confidence, readiness and reply safety. The explicit reply-only demo option allows a conversational explanation of a human request, with no routing. Production human-request handling is unchanged.
- `storeAiReply` in `ai-message-store.service.ts` is shared with `ai-reply-engine.service.ts`. It stores the canonical message, conversation preview/status and message-created activity. Demo orchestration stops there.

When `context.demoFacts` exists, the shared formatter omits production booking, complaint matching, follow-up and human-review action instructions and uses a SEND_REPLY-only response schema. Booking questions solicit details without creating or confirming appointments; complaints receive conversational acknowledgment; human requests explain the demo limitation. Missing prices, hours, durations and policies remain unknown. The production prompt retains its action instructions and schema.

## Persistence, retries and limits

Demo replies use AI / OUTBOUND / TEXT, INTERNAL delivery status, `provider: "DEMO"`, and `providerMessageId` equal to the source customer message ID. Metadata includes `isDemo`, `demoSessionId` and `sourceInboundMessageId` (plus the legacy `sourceCustomerMessageId` alias). Existing DEMO_AI replies are still recognized for replay. The provider correlation is an internal source-message ID, never a WhatsApp ID.

A transaction locks the session and sets `demoAiAttempted` on the source message before provider execution. Each customer message gets at most one provider attempt; failed or interrupted attempts remain consumed. There are at most 50 attempts and 50 stored replies per session. Replaying an existing successful reply works at the cap. The provider call has one model attempt and a 30-second abort budget. No migration is needed.

Failure leaves the inbound message intact and creates no fabricated reply. A failed or currently claimed input returns `503 DEMO_AI_UNAVAILABLE`; sending a new customer message allows another attempt while allowance remains. Other errors include `409 DEMO_SETUP_NOT_READY`, `404 DEMO_CUSTOMER_MESSAGE_NOT_FOUND`, `403 DEMO_RESOURCE_FORBIDDEN`, `400 DEMO_AI_INPUT_INVALID` and `429 DEMO_AI_LIMIT_REACHED`.

## Frontend contract

Create a session, set up the business, then POST a customer message. The send response contains the following fields plus `message`, an alias of `customerMessage` retained for Sprint 3A clients. The compatibility process-latest endpoint returns the following shape without the alias.

```json
{
  "success": true,
  "conversation": { "id": "conversation-id" },
  "customerMessage": {
    "id": "customer-message-id",
    "text": "How much is roof inspection?",
    "senderType": "CUSTOMER",
    "direction": "INBOUND",
    "messageType": "TEXT",
    "createdAt": "2026-09-06T00:00:00.000Z"
  },
  "aiMessage": {
    "id": "ai-message-id",
    "text": "Roof inspection costs GHS 300.",
    "senderType": "AI",
    "direction": "OUTBOUND",
    "messageType": "TEXT",
    "createdAt": "2026-09-06T00:00:01.000Z"
  }
}
```

`GET /api/demo/session/messages` returns `{ success, conversation: { id }, messages }` with the same canonical message fields. It selects the latest 100 messages descending, then reverses them into chronological order. The sample reply above is illustrative; live replies depend on confirmed context and provider output.

## Verification and boundaries

`tests/demo-ai.test.ts` runs the actual prompt formatter, provider abstraction, JSON parser, safety evaluator and persistence helper with mocked database and provider HTTP boundaries. It covers READY/READY_PARTIAL, scoped latest-message selection, actual provider input containing Roof inspection/GHS 300, unknown null values, canonical persistence, replay, concurrent claims, failure preservation, both 50-request/reply limits, expired or changed setup during generation, latest-100 history, HTTP auth/parameter rejection, and conversational booking/complaint/human requests. It also verifies production action guidance remains present.

Forbidden-call spies cover WhatsApp providers/integration lookup, realtime publishing, subscription/usage accounting, memory resolution/jobs, appointments, complaints, notifications, follow-ups and production knowledge. The fetch mock permits only the configured AI completion URL. Successful paths assert zero forbidden calls. This is deterministic runtime coverage, not proof of live model behavior or real database locking.

Additional automatic-send tests verify exact-input correlation after newer sends, concurrent duplicate client IDs, legacy reply replay, failure retries, 50 customer sends producing 100 total rows, and unread increments only for inbound messages. Email delivery and follow-up scheduling are also explicitly spied on. This repository has no payment or quotation service/model wired to this path; the restricted transaction fixture and provider-only fetch mock reject additional database/network work.

`tests/demo-ai.integration.test.ts` covers the full HTTP create/setup/send/retry/history sequence and concurrent dedupe against a real database, with the AI provider mocked. It is opt-in: set `NODE_ENV=test`, `RUN_DEMO_AI_DATABASE_TESTS=true`, and point both `DATABASE_URL` and `DEMO_TEST_DATABASE_URL` to the same dedicated test database before running that file. It refuses to silently use the default application database. This test was not run against the configured application database.

Run with `npm run test:demo`; the suite includes the new tests. Database integration tests remain separately opt-in using `RUN_DATABASE_INTEGRATION_TESTS=true` and should run against a dedicated test database. No realtime delivery, booking, memory, follow-up or notification wiring is added by Sprint 3B.


## Sprint 3C handoff

Still missing: a public session-scoped realtime transport, AI processing/typing state, live customer messages on the business side, live AI replies, and live customer preview updates. Reuse the existing isolated realtime adapter to avoid a polling-only UX. This sprint adds no frontend, QR/mobile customer mode, RAG, WhatsApp onboarding, or demo-to-production conversion.
