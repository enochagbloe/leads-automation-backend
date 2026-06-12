# Frontend Sprint 4 Handoff

## Sprint goal

Sprint 4 Modules 1-3 add WhatsApp inbound processing, staff outbound text replies, delivery statuses, End Chat, and automatic reopen. There is no Meta connection UI, AI reply, media, or real-time socket support yet.

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

- Meta connection/settings UI
- AI replies
- Media messages
- Real-time sockets
- WhatsApp 24-hour session enforcement
