# Instant demo: Sprint 3A

## Delivery

Added `src/services/inbound-message-store.service.ts`, extracting the transactional message/conversation/activity storage shared by the existing `createInboundCustomerMessage` function and WhatsApp inbound persistence. Both existing paths now call this core. Their transport-specific consent, reopening, cache, audit, quota, notification and automation behavior remains outside the core and in the existing wrappers. The demo calls only the storage core, never a WhatsApp wrapper or webhook.

Added `src/services/demo-message.service.ts` as the scoped transport adapter. Modified demo routes, message rate limits, the session's reported message allowance and demo JSON body size (16 KiB so 2,000-character text fits). Modified customer-memory discovery/cursor selection and due-job eligibility to exclude businesses whose demoSessionId is non-null, preventing background extraction of newly stored demo text. No other automation is added.

Added unit/HTTP tests in `tests/demo-message.test.ts` and database integration coverage in `tests/demo-message.integration.test.ts`; updated `test:demo`. No schema or migration changes are required. Reuses the existing partial unique index `Message_businessId_provider_providerMessageId_key` from the WhatsApp inbound foundation migration.

## API

POST `/api/demo/session/messages`

Authorization: Bearer <demo token>

```json
{
  "text": "Hi, do you offer roofing?",
  "clientMessageId": "988ac0ef-cda4-4fa4-8657-aacbc1ff9e75"
}
```

Strict validation accepts trimmed text of 1?2,000 JavaScript characters and a required UUID clientMessageId, normalized to lowercase. Unknown fields (including business/conversation/customer/lead/session IDs and senderType) are rejected with 400 DEMO_MESSAGE_INVALID. Non-ready sessions return 409 DEMO_SETUP_NOT_READY. Scope mismatches fail closed with DEMO_RESOURCE_FORBIDDEN; the auth middleware also rejects invalid/expired credentials before entering the adapter.

Both initial storage and an identical retry return HTTP 200:

```json
{
  "success": true,
  "conversation": { "id": "server-resolved-conversation-id" },
  "message": {
    "id": "canonical-message-id",
    "text": "Hi, do you offer roofing?",
    "senderType": "CUSTOMER",
    "direction": "INBOUND",
    "messageType": "TEXT",
    "createdAt": "2026-09-05T12:00:00.000Z"
  }
}
```

GET `/api/demo/session/messages`, with the same demo authentication, returns `{success, conversation:{id}, messages:[...]}` with the same canonical message shape. Ordering is ascending createdAt then id. This is a small Sprint 3A history endpoint bounded to 50 records, not a duplicate production conversation API. It has no mutation limiter. The general session response remains free of message history and now advertises messages:50 in its limits.

## Isolation, retries and limits

The adapter derives resources from req.demo.demoSessionId/businessId and checks the active unexpired session, persisted business ownership, setup READY/READY_PARTIAL, exactly one current conversation, DEMO channel and its lead's business plus server-generated demo customer identifier. It never trusts frontend resource IDs. The read endpoint applies the same resolution and filters messages by business, conversation and lead.

Before storing, a conditional update locks the DemoSession row inside a transaction. This serializes concurrent sends with each other and with setup/destruction across backend instances. Resources/readiness/expiry are checked again after the lock. Message rows use provider=DEMO and providerMessageId=`demo:<sessionId>:<clientMessageId>`. The existing database unique index is the final duplicate barrier. Matching retries return the stored canonical message without changing unread count or adding activity. Reusing an ID with different trimmed text returns 409 DEMO_MESSAGE_CONFLICT. IDs are independent across sessions.

The lifetime allowance is 50 CUSTOMER messages in the session's demo conversation. Count includes soft-deleted customer rows to avoid resetting the allowance. Deduplication runs before the count so a successful send can still be retried at the limit. New messages above the cap return 429 DEMO_MESSAGE_LIMIT_REACHED. A separate 30-request/session/minute limiter returns DEMO_MESSAGE_RATE_LIMITED. Existing request-rate storage remains process-local; transaction serialization and the lifetime cap are database-backed.

## Storage and side effects

The shared core creates a canonical CUSTOMER/INBOUND/TEXT/DELIVERED Message, increments Conversation.unreadCount, updates lastMessagePreview/lastMessageAt (and Prisma updatedAt), and writes the normal MESSAGE_CREATED lead activity. Demo metadata is explicitly labelled isDemo/demoSessionId. No fake phone number, production actor, membership or WhatsApp message ID is created.

The storage core imports only Prisma types/enums and calls only Message, Conversation and LeadActivity persistence. It does not call AI, DemoContext runtime loading, intent detection, memory extraction, follow-ups, notifications, realtime publishing, external providers or subscription/usage services. The demo adapter likewise invokes none of those hooks. Existing WhatsApp boundary guards remain unchanged. No automatic AI replies or realtime chat events are introduced.

Because the memory worker independently discovers stored customer messages, demo businesses are excluded at discovery, cursor selection and due-job eligibility. Follow-up inbound hooks are never called by the demo adapter, and the existing follow-up discovery is WhatsApp/automation-scoped. No plan counters or UsageRecord rows are written.

## Cleanup and verification

Existing Business/Conversation ? Message cascading foreign keys remove these messages during demo destruction; the transactional demo cleanup ownership checks remain intact. No cleanup schema change is needed.

Unit/HTTP tests cover READY and READY_PARTIAL storage, setup/expiry rejection, forged scope/lead/channel, strict text and UUID validation, retry behavior and unchanged side effects at the cap, shared production storage metadata/preview/timestamp behavior, memory eligibility, authenticated history, and a 2,000-character multibyte HTTP request. Spies assert zero calls to AI completions/replies/streams, Meta/Mock provider send methods, integration lookup, the provider's business-lookup path, DemoContext runtime loading, network fetch, and production usage/subscription delegates. The storage transaction stub exposes only the approved persistence delegates; unintended quota/automation writes fail the success tests.

The opt-in PostgreSQL integration test verifies concurrent identical retries produce one message/activity/unread increment, same client IDs across sessions remain independent, competing writes at 49 admit exactly one, retries at 50 still succeed, memory eligibility is zero, no demo AI/usage/subscription rows exist, and cleanup removes demo A messages while preserving demo B and a production-shaped fixture message. Run it only against a migrated disposable test database with RUN_DATABASE_INTEGRATION_TESTS=true. It is not automatically run against the configured live database.

Verification result: the full demo suite passed 36 tests; five opt-in PostgreSQL integration tests were skipped. Four existing customer-consent tests also passed. Application and test typechecks passed. The new database concurrency/cascade test was added but not run against the configured live database. No migration or client regeneration was needed.

## Sprint 3B handoff

Use the returned canonical message.id as the stable inbound event/idempotency key, with the server-authenticated demo actor and server-resolved conversation.id. The persisted Message contains businessId/leadId/conversationId, CUSTOMER/INBOUND/TEXT, provider DEMO and demo-labelled metadata. Load normalized demo context through the existing demoContextService only when Sprint 3B explicitly adds AI. Deduplicate AI work by stored message ID; HTTP retries intentionally return the same canonical response and must not produce duplicate replies.

Sprint 3B must explicitly introduce the shared AI-pipeline adapter and scoped response transport; it must also extend history limits/pagination to account for AI messages. Sprint 3A stops at canonical customer message storage. No AI loop, appointments, memory, follow-ups, notifications or extra realtime work is implemented.
