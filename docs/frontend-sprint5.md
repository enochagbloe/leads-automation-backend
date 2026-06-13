# Frontend Sprint 5 Handoff

## Sprint 5 Module 1 Goal

Show business setup progress and explain whether the selected business is ready for manual inbox use or future AI automation.

This module does not provide profile, service, availability, or policy editing endpoints yet. It only exposes readiness computed from the current business records.

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
Location or service area: 10%
WhatsApp connection: 15%
Services: 15%
Service pricing: 10%
Business hours: 10%
Policies: 5%
```

Human handoff contact is a mandatory AI-safety requirement but does not add extra percentage beyond the requested 100% scoring.
If every weighted section is complete but the required handoff contact is missing, the backend returns 99% so the UI never shows a contradictory 100% incomplete state.

## Readiness Rules

Manual inbox readiness requires:

- Business basic information
- Industry
- Location or service area
- Usable WhatsApp connection

AI readiness additionally requires:

- Business description
- Active service
- Service price or pricing note
- Business hours
- Active policy
- Human handoff contact

Mock WhatsApp counts only while the backend uses mock provider mode. A live connection counts only when it has a usable tenant credential or an eligible legacy credential migration path.

## Current Missing Setup Forms

The backend now has data foundations for:

- Business description, country, city, address, service area, and handoff contact
- Services and basic pricing
- Business availability
- Business policies

Their editing APIs are later modules. Until records exist, the setup-status endpoint correctly returns these sections as missing.

## Errors

```text
UNAUTHENTICATED
BUSINESS_ACCESS_DENIED
BUSINESS_NOT_FOUND
SUBSCRIPTION_REQUIRED
```

## Caching

The response is cached briefly. WhatsApp lifecycle changes invalidate it immediately. Future profile, service, availability, and policy mutations must call the shared setup-status cache invalidation helper.
