# Frontend Sprint 3 Module 1 Handoff

## Sprint goal

Build the first CRM experience around business-scoped lead management. Do not build conversations, WhatsApp, AI, messages, or payments.

Shared contract:

- `docs/frontend-api-contract.md`
- `docs/lead-module-manual-tests.md`

## Required header

All lead endpoints require authentication and a selected business:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Creating an additional business only requires the access token:

```http
POST /businesses
Authorization: Bearer <accessToken>
```

```json
{
  "businessName": "Enoch Properties",
  "industry": "Real Estate",
  "notificationEmail": "hello@enochproperties.com",
  "phone": "+233200000000"
}
```

After creation, use the returned `business.id` as the selected `X-Business-Id`.

Additional businesses inherit the existing workspace subscription. Handle `PLAN_LIMIT_REACHED` by showing the backend message and `recommendedPlan`; creating a business never starts another subscription.

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/leads` | Create a lead |
| GET | `/leads` | Paginated/filterable lead list |
| GET | `/leads/stats` | Counts by status |
| GET | `/leads/:id` | Lead detail and activity timeline |
| PATCH | `/leads/:id` | Update allowed lead fields |
| PATCH | `/leads/:id/assign` | Owner/manager assigns lead |
| PATCH | `/leads/:id/status` | Update lead status |
| DELETE | `/leads/:id` | Soft delete lead |

## Lead types

```ts
type LeadSource =
  | "MANUAL"
  | "WHATSAPP"
  | "WEBSITE"
  | "REFERRAL"
  | "INSTAGRAM"
  | "FACEBOOK"
  | "OTHER";

type LeadStatus =
  | "NEW"
  | "CONTACTED"
  | "INTERESTED"
  | "QUALIFIED"
  | "APPOINTMENT_SCHEDULED"
  | "WON"
  | "LOST";

type LeadActivityAction =
  | "LEAD_CREATED"
  | "LEAD_UPDATED"
  | "LEAD_ASSIGNED"
  | "LEAD_STATUS_CHANGED"
  | "LEAD_NOTE_UPDATED"
  | "LEAD_DELETED";
```

## List query

```text
page=1
limit=20
search=
status=
source=
assignedStaffId=
tag=
dateFrom=
dateTo=
sortBy=createdAt
sortOrder=desc
```

Maximum `limit` is `100`. Search covers full name, phone, and email.

Response:

```ts
interface LeadListResponse {
  data: Lead[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

## RBAC UI behavior

| Role | UI behavior |
|---|---|
| `BUSINESS_OWNER` | Show all leads, create, edit, assign, and soft delete |
| `MANAGER` | Show all leads, create, edit, assign, and soft delete |
| `STAFF` | API returns only assigned leads; show status and notes editing only |

The backend is the final authorization source. Do not assume hiding a button provides security.

## Screens to build

- Lead list with search, pagination, filters, and sorting.
- Lead-status summary cards using `/leads/stats`.
- Create-lead form.
- Lead detail with activity timeline.
- Edit lead form respecting role permissions.
- Owner/manager assignment control using business membership IDs.
- Status update control.
- Delete confirmation for owner/manager.
- Duplicate-lead error state.

## Important errors

| Code | UI behavior |
|---|---|
| `DUPLICATE_LEAD` | Show that the phone already exists in this business |
| `INVALID_LEAD_ASSIGNEE` | Refresh staff options and show assignment error |
| `LEAD_NOT_FOUND` | Show not-found state; do not imply another business owns it |
| `FORBIDDEN` | Hide/disable unauthorized controls |
| `BUSINESS_ACCESS_DENIED` | Clear invalid active-business selection |
| `VALIDATION_ERROR` | Map field errors to the form |
| `RATE_LIMITED` | Temporarily disable mutation retry |

## Acceptance criteria

- List is paginated and never requests every lead.
- Filters and search are represented in URL/query state.
- Staff only see leads returned by the API and cannot access assignment/delete UI.
- Detail view renders activity history.
- Creating a duplicate phone shows a helpful error.
- Updating, assigning, status changes, and deletion refresh list/detail/stats.
- Soft-deleted leads disappear from the UI.
- Changing active business resets lead state and requests with the new `X-Business-Id`.

## Out of scope

- WhatsApp lead ingestion
- AI lead scoring
- Conversations and messages
- Lead merging/import
- Payment integration
