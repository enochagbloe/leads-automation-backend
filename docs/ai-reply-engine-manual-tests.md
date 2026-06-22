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

4. Configure `OPENROUTER_FALLBACK_MODELS` with two comma-separated models and `OPENROUTER_MAX_FALLBACK_ATTEMPTS=2`.
   Expected: provider attempts the primary model first and can attempt up to two fallback models.

## Manual Trigger

5. Owner calls `POST /api/business/conversations/:conversationId/ai/process-latest`.
   Expected: latest inbound customer message is processed.

6. Manager calls the same endpoint.
   Expected: latest inbound customer message is processed.

7. Staff calls the same endpoint.
   Expected: `FORBIDDEN`.

8. Trigger AI for another business's conversation.
   Expected: `AI_CONVERSATION_NOT_FOUND` or `BUSINESS_ACCESS_DENIED`.

9. Trigger AI on a closed conversation.
   Expected: processing is rejected.

10. Trigger AI on a conversation with `aiEnabled=false`.
   Expected: `AI_DISABLED`.

11. Trigger AI where latest message is not from a customer.
    Expected: `AI_MESSAGE_NOT_FOUND`.

## Decision Safety

12. Provider returns valid structured decision with safe reply and high confidence.
    Expected: AI outbound message is stored.

13. Primary provider model returns invalid JSON while fallback model returns valid JSON.
    Expected: fallback model is used and AI processing continues.

14. Primary provider model times out.
    Expected: fallback model is attempted.

15. Primary provider model is rate limited or unavailable.
    Expected: fallback model is attempted.

16. All configured models fail or return malformed output.
    Expected: `AI_FALLBACK_EXHAUSTED`, no auto-reply, human review notification, and `business.ai.reply.failed`.

17. Provider returns confidence below `AI_MIN_CONFIDENCE`.
    Expected: `BLOCKED_LOW_CONFIDENCE`, no auto-reply, human review notification.

18. Customer asks for a human.
    Expected: no auto-reply, human review notification.

19. Customer complains or asks about payment dispute.
    Expected: no auto-reply, human review notification.

20. AI reply attempts to confirm an appointment.
    Expected: blocked by safety service.

## Persistence

21. Safe AI reply creates a message with `senderType: AI`.
    Expected: `direction = OUTBOUND`, `messageType = TEXT`.

22. WhatsApp conversation with connected provider.
    Expected: AI message is sent through WhatsApp provider and status becomes `SENT` or `FAILED`.

23. WhatsApp conversation without connected provider.
    Expected: AI message is stored with `FAILED`; pipeline does not crash.

24. Manual conversation.
    Expected: AI message is stored internally and no WhatsApp call is made.

25. AI interaction log is created.
    Expected: provider, model, fallback metadata, intent, confidence, status, token fields, and latency are recorded without raw prompts.

26. AI usage is tracked.
    Expected: account usage increments AI requests, AI replies when attempted, and tokens when provider returns token usage.

## Realtime And Notifications

27. Start AI processing.
    Expected: `business.ai.reply.started` emits.

28. AI completes.
    Expected: `business.ai.reply.completed` and `message.created` emit. If fallback was used, payload includes safe fallback metadata.

29. AI blocks.
    Expected: `business.ai.reply.blocked` and `business.notification.created` emit.

30. AI provider fails after fallback attempts.
    Expected: `business.ai.reply.failed`; inbound message remains stored.

## WhatsApp Inbound Integration

31. Store inbound WhatsApp message for conversation with `aiEnabled=true`.
    Expected: AI processing starts after storage.

32. Store inbound WhatsApp message for conversation with `aiEnabled=false`.
    Expected: no AI reply is attempted.

33. Existing WhatsApp inbound storage with AI provider error.
    Expected: lead, conversation, and message are still created/updated.

34. Search routes.
    Expected: no AI mock/simulator endpoint exists.
