# Sprint 3 Module 2 Conversation Manual Tests

Use two businesses plus owner, manager, and staff memberships. Send authorization and `X-Business-Id`.

1. Owner and manager create manual conversations and receive `201`.
2. Staff creates a conversation only for their assigned lead.
3. Duplicate active lead/channel creation returns `CONVERSATION_ALREADY_EXISTS`.
4. Staff list/detail contains only assigned conversations.
5. Owner/manager list contains all business conversations.
6. Staff sends a message in an assigned conversation; unassigned access returns `CONVERSATION_NOT_FOUND`.
7. Message creation updates preview and last-message time.
8. Owner/manager assignment creates a system message and lead activity; staff assignment attempt returns `FORBIDDEN`.
9. Status changes set takeover/AI/closed fields and create a system message.
10. Customer inbound helper increments unread; mark-read clears unread and sets inbound message `readAt`.
11. Soft delete removes conversation from list/detail/stats without deleting messages.
12. Stats and caches reflect mutations immediately.
13. Business A cannot read or mutate Business B conversations.
14. Conversation creation increments workspace and business conversation usage without enforcing plan limits.
15. Detail history is bounded and older pages use `beforeMessageId`.
16. Conversation detail returns a readable `displayId`, activities, priority, pinned state, and message metadata.
17. Owner/manager updates subject/priority/pinned; staff can only pin an assigned conversation.

The current cache provider is the centralized `CacheService`; it uses Redis when `REDIS_URL` is configured and PostgreSQL remains the source of truth.
