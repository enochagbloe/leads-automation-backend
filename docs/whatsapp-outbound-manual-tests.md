# WhatsApp Outbound Manual Tests

Set `WHATSAPP_PROVIDER_MODE=mock`, restart the API, and use an authenticated user with access to an existing WhatsApp conversation.

## Send reply

```bash
curl -X POST http://localhost:3000/api/conversations/CONVERSATION_ID/messages \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID' \
  -H 'Content-Type: application/json' \
  -d '{"content":"Hello, yes we can help."}'
```

Expected:

- Message has `senderType: STAFF`, `direction: OUTBOUND`, and `messageType: TEXT`.
- Final `deliveryStatus` is `SENT`.
- `provider` is `MOCK_WHATSAPP`.
- `providerMessageId` begins with `mock_whatsapp_msg_`.
- Conversation preview and last-message time update.

## Simulate failure and retry

1. Set `MOCK_WHATSAPP_FORCE_FAILURE=true` and restart the API.
2. Send a WhatsApp reply and confirm the saved message has `deliveryStatus: FAILED`.
3. Set `MOCK_WHATSAPP_FORCE_FAILURE=false` and restart the API.
4. Retry:

```bash
curl -X POST http://localhost:3000/api/conversations/CONVERSATION_ID/messages/MESSAGE_ID/retry \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID'
```

Expected final status: `SENT`.

## Cases

1. Manual conversation reply remains `INTERNAL`.
2. WhatsApp reply settles from `PENDING` to `SENT`.
3. Mock provider message ID is stored.
4. Mock provider failure leaves a `FAILED` message.
5. Failed WhatsApp text message can be retried.
6. Sent or internal messages return `MESSAGE_NOT_RETRYABLE`.
7. Empty content returns `MESSAGE_CONTENT_REQUIRED`.
8. Closed conversation returns `CONVERSATION_CLOSED`.
9. Staff can send/retry only in assigned conversations.
10. Owner and manager can send/retry in any conversation in the selected business.
11. Live mode without an active integration returns `WHATSAPP_NOT_CONNECTED`.
12. Message activity, audit logs, conversation caches, and lead-detail cache update after send/retry.
