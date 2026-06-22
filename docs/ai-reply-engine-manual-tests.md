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
    Expected: `AI_FALLBACK_EXHAUSTED`, no auto-reply, conversation becomes `NEEDS_HUMAN_REVIEW`, human review notification, and `business.ai.reply.failed`.

17. Provider returns confidence below `AI_MIN_CONFIDENCE`.
    Expected: `BLOCKED_LOW_CONFIDENCE`, no auto-reply, human review notification.

18. Customer asks for a human.
    Expected: no auto-reply, human review notification.

19. Customer complains or asks about payment dispute.
    Expected: no auto-reply, human review notification.

20. AI reply attempts to confirm an appointment.
    Expected: blocked by safety service.

## Business Knowledge Context

21. Build AI context for a valid business conversation.
    Expected: business profile contains only safe editable fields.

22. Inspect AI formatted context.
    Expected: no OpenRouter key, WhatsApp token, webhook secret, billing data, or provider credential appears.

23. Business has active and archived services.
    Expected: active services are included and archived services are excluded.

24. Business has customer-facing and internal-only policies.
    Expected: customer-facing policies are included and internal-only policies are excluded.

25. Availability is configured.
    Expected: weekly hours and summary text are included.

26. Availability is missing.
    Expected: readiness warning says availability is not configured.

27. Lead exists for the conversation.
    Expected: basic lead name, phone, email, source, status, and assigned member id are included; private notes are excluded.

28. Conversation has more than `AI_MAX_CONTEXT_MESSAGES`.
    Expected: only the latest allowed messages are included, oldest to newest.

29. Conversation has deleted messages.
    Expected: deleted messages are excluded.

30. Message contains media without text.
    Expected: context represents it safely as an attachment/media message the AI cannot inspect.

31. Basic plan context.
    Expected: `aiReplies=true`, `teamRouting=false`, `safeAutoConfirm=false`.

32. Plus plan context.
    Expected: `aiReplies=true`, `teamRouting=true`, `safeAutoConfirm=false`.

33. Premium plan context.
    Expected: `aiReplies=true`, `teamRouting=true`, `safeAutoConfirm=true`.

34. Profile/services/availability/policies are updated.
    Expected: AI business context cache is invalidated.

35. Conversation message is created.
    Expected: AI context cache for that conversation is invalidated.

## Persistence

36. Safe AI reply creates a message with `senderType: AI`.
    Expected: `direction = OUTBOUND`, `messageType = TEXT`.

37. WhatsApp conversation with connected provider.
    Expected: AI message is sent through WhatsApp provider and status becomes `SENT` or `FAILED`.

38. WhatsApp conversation without connected provider.
    Expected: AI message is stored with `FAILED`; pipeline does not crash.

39. Manual conversation.
    Expected: AI message is stored internally and no WhatsApp call is made.

40. AI interaction log is created.
    Expected: provider, model, fallback metadata, intent, confidence, status, token fields, and latency are recorded without raw prompts.

41. AI usage is tracked.
    Expected: account usage increments AI requests, AI replies when attempted, and tokens when provider returns token usage.

## Basic AI Auto-Reply And Booking Requests

42. Basic plan safe service inquiry.
    Expected: AI sends a normal reply with status `SUCCESS_AUTO_REPLIED`.

43. Basic plan booking request with service, date, and time.
    Expected: appointment is created with `source = AI_CONVERSATION`, status `PENDING_BUSINESS_CONFIRMATION`, and `humanConfirmationRequired = true`.

44. Basic AI booking request.
    Expected: AI response tells the customer the request was sent for confirmation and never says the appointment is confirmed.

45. Plus or Premium booking request through AI.
    Expected: uses the same safe request path; no advanced AI staff routing or AI safe auto-confirm is enabled.

46. Booking intent missing service/date/time.
    Expected: no appointment is created; AI asks a clarifying question if safe.

47. Unavailable appointment slot.
    Expected: no appointment is created; AI asks for another time or the conversation moves to human review.

48. Appointment quota exceeded during AI booking.
    Expected: no appointment is created; AI interaction is logged and human review is requested if no safe customer reply is possible.

49. AI reply quota exceeded before processing.
    Expected: OpenRouter is not called, status `BLOCKED_QUOTA`, conversation becomes `NEEDS_HUMAN_REVIEW`, and owner/manager notification is created.

50. Low confidence decision.
    Expected: no reply, account usage increments blocked/human review counters, conversation becomes `NEEDS_HUMAN_REVIEW`.

51. Customer asks for human help.
    Expected: no reply, conversation becomes `NEEDS_HUMAN_REVIEW`, notification type `AI_HUMAN_REVIEW_REQUIRED`.

## Human Review And Handoff

52. AI requests human review.
    Expected: `needsHumanReview = true`, `status = NEEDS_HUMAN_REVIEW`, `aiEnabled = false`, `humanTakeover = false`.

53. Human review stores metadata.
    Expected: `humanReviewType`, `humanReviewReason`, `humanReviewCreatedAt`, and `lastAiBlockedReason` are set.

54. Human review creates system message.
    Expected: timeline contains “AI paused for human review.”

55. Duplicate human review request for same conversation.
    Expected: unresolved notification is reused; users are not spammed with duplicates.

56. Owner calls `PATCH /api/business/conversations/:conversationId/take-over`.
    Expected: `status = HUMAN_HANDLING`, `humanTakeover = true`, `aiEnabled = false`, `needsHumanReview = false`.

57. Manager calls take-over.
    Expected: succeeds for a business conversation.

58. Assigned staff calls take-over.
    Expected: succeeds for their assigned conversation.

59. Staff calls take-over on another member's conversation.
    Expected: `CONVERSATION_ACCESS_DENIED`.

60. Take-over on unassigned conversation by owner/manager.
    Expected: conversation becomes assigned to the actor membership if it was unassigned.

61. Take-over creates system message.
    Expected: timeline contains “Human takeover started.”

62. Take-over creates audit log.
    Expected: `CONVERSATION_HUMAN_TAKEOVER_STARTED` with previous/new status metadata.

63. Owner/manager calls `PATCH /api/business/conversations/:conversationId/resume-ai`.
    Expected: `status = AI_HANDLING`, `aiEnabled = true`, `humanTakeover = false`, `needsHumanReview = false`.

64. Resume AI creates system message.
    Expected: timeline contains “AI replies resumed.”

65. Resume AI creates audit log.
    Expected: `CONVERSATION_AI_RESUMED`.

66. Resume AI on a closed conversation.
    Expected: rejected; closed conversations do not resume AI.

67. Staff sends manual message without take-over.
    Expected: message is stored but `humanTakeover` is not automatically set.

68. Inbound customer message while `NEEDS_HUMAN_REVIEW`.
    Expected: message stores normally but AI auto-processing does not continue.

69. Inbound customer message while `HUMAN_HANDLING`.
    Expected: message stores normally but AI auto-processing does not continue.

## Realtime And Notifications

70. Start AI processing.
    Expected: `business.ai.reply.started` emits.

71. AI completes.
    Expected: `business.ai.reply.completed` and `message.created` emit. If fallback was used, payload includes safe fallback metadata.

72. AI creates booking request.
    Expected: `business.ai.booking_request.created`, `business.appointment.created`, `message.created`, and `business.notification.created` emit.

73. AI blocks.
    Expected: `business.ai.reply.blocked`, `business.ai.human_review.required`, and `business.notification.created` emit.

74. Take-over emits realtime.
    Expected: `business.conversation.human_takeover.started` and `business.conversation.updated`.

75. Resume AI emits realtime.
    Expected: `business.conversation.ai_resumed` and `business.conversation.updated`.

76. AI provider fails after fallback attempts.
    Expected: `business.ai.reply.failed`; inbound message remains stored.

## WhatsApp Inbound Integration

77. Store inbound WhatsApp message for conversation with `aiEnabled=true`.
    Expected: AI processing starts after storage.

78. Store inbound WhatsApp message for conversation with `aiEnabled=false`.
    Expected: no AI reply is attempted.

79. Existing WhatsApp inbound storage with AI provider error.
    Expected: lead, conversation, and message are still created/updated.

80. Search routes.
    Expected: no AI mock/simulator endpoint exists.
