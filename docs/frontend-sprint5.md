# Frontend Sprint 5 Handoff

## Business Profile Settings

All active business members can load the safe business profile:

```http
GET /api/business/profile
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Owners and managers can update profile settings with `PATCH /api/business/profile`. PATCH is partial, optional fields can be cleared with `null`, and at least one of `phone` or `email` must remain.

Owner can update every field. Manager can update only:

```text
description
address
serviceArea
phone
email
website
defaultNotificationEmail
```

Staff can view but cannot update. Handle:

```text
BUSINESS_NOT_FOUND
BUSINESS_ACCESS_DENIED
FORBIDDEN
VALIDATION_ERROR
INVALID_INDUSTRY
INVALID_TIMEZONE
INVALID_CURRENCY
```

After a successful update, refetch setup status. The SSE stream also emits `business.profile.updated`.

## Services & Pricing

Use these business-scoped endpoints:

```text
GET    /api/business/services
GET    /api/business/services/summary
GET    /api/business/services/:serviceId
POST   /api/business/services
PATCH  /api/business/services/:serviceId
DELETE /api/business/services/:serviceId
POST   /api/business/services/:serviceId/restore
PATCH  /api/business/services/reorder
```

Owners and managers can manage services. Staff can view active services only.

Service readiness values:

```text
DRAFT
INCOMPLETE
READY_FOR_AI
READY_FOR_BOOKING
ARCHIVED
```

Price types:

```text
FIXED
STARTING_FROM
RANGE
QUOTE_ONLY
FREE
NOT_SET
```

Incomplete services are valid. Render `missingFields` as reminders. Active-service limits are shared across the workspace: Basic 5, Plus 20, Premium 100.

Listen for:

```text
business.service.created
business.service.updated
business.service.archived
business.service.restored
business.service.reordered
business.services.summary.updated
```

After service events, refresh the services list/summary and setup status.

## Setup Status

Use:

```http
GET /api/business/setup-status
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

All active business members can safely view the response.

```ts
type BusinessReadinessStatus =
  | "NOT_STARTED"
  | "INCOMPLETE"
  | "READY_FOR_MANUAL_INBOX"
  | "READY_FOR_AI_AUTOMATION";

type SetupItem = {
  key: string;
  label: string;
  description: string;
  route: string;
  requiredFor: "MANUAL_INBOX" | "AI_AUTOMATION";
  planRequired: "BASIC" | "PLUS" | "PREMIUM";
};

type BusinessSetupStatus = {
  businessId: string;
  plan: "BASIC" | "PLUS" | "PREMIUM";
  completionPercentage: number;
  readinessStatus: BusinessReadinessStatus;
  isManualInboxReady: boolean;
  isAiReady: boolean;
  missingItems: SetupItem[];
  completedItems: Array<{ key: string; label: string }>;
  nextRecommendedStep: {
    key: string;
    label: string;
    route: string;
  } | null;
  serviceProgress: {
    servicesAdded: number;
    servicesWithPricing: number;
    servicesReadyForAi: number;
    servicesReadyForBooking: number;
    missingServicePrices: number;
    missingServiceDurations: number;
  };
};
```

Display `completionPercentage` directly and use `nextRecommendedStep.route` for the primary setup action. Do not block the dashboard when setup is incomplete. Manual inbox readiness and AI readiness are separate.

Setup scoring:

```text
Business basic info: 20%
Industry and description: 15%
Business country and city: 10%
WhatsApp connection: 15%
Services: 15%
Service pricing: 10%
Business availability: 10%
Policies: 5%
```

## Module 4: Business Availability

Business owners and managers can configure one weekly schedule per business. Staff can view it but cannot update it.

All endpoints require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Endpoints

| Method | Endpoint | Access |
|---|---|---|
| GET | `/api/business/availability` | Owner, manager, staff |
| GET | `/api/business/availability/summary` | Owner, manager, staff |
| PUT | `/api/business/availability` | Owner, manager |

The weekly update must send exactly one rule for each day:

```json
{
  "timezone": "Africa/Accra",
  "rules": [
    {
      "dayOfWeek": "MONDAY",
      "isOpen": true,
      "openTime": "08:00",
      "closeTime": "17:00",
      "breakStartTime": "12:00",
      "breakEndTime": "13:00",
      "appliesToAllServices": true
    },
    {
      "dayOfWeek": "SUNDAY",
      "isOpen": false
    }
  ]
}
```

Include all seven enum values: `MONDAY`, `TUESDAY`, `WEDNESDAY`, `THURSDAY`, `FRIDAY`, `SATURDAY`, and `SUNDAY`.

Closed days must not send opening or break times. Open days require `openTime` and `closeTime` in 24-hour `HH:mm` format. Break start/end must either both be set or both be null.

The GET response includes `businessId`, `timezone`, ordered `rules`, and:

```json
{
  "summary": {
    "openDays": 6,
    "closedDays": 1,
    "hasBreakTimes": true,
    "isComplete": true
  }
}
```

The summary endpoint additionally returns `hasWeeklySchedule`, `hasCompleteWeeklySchedule`, `nextOpenDay`, and `todayStatus`.

Listen for:

```text
business.availability.updated
business.availability.summary.updated
```

Both events should invalidate the availability queries and setup-status query. Updating the business profile timezone also updates the saved weekly schedule timezone and emits these events.

Errors to handle:

```text
FORBIDDEN
INVALID_TIMEZONE
VALIDATION_ERROR
BUSINESS_NOT_FOUND
```

Availability exceptions and service-specific/staff-specific schedules are not implemented in this module.

## Module 5: Business Policies

Business owners and managers can manage approved operational policies. Staff can only view active customer-facing policies.

Endpoints:

```text
GET    /api/business/policies
GET    /api/business/policies/summary
GET    /api/business/policies/:policyId
POST   /api/business/policies
PATCH  /api/business/policies/:policyId
DELETE /api/business/policies/:policyId
POST   /api/business/policies/:policyId/restore
PATCH  /api/business/policies/reorder
```

List query params:

```text
category
visibility
status=active|inactive|archived|all
search
page
limit
sort=displayOrder|priority|category|createdAt|updatedAt
sortOrder=asc|desc
```

Policy categories:

```text
GENERAL PAYMENT DEPOSIT REFUND CANCELLATION RESCHEDULING LATE_ARRIVAL
NO_SHOW TRANSPORTATION SERVICE_AREA APPOINTMENT PRIVACY TERMS OTHER
```

Visibility values:

```text
INTERNAL_ONLY
CUSTOMER_FACING
```

Active policy limits:

```text
BASIC: 10
PLUS: 30
PREMIUM: 100
```

Active policy limits are shared across all businesses in the workspace. Archived and inactive policies do not count toward the active limit. Handle `POLICY_LIMIT_REACHED` by showing an upgrade prompt.

The policy summary returns total, active, inactive, archived, customer-facing and internal-only counts, configured categories, and missing recommended categories.

Setup status now includes:

```ts
policyProgress: {
  policiesAdded: number;
  customerFacingPolicies: number;
  missingRecommendedPolicyCategories: BusinessPolicyCategory[];
};
```

Listen for:

```text
business.policy.created
business.policy.updated
business.policy.archived
business.policy.restored
business.policy.reordered
business.policies.summary.updated
```

After these events, refresh the policy list, policy summary, and setup status.

Errors:

```text
POLICY_NOT_FOUND
POLICY_LIMIT_REACHED
FORBIDDEN
VALIDATION_ERROR
BUSINESS_NOT_FOUND
BUSINESS_ACCESS_DENIED
```

AI-generated policies, policy templates, approval workflows, and version history are not implemented.
