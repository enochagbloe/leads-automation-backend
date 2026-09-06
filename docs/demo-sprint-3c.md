# Sprint 3C: live demo conversations

## Connect and authenticate

`GET /api/demo/session/events` opens SSE with `Authorization: Bearer <opaque-demo-token>` and `Accept: text/event-stream`. It accepts no query parameters (including resource IDs or query-string tokens). Use a fetch-based SSE client that supports the authorization header; native browser EventSource cannot set that header.

Connect after session creation and before or after setup. Setup readiness is not required for observation; sending messages and running AI still require READY/READY_PARTIAL. Demo authentication and persisted scope resolution check the active, unexpired session, its business, exactly one DEMO conversation, and its synthetic customer. Production JWTs, memberships and subscriptions are not involved. The production `/api/realtime/events` route retains its original authentication and staff/business filters.

Responses use `text/event-stream`, `Cache-Control: no-store, no-transform`, and `X-Accel-Buffering: no`. Invalid authentication fails before streaming. Invalid resource scope fails closed; query parameters return `400 DEMO_STREAM_INPUT_INVALID`. A session can hold at most five simultaneous streams; the process has a 1,000-demo-stream ceiling. Excess connections receive `429 DEMO_STREAM_LIMIT_REACHED` before SSE headers are sent.

## Shared infrastructure and isolation

`realtime.service.ts` retains its production and demo subscriber adapters, sharing SSE event framing and the existing 25-second heartbeat timer. Demo publishing requires an exact match on demoSessionId, businessId and conversationId. Demo events are never sent through the production subscriber registry, and production events never enter the demo registry.

`demo-realtime.service.ts` resolves server-side scope before connecting or publishing domain events. Heartbeats revalidate persisted scope and the feature flag. Session expiry also has an exact connection timer; session destruction closes local subscribers after its transaction commits. Request disconnection, response errors, expiry, destruction and server shutdown remove registry references and timers/listeners. Slow clients that exceed the response buffer are disconnected rather than queued indefinitely.

## Event envelope and payloads

SSE framing uses `id`, `event`, and JSON `data`. Domain event data contains:

```json
{
  "id": "event-uuid",
  "type": "message.created",
  "createdAt": "2026-09-06T12:00:00.000Z",
  "isDemo": true,
  "demoSessionId": "own-session-id",
  "businessId": "own-business-id",
  "conversationId": "own-conversation-id",
  "payload": {
    "id": "stored-message-id",
    "conversationId": "own-conversation-id",
    "senderType": "CUSTOMER",
    "direction": "INBOUND",
    "messageType": "TEXT",
    "text": "Do you offer roofing?",
    "createdAt": "2026-09-06T12:00:00.000Z"
  }
}
```

Events:

| Event | Payload |
| --- | --- |
| `demo.connected` | `{ conversationId }`, in the shared event envelope with business/conversation IDs and timestamp |
| `message.created` | Canonical fields shown above; AI replies use AI / OUTBOUND / TEXT |
| `conversation.updated` | `{ id, conversationId, lastMessagePreview, lastMessageAt, unreadCount, status, updatedAt }` |
| `demo.ai.processing` | `{ conversationId, messageId: sourceInboundMessageId, status: "STARTED" | "COMPLETED" | "FAILED" }` |
| `ping` | `{ ts: "ISO timestamp" }`, matching the production heartbeat framing |

Message events omit metadata, provider/model details, credentials, raw DemoContext and internal decision data. Conversation snapshots represent current committed state and can reflect another concurrent write. AI outbound storage does not increment unread count.

## Persistence and lifecycle

The existing synchronous send contract remains unchanged. With an open stream, `POST /api/demo/session/messages` produces:

1. Commit a new customer message, then publish CUSTOMER `message.created` and `conversation.updated`.
2. Commit the AI processing claim, then publish `demo.ai.processing` STARTED.
3. Run the existing shared context/provider/parser/safety runtime outside database transactions.
4. Commit the AI reply, then publish AI `message.created`, `conversation.updated`, and processing COMPLETED.
5. Return the ordinary HTTP customer/AI response.

If provider, safety or final-save processing fails, the claim owner publishes FAILED only while its session/resources are still valid. The original customer remains stored and no fabricated AI message is created. No typing Message rows are written. The compatibility process-latest endpoint uses these same AI lifecycle hooks.

Inbound dedupe returns a private created/not-created result from the storage transaction. Only the creator publishes customer creation. Only a newly acquired durable AI claim publishes STARTED and a terminal state; replaying an existing reply or retrying an already claimed input does not publish a second lifecycle. No network delivery occurs within a storage transaction, and best-effort SSE failure does not change a committed HTTP success into an error.

## Reconnect and deployment limits

After each connection/reconnection, fetch `GET /api/demo/session/messages` to restore the latest 100 canonical messages, ordered chronologically. Merge message events by stored message ID to handle overlap with the recovery fetch. Clear stale typing indicators on reconnect and key new processing indicators by source message ID. HTTP message responses can also reconcile state.

There is no event log or Last-Event-ID replay buffer. A crash between commit and publication can lose an event; the database remains authoritative. Delivery is in-process and best-effort, matching existing production SSE. Send requests and SSE connections need affinity to the same backend instance for live delivery. Destruction elsewhere is detected at the next heartbeat; locally it closes streams immediately after commit. No broker or cross-process delivery guarantee is added.

## Tests and scope

`tests/demo-realtime.test.ts` covers authenticated HTTP connection before setup, rejected tokens/query scope, production auth separation, three-key event isolation, production staff filtering, heartbeat/validity checks, expiry, subscriber limits, disconnects, destruction cleanup and backpressure. `tests/demo-ai.test.ts` verifies commit-before-publish, lifecycle order, failures, idempotent replay, safe payloads, and a real local HTTP SSE stream receiving STARTED while the mocked provider remains pending, followed by the committed AI reply and COMPLETED. AI/database boundaries are mocked for these tests.

Run `npm run test:demo`, application typecheck and test typecheck. Dedicated database integration tests remain opt-in and must not run against the application/production database.

This sprint adds no frontend, QR/mobile mode, appointments, memory extraction, follow-ups, quotations, payments, notifications, WhatsApp sends, RAG or production subscription accounting. The frontend can now connect, set up the business, send messages, and render the live lifecycle without a polling-only conversation flow.
