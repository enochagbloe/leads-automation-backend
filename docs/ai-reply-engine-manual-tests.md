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

## Staff Multi-Business Access

- Staff-only user logs in after accepting an invite.
    Expected: login response includes `accountType = STAFF_ONLY`, `canCreateBusiness = false`, `memberships`, and an active business context.

- Staff-only user calls `GET /api/businesses` without `X-Business-Id`.
    Expected: response returns `{ memberships: [...] }` with membership IDs, business IDs, roles, statuses, and permission flags.

- User belongs to two businesses and switches `X-Business-Id`.
    Expected: `/api/auth/me` and business-scoped endpoints return data only for the selected business.

- Staff member calls lead/conversation/appointment list for Business A.
    Expected: only records assigned to that staff membership in Business A are returned.

- Same staff member calls the same endpoints for Business B.
    Expected: only records assigned to that staff membership in Business B are returned.

- Staff member tries to access Business B using Business A records or membership IDs.
    Expected: `BUSINESS_ACCESS_DENIED`, not cross-business data.

- User selects a business where the membership is `INVITED`.
    Expected: business-scoped request returns `MEMBERSHIP_INVITE_NOT_ACCEPTED`.

- User selects a business where the membership is `SUSPENDED_BY_PLAN`.
    Expected: business-scoped request returns `MEMBERSHIP_SUSPENDED_BY_PLAN`.

- User selects a business where the membership is `DISABLED`.
    Expected: business-scoped request returns `MEMBERSHIP_DISABLED`.

- User selects a business where the membership is `REMOVED` or no membership exists.
    Expected: business-scoped request returns `MEMBERSHIP_REMOVED` or `BUSINESS_MEMBERSHIP_NOT_FOUND`.

- Audit a lead/conversation/appointment/notification action performed by a staff member.
    Expected: `AuditLog.actorMembershipId` contains the active `BusinessMember.id`.

## Staff Access Lifecycle

- Owner disables a staff member.
    Expected: membership status becomes `DISABLED`, `disabledAt` and `disabledByMembershipId` are set.

- Manager tries to disable a staff member.
    Expected: `FORBIDDEN` in V1 because team lifecycle management is owner-only.

- Staff tries to disable/remove/restore a member.
    Expected: `FORBIDDEN`.

- Owner tries to disable or remove a business owner.
    Expected: `CANNOT_DISABLE_BUSINESS_OWNER` or `CANNOT_REMOVE_BUSINESS_OWNER`.

- Owner disables a staff member with assigned leads.
    Expected: active assigned leads become unassigned and lead activity records explain the change.

- Owner removes a staff member with open assigned conversations.
    Expected: conversations become unassigned; human-handling conversations move to `NEEDS_HUMAN_REVIEW`.

- Owner removes a staff member with future confirmed appointments.
    Expected: future appointments become unassigned and confirmed appointments move to `NEEDS_HUMAN_CONFIRMATION`.

- Completed, cancelled, no-show, and missed appointments assigned to removed staff.
    Expected: appointment history is not corrupted.

- Unresolved notifications for disabled or removed staff.
    Expected: notifications are dismissed and no longer actionable for that staff member.

- Disabled staff selects the business.
    Expected: business-scoped API returns `MEMBERSHIP_DISABLED` and does not log the user out.

- Removed staff selects the business.
    Expected: business-scoped API returns `MEMBERSHIP_REMOVED` and does not log the user out.

- Owner restores a disabled staff member within plan limit.
    Expected: membership status becomes `ACTIVE`, disabled/suspended fields are cleared, and audit log is written.

- Owner restores a disabled staff member while active staff count is already at the plan limit.
    Expected: `STAFF_LIMIT_EXCEEDED`.

- Plan downgrade suspension helper suspends excess non-owner members.
    Expected: excess manager/staff memberships become `SUSPENDED_BY_PLAN`; owners remain active.

- Suspended staff selects the business.
    Expected: `MEMBERSHIP_SUSPENDED_BY_PLAN` with the contact-organization message.

- AI staff eligibility helper checks inactive staff.
    Expected: `false` for `INVITED`, `SUSPENDED_BY_PLAN`, `DISABLED`, `REMOVED`, or cross-business memberships.

- Audit lifecycle actions.
    Expected: audit logs contain `actorMembershipId`, `targetMembershipId`, previous/new statuses, reason, and affected record counts.

- Realtime lifecycle events.
    Expected: `business.member.disabled`, `business.member.restored`, `business.member.removed`, `business.member.suspended_by_plan`, `business.member.access_changed`, and `business.team.updated` emit.

## Operational Staff Queues And Claims

- Staff lists leads with unassigned and self-assigned records.
    Expected: leads assigned to other staff are not returned.

- Staff claims an unassigned lead.
    Expected: `assignedStaffId` becomes actor membership id, lead activity is created, audit action `LEAD_CLAIMED_BY_STAFF` is recorded.

- Staff tries to claim a lead assigned to another member.
    Expected: `WORK_ALREADY_ASSIGNED`.

- Staff lists conversations with unassigned and self-assigned records.
    Expected: conversations assigned to other staff are not returned.

- Staff claims an unassigned conversation.
    Expected: conversation is assigned to actor membership id, system message is created, status moves to `HUMAN_HANDLING`.

- Staff tries to claim a conversation assigned to another member.
    Expected: `WORK_ALREADY_ASSIGNED`.

- Staff lists appointments with unassigned and self-assigned records.
    Expected: appointments assigned to other staff are not returned.

- Staff claims an unassigned appointment without schedule conflict.
    Expected: appointment is assigned to actor membership id and appointment activity is created.

- Staff claims an unassigned appointment with a conflicting appointment at the same time.
    Expected: `STAFF_SCHEDULE_CONFLICT`.

- Staff tries to claim cancelled/completed/no-show/missed appointment.
    Expected: `CANNOT_CLAIM_CANCELLED_WORK` or `CANNOT_CLAIM_COMPLETED_WORK`.

- Staff tries to assign another member's work to themselves using assign endpoint.
    Expected: `WORK_ALREADY_ASSIGNED` or `CANNOT_REASSIGN_WITHOUT_PERMISSION`.

- Owner/manager reassigns a lead/conversation/appointment to active member.
    Expected: succeeds only when target membership belongs to same business and is active.

- Owner/manager assigns work to disabled/removed/suspended/invited member.
    Expected: `INVALID_ASSIGNMENT_TARGET`.

- Owner updates staff operational profile.
    Expected: position title, specialties, service tags, AI handoff eligibility, and priority are saved.

- Staff tries to update their own operational profile.
    Expected: `FORBIDDEN`.

- AI handoff eligibility helper for active eligible staff.
    Expected: true only for active manager/staff with `isAiHandoffEligible = true`.

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

## Account Type And Business Creation Policy

81. Normal registered user profile.
    Expected: `user.accountType = OWNER_CAPABLE` and `user.canCreateBusiness = true`.

82. Existing owner-capable user creates an additional business within plan limit.
    Expected: business creation succeeds.

83. Staff-only user calls `POST /api/businesses`.
    Expected: `STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS`; user remains logged in.

84. Unknown email is invited as staff.
    Expected: invitation is created.

85. Invited unknown email accepts invitation and creates a new account.
    Expected: user is created with `accountType = STAFF_ONLY` and `canCreateBusiness = false`.

86. Existing staff-only user is invited to a second business.
    Expected: invitation is allowed.

87. Existing active business owner email is invited as staff.
    Expected: `INVITED_EMAIL_ALREADY_BUSINESS_OWNER`.

88. Existing member of the same business is invited again.
    Expected: `USER_ALREADY_BUSINESS_MEMBER`.

89. Pending legacy invite for owner email is accepted.
    Expected: accept flow blocks with `INVITED_EMAIL_ALREADY_BUSINESS_OWNER`.

90. Business creation blocked for staff account.
    Expected: audit log `BUSINESS_CREATION_BLOCKED_FOR_STAFF_ACCOUNT`.

91. Owner email staff invite blocked.
    Expected: audit log `STAFF_INVITE_BLOCKED_OWNER_EMAIL`.

## Team Invite Acceptance Flow

92. Public invite validation with a pending valid token.
    Expected: `GET /api/invites/:token` returns safe business name, role, email, status, and expiry.

93. Public invite validation with invalid token.
    Expected: `{ valid: false, code: "INVITE_INVALID_OR_EXPIRED" }`.

94. Expired invite acceptance.
    Expected: `INVITE_INVALID_OR_EXPIRED`.

95. Revoked invite acceptance.
    Expected: `INVITE_CANCELLED`.

96. Already accepted invite acceptance.
    Expected: `INVITE_ALREADY_ACCEPTED`.

97. Existing staff-only logged-in user accepts invite.
    Expected: active `BusinessMember` is created or activated under invited business.

98. Logged-in user with different email accepts invite.
    Expected: `INVITE_EMAIL_MISMATCH`.

99. Existing owner email accepts staff invite.
    Expected: `INVITED_EMAIL_ALREADY_BUSINESS_OWNER`.

100. New invitee signs up from invite.
    Expected: new user is `STAFF_ONLY`, `canCreateBusiness = false`, email verified, active membership created.

101. Signup from invite where user already exists.
    Expected: `USER_ALREADY_EXISTS`.

102. Invite role is `BUSINESS_OWNER`.
    Expected: `INVALID_INVITE_ROLE`.

103. Existing removed member is re-invited and accepts.
    Expected: membership is reactivated, no duplicate `BusinessMember`.

104. Successful acceptance marks invite accepted.
    Expected: `status = ACCEPTED`, `acceptedAt` set, `acceptedByUserId` set.

105. Successful acceptance emits realtime.
    Expected: `business.member.joined` and `business.invite.accepted`.

106. Successful acceptance creates audit logs.
    Expected: `STAFF_INVITE_ACCEPTED`; signup path also logs `STAFF_ACCOUNT_CREATED_FROM_INVITE`.

107. Staff account after invite acceptance calls business creation.
    Expected: `STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS`.
