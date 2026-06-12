# WhatsApp Inbound Manual Tests

Set `WHATSAPP_PROVIDER_MODE=mock`, run the migration and seed, then start the API.

Use a valid existing business ID:

```bash
curl -X POST http://localhost:8000/api/dev/mock-whatsapp/inbound-message \
  -H 'Content-Type: application/json' \
  -d '{
    "businessId": "BUSINESS_ID",
    "customerPhone": "+233241234567",
    "customerName": "Kwame Mensah",
    "message": "Hi, I want to book a site inspection.",
    "providerMessageId": "mock-message-001"
  }'
```

## Cases

1. First inbound message creates a `WHATSAPP` lead, conversation, and customer message.
2. Created lead has `assignedStaffId: null`.
3. Second message with another provider ID reuses the lead and open conversation.
4. Repeating `mock-message-001` returns `duplicate: true` and creates no message.
5. Conversation unread count and last-message fields update after each new message.
6. Closing the conversation causes the next inbound message to create a new conversation.
7. Webhook event logs become `PROCESSED` or `DUPLICATE`.
8. Set current account conversation usage to its plan limit; a new customer returns `PLAN_LIMIT_REACHED` and logs `LIMIT_BLOCKED`.
9. At the limit, another message for an existing open conversation is still stored.
10. Existing manual lead creation still defaults assignment to the creator; WhatsApp creation does not.
11. With `NODE_ENV=production`, the mock route returns `NOT_FOUND`.
12. Set `WHATSAPP_PROVIDER_MODE=live` without Meta credentials; startup environment validation fails.

## Webhook verification

Mock mode fallback token:

```bash
curl 'http://localhost:8000/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=bizreplyai-mock-verify-token&hub.challenge=12345'
```

Expected response body:

```text
12345
```
