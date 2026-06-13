# Business Profile Settings Manual Tests

Required headers:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Read Access

1. Owner, manager, and staff can call `GET /api/business/profile`.
2. The response never includes static human handoff fields.
3. A member from another business receives `BUSINESS_ACCESS_DENIED`.

## Update Permissions

1. Owner can update every documented profile field.
2. Manager can update description, address, service area, phone, email, website, and notification email.
3. Manager receives `FORBIDDEN` for name, industry, country, city, timezone, or currency changes.
4. Staff receives `FORBIDDEN` for every update.

## Validation

1. Invalid email, website, or phone returns `VALIDATION_ERROR`.
2. Custom human-readable industries are accepted; unsupported control/special characters return `INVALID_INDUSTRY`.
3. Invalid timezone returns `INVALID_TIMEZONE`.
4. Invalid currency returns `INVALID_CURRENCY`.
5. Clearing both phone and email returns `VALIDATION_ERROR`.
6. Sending human handoff fields returns `VALIDATION_ERROR`.

## Side Effects

1. A successful update creates `BUSINESS_PROFILE_UPDATED` audit data containing changed fields and before/after values.
2. Profile and setup-status caches are invalidated.
3. `GET /api/business/setup-status` reflects the updated profile.
4. SSE emits `business.profile.updated`.
5. Behavior is identical across Basic, Plus, and Premium plans.
