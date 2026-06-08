# Sprint 2 Subscription Guard Integration

The subscription foundation enforces only:

- `maxBusinesses`
- `maxStaff`
- `maxServices`
- `maxAppointmentsPerMonth`

Conversation and AI-reply usage are tracked but are not enforced yet.

## Before creating records

```ts
import {
  canCreateBusiness,
  canAddStaff,
  canCreateService,
  canCreateAppointment,
} from "../middleware/subscription-guard";

await canCreateBusiness(businessAccountId);
await canAddStaff(businessAccountId, businessId);
await canCreateService(businessAccountId, businessId);
await canCreateAppointment(businessAccountId, businessId);
```

Each helper returns `true` when allowed and throws a `PLAN_LIMIT_REACHED` error with `currentPlan` and `recommendedPlan` when blocked.

## After successful mutations

```ts
import {
  updateBusinessesUsage,
  updateStaffUsage,
  updateServicesUsage,
  updateAppointmentsUsage,
} from "../middleware/subscription-guard";

await updateBusinessesUsage(businessAccountId, 1);
await updateStaffUsage(businessAccountId, 1, businessId);
await updateServicesUsage(businessAccountId, 1, businessId);
await updateAppointmentsUsage(businessAccountId, businessId);
```

Usage values cannot fall below zero. Every update writes a `USAGE_RECORD_UPDATED` audit log.

## Feature checks

```ts
import { assertFeatureAllowed } from "../middleware/subscription-guard";

await assertFeatureAllowed(businessAccountId, "allowAnalytics", businessId);
await assertFeatureAllowed(businessAccountId, "allowRemoveBranding", businessId);
await assertFeatureAllowed(businessAccountId, "allowPrioritySupport", businessId);
```

`null` is the only unlimited-limit marker. Never treat `0` or `-1` as unlimited.

Account usage is the billing and enforcement source of truth. Business usage is reporting-only.
