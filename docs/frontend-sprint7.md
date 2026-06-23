# Frontend Sprint 7 Handoff

## Sprint Goal

Sprint 7 Modules 1-5A.1 add the OpenRouter AI reply engine, business knowledge context, safe auto-replies, AI-created appointment booking requests, human review / handoff foundation, and account-type rules for owner-capable vs staff-only users.

There is no AI settings UI, AI simulator, advanced routing, AI analytics dashboard, image understanding UI, or Plus/Premium auto-confirm UI in this module.

## Environment Behavior

The backend controls AI with environment configuration:

```env
OPENROUTER_API_KEY=
OPENROUTER_DEFAULT_MODEL=
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_MAX_FALLBACK_ATTEMPTS=2
AI_REPLY_ENABLED=true
AI_MIN_CONFIDENCE=0.75
```

Never expose provider keys, raw prompts, provider headers, or internal provider errors in the frontend.

## Manual AI Trigger

Owner and manager can process the latest inbound customer message:

```http
POST /api/business/conversations/:conversationId/ai/process-latest
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Staff cannot call this endpoint.

Possible response statuses include:

```text
SUCCESS_AUTO_REPLIED
SUCCESS_BOOKING_REQUEST_CREATED
BLOCKED_LOW_CONFIDENCE
BLOCKED_POLICY
BLOCKED_QUOTA
BLOCKED_MISSING_CONTEXT
BLOCKED_UNAVAILABLE_SLOT
AI_FALLBACK_EXHAUSTED
WHATSAPP_SEND_FAILED
PROVIDER_ERROR
```

Blocked responses return `blocked: true`. Successful replies and booking-request acknowledgements return `blocked: false` with a stored AI message.

## Account Type Rules

Auth user objects now include:

```ts
type UserAccountType = "OWNER_CAPABLE" | "STAFF_ONLY";

type AuthUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  status: "ACTIVE" | "DISABLED";
  accountType: UserAccountType;
  canCreateBusiness: boolean;
  createdAt: string;
};
```

Normal registration creates:

```text
accountType: OWNER_CAPABLE
canCreateBusiness: true
```

Invite-created staff accounts create:

```text
accountType: STAFF_ONLY
canCreateBusiness: false
```

Frontend should hide or disable “Create business” for:

```text
accountType = STAFF_ONLY
canCreateBusiness = false
```

The backend remains the source of truth. If a staff-only user calls business creation anyway, it returns:

```json
{
  "error": {
    "code": "STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS",
    "message": "This account was created as a staff account. Staff accounts cannot create businesses."
  }
}
```

When inviting staff, owner/manager should handle:

```text
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
```

`INVITED_EMAIL_ALREADY_BUSINESS_OWNER` means the email belongs to a user with an active owner membership. Show a clear message asking for a staff email instead.

## Team Invite Acceptance

Validate invite link before showing signup/login UI:

```http
GET /api/invites/:token
```

Valid response:

```json
{
  "valid": true,
  "inviteId": "invite-id",
  "business": {
    "id": "business-id",
    "name": "Enoch Properties"
  },
  "role": "STAFF",
  "email": "staff@example.com",
  "status": "PENDING",
  "expiresAt": "2026-06-30T10:00:00.000Z"
}
```

Invalid response:

```json
{
  "valid": false,
  "code": "INVITE_INVALID_OR_EXPIRED",
  "message": "This invite link is invalid or has expired."
}
```

Existing logged-in user accepts invite:

```http
POST /api/invites/:token/accept
Authorization: Bearer <accessToken>
```

No request body is required.

New invitee signs up from invite:

```http
POST /api/invites/:token/signup
Content-Type: application/json
```

```json
{
  "name": "Kwame Mensah",
  "password": "SecurePass123!"
}
```

Do not ask for email on invite signup. The backend uses the invite email.

Successful accept/signup response includes:

```json
{
  "accepted": true,
  "business": {
    "id": "business-id",
    "name": "Enoch Properties"
  },
  "membership": {
    "id": "business-member-id",
    "role": "STAFF",
    "status": "ACTIVE"
  },
  "activeBusinessId": "business-id",
  "activeMembershipId": "business-member-id",
  "role": "STAFF"
}
```

Signup-from-invite also returns `accessToken` and `refreshToken`, so the frontend can enter the invited business immediately.

Invite acceptance errors to handle:

```text
INVITE_NOT_FOUND
INVITE_INVALID_OR_EXPIRED
INVITE_ALREADY_ACCEPTED
INVITE_CANCELLED
INVITE_EMAIL_MISMATCH
INVALID_INVITE_ROLE
USER_ALREADY_EXISTS
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE
BUSINESS_NOT_FOUND
```

`INVITE_EMAIL_MISMATCH` means the logged-in user is not the invited email. Ask them to log in with the invited email.

`USER_ALREADY_EXISTS` on signup means the invited email already has an account; show login + accept flow instead.

## Automatic Processing

When an inbound WhatsApp customer message is stored, the backend safely attempts AI processing if:

- global AI replies are enabled
- business AI replies and auto-reply are enabled
- plan AI quota is available
- conversation has `aiEnabled=true`
- conversation is not `CLOSED`
- conversation is not in human takeover or human-review state
- message is `senderType: CUSTOMER` and `direction: INBOUND`

AI failure never rolls back the original inbound WhatsApp message.

## AI Messages

AI replies are normal conversation messages:

```text
senderType: AI
direction: OUTBOUND
messageType: TEXT
deliveryStatus: PENDING | SENT | FAILED | INTERNAL
```

Render `senderType: AI` as the BizReply AI assistant. For WhatsApp conversations, the message is created as pending, then becomes `SENT` or `FAILED`. If WhatsApp is not connected, the AI message is stored as `FAILED`.

## Human Review

When AI is low-confidence, unsafe, over quota, missing required context, or the customer asks for a human:

- no AI reply is sent
- conversation moves to `status: NEEDS_HUMAN_REVIEW`
- `needsHumanReview: true`
- `humanReviewReason` is set
- `humanReviewType` is set
- `aiEnabled: false`
- `humanTakeover: false`
- notification type `AI_HUMAN_REVIEW_REQUIRED` is created for owners/managers
- on Plus/Premium, the assigned staff member is also notified when the conversation has an assignee

Notification actions:

```json
[
  { "label": "View conversation", "action": "VIEW_CONVERSATION", "variant": "default" },
  { "label": "Take over", "action": "TAKE_OVER_CONVERSATION", "variant": "secondary" },
  { "label": "Dismiss", "action": "DISMISS", "variant": "secondary" }
]
```

Do not treat `NEEDS_HUMAN_REVIEW` as full human takeover. Human takeover still happens only when a human explicitly takes over.

Human review types:

```text
LOW_CONFIDENCE
CUSTOMER_REQUESTED_HUMAN
COMPLAINT
PAYMENT_OR_REFUND
POLICY_UNCERTAINTY
BOOKING_UNCLEAR
MISSING_BUSINESS_CONTEXT
MEDIA_OR_IMAGE_UNSUPPORTED
AI_PROVIDER_FAILED
QUOTA_EXCEEDED
SAFETY_BLOCKED
OTHER
```

## Human Handoff Endpoints

Take over a conversation:

```http
PATCH /api/business/conversations/:conversationId/take-over
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "Customer asked for a human"
}
```

`reason` is optional.

Response conversation state:

```text
status: HUMAN_HANDLING
humanTakeover: true
aiEnabled: false
needsHumanReview: false
humanReviewResolvedAt: timestamp
humanReviewResolvedByMembershipId: current membership id
```

Resume AI:

```http
PATCH /api/business/conversations/:conversationId/resume-ai
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

```json
{
  "reason": "Issue reviewed"
}
```

`reason` is optional.

Response conversation state:

```text
status: AI_HANDLING
humanTakeover: false
aiEnabled: true
needsHumanReview: false
humanReviewResolvedAt: timestamp
humanReviewResolvedByMembershipId: current membership id
```

Resume AI does not process old messages immediately. Future inbound customer messages can trigger AI again.

Access:

- owner/manager can take over or resume accessible business conversations
- assigned staff can take over or resume their assigned conversations
- staff cannot take over unassigned or other staff conversations

## Booking Requests

When AI detects booking intent and has service, date, and time:

- backend validates the service
- backend checks availability through the appointment service
- backend creates an appointment request with `source: AI_CONVERSATION`
- Basic appointments are always `PENDING_BUSINESS_CONFIRMATION`
- AI replies: “request sent for confirmation”
- AI never says the appointment is confirmed

For this module, Plus and Premium use the same safe pending/request behavior. Advanced staff routing and safe auto-confirm are not enabled from AI yet.

If booking details are missing, the AI asks a clarifying question instead of creating an appointment. If the slot or setup is not usable and no safe reply is available, the conversation goes to human review.

## Realtime Events

Listen for:

```text
business.ai.reply.started
business.ai.reply.completed
business.ai.reply.blocked
business.ai.reply.failed
business.ai.booking_request.created
business.ai.human_review.required
business.conversation.human_takeover.started
business.conversation.ai_resumed
business.conversation.updated
business.member.joined
business.invite.accepted
message.created
message.status.updated
business.appointment.created
business.notification.created
```

Use realtime events to refetch conversation detail, conversation list, appointment/calendar data, and notification counts. Database-backed API responses remain the source of truth.

Booking request event payload includes:

```json
{
  "conversationId": "...",
  "appointmentId": "...",
  "appointmentStatus": "PENDING_BUSINESS_CONFIRMATION",
  "sourceMessageId": "..."
}
```

## Business Knowledge Context

The frontend does not send business knowledge to AI. The backend builds context from:

- business profile
- active non-archived services and pricing
- weekly availability
- active customer-facing policies only
- lead/customer context
- recent conversation messages
- plan capability flags
- AI readiness warnings

Internal-only policies, secrets, provider tokens, billing data, deleted messages, and cross-business records are excluded.

## Error Codes

Handle these cleanly:

```text
AI_DISABLED
AI_AUTO_REPLY_DISABLED
AI_QUOTA_EXCEEDED
AI_LOW_CONFIDENCE
AI_HUMAN_REVIEW_REQUIRED
AI_UNSAFE_TO_REPLY
AI_MISSING_CONTEXT
AI_REPLY_VALIDATION_FAILED
AI_CONVERSATION_NOT_ELIGIBLE
AI_PROVIDER_ERROR
AI_PROVIDER_TIMEOUT
AI_PROVIDER_RATE_LIMITED
AI_PROVIDER_UNAVAILABLE
AI_MODEL_UNAVAILABLE
AI_RESPONSE_PARSE_ERROR
AI_FALLBACK_EXHAUSTED
AI_BOOKING_MISSING_FIELDS
AI_BOOKING_SERVICE_NOT_FOUND
AI_BOOKING_SERVICE_NOT_BOOKABLE
AI_BOOKING_SLOT_UNAVAILABLE
AI_BOOKING_BUSINESS_NOT_READY
AI_BOOKING_CREATE_FAILED
WHATSAPP_NOT_CONNECTED
WHATSAPP_SEND_FAILED
FORBIDDEN
BUSINESS_ACCESS_DENIED
CONVERSATION_ACCESS_DENIED
CONVERSATION_ALREADY_HUMAN_HANDLING
CONVERSATION_NOT_IN_HUMAN_REVIEW
AI_ALREADY_ENABLED
AI_ALREADY_DISABLED
HUMAN_TAKEOVER_FORBIDDEN
HUMAN_REVIEW_NOT_FOUND
STAFF_ACCOUNT_CANNOT_CREATE_BUSINESS
INVITED_EMAIL_ALREADY_BUSINESS_OWNER
USER_ALREADY_BUSINESS_MEMBER
INVALID_ACCOUNT_TYPE
INVITE_NOT_FOUND
INVITE_INVALID_OR_EXPIRED
INVITE_ALREADY_ACCEPTED
INVITE_CANCELLED
INVITE_EMAIL_MISMATCH
INVALID_INVITE_ROLE
USER_ALREADY_EXISTS
ACCOUNT_NOT_ALLOWED_FOR_STAFF_INVITE
```

## Frontend Notes

- Show `NEEDS_HUMAN_REVIEW` as “Needs human review”.
- Show `HUMAN_HANDLING` as “Human handling” or “Human takeover”.
- Use the take-over endpoint for the notification action `TAKE_OVER_CONVERSATION`.
- Use the resume endpoint when a user chooses to turn AI back on.
- Use `user.accountType` and `user.canCreateBusiness` to conditionally show create-business UI.
- Use `/api/invites/:token` before rendering invite signup/login screens.
- After invite acceptance, set active business from `activeBusinessId` and `activeMembershipId`.
- Show failed AI messages with the existing failed-message UI.
- Refetch appointments when `business.ai.booking_request.created` or `business.appointment.created` arrives.
- Do not add an AI simulator button.
- Do not add advanced AI routing or auto-confirm controls yet.

## Out Of Scope

- AI settings UI
- AI playground/simulator
- Plus team routing
- Premium safe auto-confirm from AI
- AI-generated reschedule/cancel messages
- AI analytics dashboard
- Embeddings/vector knowledge base
