# WhatsApp Delivery, End Chat, and Reopen Manual Tests

## Delivery status

Use the provider message ID from a mock outbound WhatsApp reply:

```bash
curl -X POST http://localhost:3000/api/dev/mock-whatsapp/status-update \
  -H 'Content-Type: application/json' \
  -d '{"providerMessageId":"PROVIDER_MESSAGE_ID","status":"delivered"}'
```

Repeat with `sent`, `read`, and `failed`. `read` must set `readAt`. An unknown status must leave the existing internal delivery status unchanged while preserving the raw provider status metadata.

## End Chat

```bash
curl -X POST http://localhost:3000/api/conversations/CONVERSATION_ID/end \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID'
```

Expected:

- Conversation becomes `CLOSED`.
- `closedAt` is set.
- `aiEnabled` and `humanTakeover` become `false`.
- Timeline contains the ended system message and `CONVERSATION_ENDED`.
- A second request returns `CONVERSATION_ALREADY_CLOSED`.

## Automatic reopen

Send another mock inbound message from the same customer phone after End Chat:

```bash
curl -X POST http://localhost:3000/api/dev/mock-whatsapp/inbound-message \
  -H 'Content-Type: application/json' \
  -d '{
    "businessId":"BUSINESS_ID",
    "customerPhone":"+233241234567",
    "customerName":"Kwame Mensah",
    "message":"Hello again",
    "providerMessageId":"unique-reopen-test-id"
  }'
```

Expected:

- The same conversation ID is reused.
- Conversation becomes `OPEN` and `closedAt` becomes `null`.
- Existing messages and assignment remain.
- Timeline contains the reopen system message and `CONVERSATION_REOPENED`.
- New inbound message metadata has `reopenedConversation: true`.
- Account/business conversation usage does not increment.
