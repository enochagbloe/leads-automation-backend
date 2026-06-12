# Frontend Sprint 4 Handoff

## Sprint goal

Sprint 4 Module 1 adds backend-only WhatsApp inbound processing. There is no Meta connection UI, outbound reply, AI reply, or media UI yet.

## What changes in the inbox

Mock or live inbound text messages now appear through the existing lead and conversation APIs:

- A new WhatsApp customer creates an unassigned lead with `source: "WHATSAPP"`.
- The first message creates a `WHATSAPP` conversation.
- Later messages reuse the open WhatsApp conversation.
- Incoming messages use `senderType: "CUSTOMER"`, `direction: "INBOUND"`, and `deliveryStatus: "DELIVERED"`.
- Incoming messages increment `unreadCount` and update `lastMessagePreview` and `lastMessageAt`.
- A closed WhatsApp conversation is not reused; the next inbound message creates a new one.

No frontend changes are required to the existing conversations workspace contract.

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
- Sending WhatsApp replies
- AI replies
- Media messages
- Real-time sockets
- WhatsApp session/end-chat behavior
