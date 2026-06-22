# Frontend Sprint 7 Handoff

## Sprint Goal

Sprint 7 Module 1 adds the backend AI reply engine powered by OpenRouter. This is backend infrastructure for AI replies in existing conversations.

There is no AI playground, no mock AI mode, no dashboard simulator, no AI settings UI, and no appointment auto-booking UI in this module.

## Environment Behavior

The backend requires OpenRouter configuration when AI replies are enabled:

```env
OPENROUTER_API_KEY=
OPENROUTER_DEFAULT_MODEL=
OPENROUTER_FALLBACK_MODELS=
OPENROUTER_MAX_FALLBACK_ATTEMPTS=2
AI_REPLY_ENABLED=true
AI_MIN_CONFIDENCE=0.75
```

Do not expose `OPENROUTER_API_KEY` or raw provider request details in the frontend.

## Manual AI Trigger

Owner and manager can manually process the latest inbound customer message in a stored conversation:

```http
POST /api/business/conversations/:conversationId/ai/process-latest
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Staff cannot call this endpoint.

This endpoint does not simulate a customer message. It only processes the latest existing inbound customer message in the conversation.

Possible responses:

```json
{
  "status": "SUCCESS",
  "blocked": false,
  "message": {},
  "decision": {}
}
```

```json
{
  "status": "BLOCKED_LOW_CONFIDENCE",
  "blocked": true,
  "decision": {}
}
```

## Automatic Processing

When a WhatsApp inbound message is stored, the backend attempts AI processing safely if:

- `AI_REPLY_ENABLED=true`
- the conversation has `aiEnabled=true`
- the conversation is not closed
- the message is an inbound customer message
- the plan allows AI replies

If AI fails, the inbound WhatsApp message still remains stored. The frontend should not treat AI failure as message ingestion failure.

## AI Message Rendering

AI replies are stored as normal conversation messages:

```text
senderType: AI
direction: OUTBOUND
messageType: TEXT
deliveryStatus: PENDING | SENT | FAILED | INTERNAL
```

Render `senderType: AI` as a BizReply AI assistant message.

For WhatsApp conversations:

- AI message starts as `PENDING`
- backend sends through the existing WhatsApp provider
- final status becomes `SENT` or `FAILED`

For non-WhatsApp/manual conversations, AI messages may be stored as `INTERNAL`.

## Human Review

If AI is unsafe, low confidence, customer asks for a human, or business knowledge is insufficient:

- no AI reply is sent
- conversation may move to human review state
- a notification of type `AI_HUMAN_REVIEW_REQUIRED` is created

Notification actions:

```json
[
  { "label": "View conversation", "action": "VIEW_CONVERSATION", "variant": "default" },
  { "label": "Take over", "action": "TAKE_OVER_CONVERSATION", "variant": "secondary" }
]
```

## Realtime Events

Listen for:

```text
business.ai.reply.started
business.ai.reply.completed
business.ai.reply.blocked
business.ai.reply.failed
message.created
message.status.updated
business.notification.created
```

Use these events to refetch the active conversation and notification counts. Do not rely on realtime payloads as the only source of truth.

When fallback is used, AI realtime payloads may include:

```json
{
  "fallbackUsed": true,
  "finalModelUsed": "anthropic/claude-3.5-haiku",
  "providerRequestCount": 2
}
```

If all configured models fail, the backend emits `business.ai.reply.failed` with:

```json
{
  "errorCode": "AI_FALLBACK_EXHAUSTED",
  "fallbackExhausted": true
}
```

The original customer message remains stored.

## Error Codes

Handle:

```text
AI_PROVIDER_ERROR
AI_PROVIDER_TIMEOUT
AI_PROVIDER_RATE_LIMITED
AI_PROVIDER_UNAVAILABLE
AI_MODEL_UNAVAILABLE
AI_RESPONSE_PARSE_ERROR
AI_FALLBACK_EXHAUSTED
AI_LOW_CONFIDENCE
AI_HUMAN_REVIEW_REQUIRED
AI_DISABLED
AI_QUOTA_EXCEEDED
AI_BUSINESS_NOT_READY
AI_CONVERSATION_NOT_FOUND
AI_MESSAGE_NOT_FOUND
WHATSAPP_NOT_CONNECTED
WHATSAPP_SEND_FAILED
FORBIDDEN
BUSINESS_ACCESS_DENIED
```

## Out Of Scope

- AI settings UI
- AI simulator/playground
- Appointment auto-booking
- Human takeover workflow UI beyond existing conversation view
- AI analytics dashboard
- Fine-tuning or training UI
