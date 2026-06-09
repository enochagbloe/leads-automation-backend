# Frontend Sprint 3 Module 2 Handoff

## Goal

Build the business-scoped inbox UI using stored conversations and messages. WhatsApp delivery, AI replies, sockets, and payments are not active yet.

For this MVP, `Conversation` is the ticket/workspace container, `Message` is the timeline item, and `Lead` is the customer profile. Do not introduce a separate Ticket concept in the frontend.

All endpoints require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/conversations` | Create a manual conversation |
| GET | `/conversations` | Paginated conversation inbox |
| GET | `/conversations/stats` | Status and unread summary |
| GET | `/conversations/:id` | Conversation with bounded message history |
| POST | `/conversations/:id/messages` | Store a staff message |
| PATCH | `/conversations/:id` | Update subject, priority, or pinned state |
| PATCH | `/conversations/:id/assign` | Owner/manager assignment |
| PATCH | `/conversations/:id/status` | Change conversation status |
| PATCH | `/conversations/:id/read` | Clear unread messages |
| DELETE | `/conversations/:id` | Owner/manager soft delete |

## Enums

```ts
type ConversationChannel = "MANUAL" | "WHATSAPP" | "OTHER" | "INSTAGRAM" | "FACEBOOK" | "WEBSITE_CHAT" | "EMAIL";
type ConversationStatus = "OPEN" | "AI_HANDLING" | "HUMAN_HANDLING" | "CLOSED";
type ConversationPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
type MessageSenderType = "CUSTOMER" | "STAFF" | "AI" | "SYSTEM";
type MessageType = "TEXT" | "SYSTEM" | "IMAGE" | "DOCUMENT" | "AUDIO" | "VIDEO" | "LOCATION";
type MessageDirection = "INBOUND" | "OUTBOUND" | "INTERNAL";
type MessageDeliveryStatus = "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "INTERNAL";
```

User-facing message creation only accepts a `STAFF` `TEXT` message. AI, system, and customer messages are reserved for backend integrations.

Conversation workspace fields include `displayId` such as `CONV-001024`, `subject`, `priority`, and `pinned`. Use `displayId` as the visible reference instead of the raw database ID.

## List and detail

List query:

```text
page, limit, search, status, channel, priority, pinned, assignedStaffId, leadId,
dateFrom, dateTo, sortBy, sortOrder
```

Detail query:

```text
messageLimit=50
beforeMessageId=<oldest-current-message-id>
```

Detail messages are returned oldest to newest. Use `messagePagination.nextBeforeMessageId` to request older messages.

Detail returns:

```ts
{
  conversation: Conversation;
  lead: Lead;
  assignedStaff: BusinessMember | null;
  messages: Message[];
  activities: LeadActivity[];
  messagePagination: {
    limit: number;
    hasMore: boolean;
    nextBeforeMessageId: string | null;
  };
}
```

`Message.metadata` is nullable JSON and should be retained for future article cards, media, forwarded conversations, and payment cards.

## RBAC

- Owner/manager: view all, create, send, assign, change status, read, and delete.
- Staff: view/send/change status/read only for assigned conversations.
- Owner/manager can update subject, priority, and pinned state. Staff can only pin assigned conversations.
- Staff may create a conversation only for a lead assigned to them; it is assigned to them automatically.

## Important behavior

- Creating a duplicate active conversation for the same lead and channel returns `CONVERSATION_ALREADY_EXISTS`.
- Stored staff replies are `OUTBOUND` with `INTERNAL` delivery status because no channel provider is connected.
- Status and assignment changes create visible system messages.
- `HUMAN_HANDLING` enables human takeover.
- `AI_HANDLING` enables AI mode, but no AI replies are generated.
- Conversation creation increments shared workspace and business reporting usage without enforcing limits.
- The End Chat action remains frontend-disabled until WhatsApp session handling exists.
- Refresh list/detail/stats after every mutation.

## Important errors

`CONVERSATION_NOT_FOUND`, `CONVERSATION_ALREADY_EXISTS`, `INVALID_CONVERSATION_ASSIGNEE`, `INVALID_CONVERSATION_STATUS`, `MESSAGE_CREATE_FAILED`, `FORBIDDEN`, `BUSINESS_ACCESS_DENIED`, `VALIDATION_ERROR`, `RATE_LIMITED`.
