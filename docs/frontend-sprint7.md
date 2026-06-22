# Frontend Sprint 7 Handoff

## Sprint Goal

Sprint 7 Modules 1-3 add the OpenRouter AI reply engine, business knowledge context, safe auto-replies, human review state, and AI-created appointment booking requests.

There is no AI settings UI, AI simulator, advanced routing, AI analytics dashboard, or Plus/Premium auto-confirm UI in this module.

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
- notification type `AI_HUMAN_REVIEW_REQUIRED` is created for owners/managers

Notification actions:

```json
[
  { "label": "View conversation", "action": "VIEW_CONVERSATION", "variant": "default" },
  { "label": "Take over", "action": "TAKE_OVER_CONVERSATION", "variant": "secondary" }
]
```

Do not treat `NEEDS_HUMAN_REVIEW` as full human takeover. Human takeover still happens only when a human explicitly takes over.

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
```

## Frontend Notes

- Show `NEEDS_HUMAN_REVIEW` as “Needs human review”.
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
