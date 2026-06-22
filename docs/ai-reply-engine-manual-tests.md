# AI Reply Engine Manual Tests

Use an authenticated owner or manager unless the test says staff. Always include:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Configuration

1. Start backend with `AI_REPLY_ENABLED=false`.
   Expected: manual AI trigger returns `AI_DISABLED`.

2. Start backend with `AI_REPLY_ENABLED=true` and missing OpenRouter config.
   Expected: environment validation fails on startup.

3. Start backend with `AI_REPLY_ENABLED=true`, `OPENROUTER_API_KEY`, and `OPENROUTER_DEFAULT_MODEL`.
   Expected: backend starts and AI trigger can call the provider abstraction.

## Manual Trigger

4. Owner calls `POST /api/business/conversations/:conversationId/ai/process-latest`.
   Expected: latest inbound customer message is processed.

5. Manager calls the same endpoint.
   Expected: latest inbound customer message is processed.

6. Staff calls the same endpoint.
   Expected: `FORBIDDEN`.

7. Trigger AI for another business's conversation.
   Expected: `AI_CONVERSATION_NOT_FOUND` or `BUSINESS_ACCESS_DENIED`.

8. Trigger AI on a closed conversation.
   Expected: processing is rejected.

9. Trigger AI on a conversation with `aiEnabled=false`.
   Expected: `AI_DISABLED`.

10. Trigger AI where latest message is not from a customer.
    Expected: `AI_MESSAGE_NOT_FOUND`.

## Decision Safety

11. Provider returns valid structured decision with safe reply and high confidence.
    Expected: AI outbound message is stored.

12. Provider returns invalid JSON.
    Expected: interaction log records parse-safe failure and no auto-reply is sent.

13. Provider returns confidence below `AI_MIN_CONFIDENCE`.
    Expected: `BLOCKED_LOW_CONFIDENCE`, no auto-reply, human review notification.

14. Customer asks for a human.
    Expected: no auto-reply, human review notification.

15. Customer complains or asks about payment dispute.
    Expected: no auto-reply, human review notification.

16. AI reply attempts to confirm an appointment.
    Expected: blocked by safety service.

## Persistence

17. Safe AI reply creates a message with `senderType: AI`.
    Expected: `direction = OUTBOUND`, `messageType = TEXT`.

18. WhatsApp conversation with connected provider.
    Expected: AI message is sent through WhatsApp provider and status becomes `SENT` or `FAILED`.

19. WhatsApp conversation without connected provider.
    Expected: AI message is stored with `FAILED`; pipeline does not crash.

20. Manual conversation.
    Expected: AI message is stored internally and no WhatsApp call is made.

21. AI interaction log is created.
    Expected: provider, model, intent, confidence, status, token fields, and latency are recorded without raw prompts.

22. AI usage is tracked.
    Expected: account usage increments AI requests, AI replies when attempted, and tokens when provider returns token usage.

## Realtime And Notifications

23. Start AI processing.
    Expected: `business.ai.reply.started` emits.

24. AI completes.
    Expected: `business.ai.reply.completed` and `message.created` emit.

25. AI blocks.
    Expected: `business.ai.reply.blocked` and `business.notification.created` emit.

26. AI provider fails or times out.
    Expected: `business.ai.reply.failed`; inbound message remains stored.

## WhatsApp Inbound Integration

27. Store inbound WhatsApp message for conversation with `aiEnabled=true`.
    Expected: AI processing starts after storage.

28. Store inbound WhatsApp message for conversation with `aiEnabled=false`.
    Expected: no AI reply is attempted.

29. Existing WhatsApp inbound storage with AI provider error.
    Expected: lead, conversation, and message are still created/updated.

30. Search routes.
    Expected: no AI mock/simulator endpoint exists.
