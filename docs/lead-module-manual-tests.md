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
13. Owner, manager, and staff manual leads without an assignee default to the creator's `BusinessMember.id`.
14. An explicit active owner/manager/staff membership overrides the manual default.
15. Non-manual leads without an assignee remain unassigned.
16. Cross-business, disabled, removed, and missing memberships return `INVALID_LEAD_ASSIGNEE`.
17. `LEAD_CREATED` activity and audit metadata contain `assignedStaffId`, `source`, and `createdById`.
18. Owner assigns a lead to active staff, manager, and owner memberships.
19. Manager assigns a lead to active staff, manager, and owner memberships.
20. Staff assignment attempts return `FORBIDDEN` with the assignment-specific message.
21. `LEAD_ASSIGNED` activity and audit metadata contain previous/new assignee plus assigning user and membership IDs.
22. List and detail reflect the updated assignee after cache invalidation.
23. Owner and manager assign an unassigned lead, reassign between staff, and clear assignment with `assignedStaffId: null`.
24. Assignment history metadata contains `previousAssignedStaffId`, `newAssignedStaffId`, `assignedByUserId`, `assignedByMembershipId`, and `reason`.
25. Generic `PATCH /leads/:id` cannot bypass assignment history using `assignedStaffId`.

## Cache behavior

The current provider is the centralized in-memory `CacheService`; Redis is not configured yet.

- List TTL: 60 seconds
- Detail TTL: 120 seconds
- Stats TTL: 60 seconds
- Pattern invalidation is supported by the current provider.
- Cache errors are logged and requests continue against PostgreSQL.
- Database remains the source of truth.
