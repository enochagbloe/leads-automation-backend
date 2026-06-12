# Frontend Sprint 4 Handoff

## Sprint goal

Sprint 4 Modules 1-5 add WhatsApp inbound processing, staff outbound text replies, delivery statuses, End Chat, automatic reopen, realtime inbox events, and per-business WhatsApp connection management. There is no Meta Embedded Signup UI, AI reply, media, or billing flow yet.

## WhatsApp connection management

All endpoints require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/business/whatsapp/status` | Owner, manager, staff |
| GET | `/api/business/whatsapp/health` | Owner, manager, staff |
| POST | `/api/business/whatsapp/connect/start` | Owner only |
| POST | `/api/business/whatsapp/connect/complete` | Owner only |
| POST | `/api/business/whatsapp/deactivate` | Owner only |
| POST | `/api/business/whatsapp/change/start` | Owner only |

Start a mock connection:

```json
{
  "provider": "MOCK_WHATSAPP",
  "displayPhoneNumber": "+233241234567"
}
```

Mock mode connects immediately. Live Meta mode returns `CONNECTING` and requires `/connect/complete` after the provider flow succeeds.

Live connection completion is accepted only after `/connect/start`. The backend verifies that the supplied Meta access token can access the requested phone number, and if a WABA ID is supplied, confirms the number belongs to that WABA before marking it connected. Mock connections are rejected when the backend runs in live provider mode.

Each connected business uses its own encrypted Meta credential for outbound sends. The credential is never returned by status, health, or connection responses.

Connection status values:

```text
NOT_CONNECTED
CONNECTING
CONNECTED
DEACTIVATED
ERROR
```

Safe status response:

```json
{
  "status": "CONNECTED",
  "provider": "MOCK_WHATSAPP",
  "displayPhoneNumber": "+233241234567",
  "connectedAt": "2026-06-12T10:00:00.000Z",
  "deactivatedAt": null,
  "automationEnabled": true,
  "canSendMessages": true,
  "lastHealthCheckAt": null,
  "lastErrorCode": null,
  "lastErrorMessage": null
}
```

Raw access tokens and provider secrets are never returned. V1 allows one active WhatsApp number per business on every plan.

After deactivation:

- Outbound WhatsApp replies return `WHATSAPP_DEACTIVATED`.
- WhatsApp conversation AI flags are disabled.
- Existing leads, conversations, and messages remain visible.
- Inbound webhooks for the historical number are stored with `automationSkipped: true`.

Listen for:

```text
whatsapp.connection.updated
whatsapp.connection.deactivated
whatsapp.connection.error
```

Management errors:

```text
WHATSAPP_NOT_CONNECTED
WHATSAPP_ALREADY_CONNECTED
WHATSAPP_DEACTIVATED
WHATSAPP_CONNECTION_NOT_FOUND
WHATSAPP_NUMBER_LIMIT_REACHED
WHATSAPP_PROVIDER_CONFIG_MISSING
WHATSAPP_PROVIDER_CREDENTIAL_REQUIRED
WHATSAPP_PROVIDER_OWNERSHIP_VERIFICATION_FAILED
WHATSAPP_CONNECTION_NOT_STARTED
FORBIDDEN
```

## What changes in the inbox

Mock or live inbound text messages now appear through the existing lead and conversation APIs:

- A new WhatsApp customer creates an unassigned lead with `source: "WHATSAPP"`.
- The first message creates a `WHATSAPP` conversation.
- Later messages reuse the open WhatsApp conversation.
- Incoming messages use `senderType: "CUSTOMER"`, `direction: "INBOUND"`, and `deliveryStatus: "DELIVERED"`.
- Incoming messages increment `unreadCount` and update `lastMessagePreview` and `lastMessageAt`.
- A closed WhatsApp conversation is not reused; the next inbound message creates a new one.

No frontend changes are required to the existing conversations workspace contract.

## Sending WhatsApp replies

Use the existing message endpoint:

```http
POST /api/conversations/:conversationId/messages
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "content": "Hello Kwame, yes we can help you book a site inspection."
}
```

- `MANUAL` conversation messages remain `INTERNAL`.
- `WHATSAPP` conversation messages are created as `PENDING`, then returned as `SENT` or `FAILED`.
- Mock mode returns a provider ID such as `mock_whatsapp_msg_<messageId>`.
- Provider failures remain visible as failed messages and can be retried.
- Closed conversations return `CONVERSATION_CLOSED`.

## Retry failed reply

```http
POST /api/conversations/:conversationId/messages/:messageId/retry
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Only failed outbound WhatsApp text messages can be retried. Other messages return `MESSAGE_NOT_RETRYABLE`.

The frontend should display delivery status for staff replies:

```text
PENDING
SENT
FAILED
```

For `FAILED`, show a retry action. The API remains the final permission check.

## Delivery statuses

Meta/mock status webhooks update existing outbound messages:

```text
PENDING -> SENT -> DELIVERED -> READ
                  or FAILED
```

Continue rendering the delivery status returned with each message. Module 4 will add real-time updates; for now, refetch or poll conversation detail.

Development-only status simulator:

```http
POST /api/dev/mock-whatsapp/status-update
Content-Type: application/json
```

```json
{
  "providerMessageId": "mock_whatsapp_msg_abc123",
  "status": "read"
}
```

Supported mock statuses are `sent`, `delivered`, `read`, and `failed`.

## End Chat

```http
POST /api/conversations/:conversationId/end
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

The endpoint returns the conversation with:

```json
{
  "status": "CLOSED",
  "closedAt": "..."
}
```

The timeline receives a system message naming the team member who ended the conversation. Calling End Chat again returns `CONVERSATION_ALREADY_CLOSED`.

## Automatic reopen

When a customer replies to a closed WhatsApp conversation, the backend reopens that same conversation:

- `status` becomes `OPEN`.
- `closedAt` becomes `null`.
- Existing assignment and message history remain.
- A reopen system event appears before the new customer message.
- No duplicate lead or conversation is created.

The frontend only needs to refetch the existing conversation/list. No separate reopen endpoint is required.

## Real-time inbox events

Connect to:

```http
GET /api/realtime/events
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Accept: text/event-stream
```

The stream is business-scoped and emits:

```text
message.created
message.status.updated
conversation.created
conversation.updated
conversation.closed
conversation.reopened
conversation.assigned
conversation.read
conversation.unread_count.updated
lead.created
lead.updated
ping
```

Event envelope:

```ts
type RealtimeEvent = {
  id: string;
  type: string;
  businessId: string;
  conversationId?: string;
  leadId?: string;
  messageId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
};
```

On connection and reconnection, refetch the conversation list/detail to establish current state. Then apply events or trigger targeted refetches. Keep polling as fallback because V1 uses an in-memory single-server event bus.

Browser `EventSource` cannot set custom authorization headers directly. Use an SSE client/fetch-stream implementation that supports headers, or a same-origin authenticated proxy. Do not place access tokens in query parameters.

Staff streams receive only events for assigned leads/conversations. Owners and managers receive all events for the selected business.

## Development simulator

Use this endpoint only during local/development testing:

```http
POST /api/dev/mock-whatsapp/inbound-message
Content-Type: application/json
```

```json
{
  "businessId": "business-id",
  "customerPhone": "+233241234567",
  "customerName": "Kwame Mensah",
  "message": "Hi, I want to book a site inspection."
}
```

Optional `providerMessageId` can be supplied to test duplicate delivery. Repeating the same ID returns the original records and does not create another message.

The simulator is unavailable in production. It does not require JWT authentication because it is a development provider simulator, not a user-facing API.

## Existing frontend endpoints

After simulating an inbound message, refresh:

```text
GET /api/leads
GET /api/leads/:id
GET /api/conversations
GET /api/conversations/stats
GET /api/conversations/:id
```

Normal frontend endpoints still require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Limit behavior

The monthly conversation limit is enforced only when an inbound WhatsApp message needs to create a new conversation. Messages for an existing open conversation continue to be stored.

The provider webhook records a `LIMIT_BLOCKED` event internally. No upgrade flow is required in this module.

## Out of scope

- Full Meta Embedded Signup UI
- AI replies
- Media messages
- WebSockets, typing indicators, and presence
- WhatsApp 24-hour session enforcement
