# Sprint 3 Module 1 Lead Manual Tests

## Setup

Use two businesses and three active memberships in business A:

- Business owner
- Manager
- Staff

Send `Authorization` and `X-Business-Id` on every request.

## Test cases

1. Owner creates a lead and receives `201`.
2. Manager creates a lead and receives `201`.
3. Staff list does not include unassigned leads.
4. Owner assigns a lead using the staff `BusinessMember.id`; staff can then view it.
5. Staff can update status and notes on an assigned lead.
6. Status update creates `LEAD_STATUS_CHANGED` activity.
7. Creating the same active phone in the same business returns `DUPLICATE_LEAD`.
8. Creating the same phone in a different business succeeds.
9. `GET /leads?page=1&limit=1` returns one record and pagination metadata.
10. Read a cached list, create/update a lead, then confirm the next list reflects the change.
11. Soft-delete a lead and confirm it no longer appears in list/detail/stats.
12. Request a business A lead while scoped to business B and confirm `LEAD_NOT_FOUND`.

## Cache behavior

The current provider is the centralized in-memory `CacheService`; Redis is not configured yet.

- List TTL: 60 seconds
- Detail TTL: 120 seconds
- Stats TTL: 60 seconds
- Pattern invalidation is supported by the current provider.
- Cache errors are logged and requests continue against PostgreSQL.
- Database remains the source of truth.
