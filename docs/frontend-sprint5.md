# Frontend Sprint 5 Handoff

## Business Profile Settings

All active business members can load the safe business profile:

```http
GET /api/business/profile
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Owners and managers can update profile settings:

```http
PATCH /api/business/profile
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
Content-Type: application/json
```

PATCH is partial. Optional fields can be cleared with `null`. At least one of `phone` or `email` must remain.

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

Recommended industries:

```text
REAL_ESTATE
CONSTRUCTION
ARCHITECTURE
CONSULTING
SALON_BEAUTY
CLINIC_HEALTHCARE
HOTEL_HOSPITALITY
ONLINE_STORE
EDUCATION
LEGAL
FINANCE
OTHER
```

Custom human-readable industry values are also accepted.

After a successful update, refetch setup status. The SSE stream also emits `business.profile.updated`.

Do not render or send static human-handoff email or phone fields. Human handoff will later use assigned business members.

## Sprint 5 Module 1 Goal

Show business setup progress and explain whether the selected business is ready for manual inbox use or future AI automation.

This sprint now provides business profile editing. Service, availability, and policy editing endpoints remain future modules.

## Endpoint

```http
GET /api/business/setup-status
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

All active business members can safely view the response.

## Response

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
};
```

Example:

```json
{
  "businessId": "business-id",
  "plan": "BASIC",
  "completionPercentage": 30,
  "readinessStatus": "INCOMPLETE",
  "isManualInboxReady": false,
  "isAiReady": false,
  "missingItems": [
    {
      "key": "services",
      "label": "Add at least one service",
      "description": "Services help BizReply understand what your business offers.",
      "route": "/settings/business/services",
      "requiredFor": "AI_AUTOMATION",
      "planRequired": "BASIC"
    }
  ],
  "completedItems": [
    {
      "key": "businessBasicInfo",
      "label": "Complete business contact information"
    }
  ],
  "nextRecommendedStep": {
    "key": "industryDescription",
    "label": "Add industry and business description",
    "route": "/settings/business/profile"
  }
}
```

## UI Behavior

- Fetch setup status after the active business is selected.
- Show a dashboard setup-progress card when readiness is not `READY_FOR_AI_AUTOMATION`.
- Display `completionPercentage` directly; do not calculate progress on the frontend.
- Use `nextRecommendedStep.route` for the primary setup action.
- Render missing items as a checklist grouped by `requiredFor`.
- Show manual inbox readiness separately from AI readiness.
- Do not block the dashboard when setup is incomplete.
- Do not imply AI automation is active when `isAiReady` is true. It only means the business has enough setup information for a future AI module.

## Scoring

```text
Business basic info: 20%
Industry and description: 15%
Business country and city: 10%
WhatsApp connection: 15%
Services: 15%
Service pricing: 10%
Business hours: 10%
Policies: 5%
```

Human handoff is not an editable profile field and is not part of setup scoring. A future handoff workflow will route conversations to eligible business members.

## Readiness Rules

Manual inbox readiness requires:

- Business basic information
- Industry
- Business country and city
- Usable WhatsApp connection

AI readiness additionally requires:

- Business description
- Active service
- Service price or pricing note
- Business hours
- Active policy

Mock WhatsApp counts only while the backend uses mock provider mode. A live connection counts only when it has a usable tenant credential or an eligible legacy credential migration path.

## Current Missing Setup Forms

The backend now has data foundations for:

- Business description, country, city, address, service area, website, timezone, currency, and notification email
- Services and basic pricing
- Business availability
- Business policies

Service, availability, and policy editing APIs are later modules. Until records exist, setup status correctly returns those sections as missing.

## Errors

```text
UNAUTHENTICATED
BUSINESS_ACCESS_DENIED
BUSINESS_NOT_FOUND
SUBSCRIPTION_REQUIRED
```

## Caching

The response is cached briefly. WhatsApp lifecycle changes invalidate it immediately. Future profile, service, availability, and policy mutations must call the shared setup-status cache invalidation helper.
