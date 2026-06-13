# Business Setup Status Manual Tests

Required headers:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

Endpoint:

```http
GET /api/business/setup-status
```

## Access and Isolation

1. Owner can fetch setup status.
2. Manager can fetch setup status.
3. Staff can fetch the same safe setup structure.
4. A user without membership in the selected business receives `BUSINESS_ACCESS_DENIED`.
5. A missing or deleted business receives `BUSINESS_NOT_FOUND`.

## Scoring and Readiness

1. A new business returns low completion and `NOT_STARTED` or `INCOMPLETE`.
2. Adding core profile fields increases completion.
3. A usable WhatsApp connection adds 15%.
4. Mock WhatsApp counts only in mock provider mode.
5. Missing services, pricing, business hours, policies, and handoff contact appear in `missingItems`.
6. Manual inbox readiness can be true while AI readiness remains false.
7. AI readiness remains false if services, pricing, hours, policies, or handoff contact are missing.
8. A fully configured business returns `READY_FOR_AI_AUTOMATION`.
9. Basic does not receive Premium-only completion requirements.
10. `nextRecommendedStep` points to the first incomplete required item.

## Cache

1. Repeated reads return the cached response.
2. WhatsApp connect, deactivate, and change-number actions invalidate setup status.
3. Future business profile, service, availability, pricing, and policy mutations call `invalidateBusinessSetupStatus(businessId)`.
