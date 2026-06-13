# Services & Pricing Manual Tests

All requests require:

```http
Authorization: Bearer <accessToken>
X-Business-Id: <activeBusinessId>
```

## Lifecycle

1. Owner creates a service with only a name and receives `DRAFT`.
2. A described fixed-price service receives `READY_FOR_AI`.
3. A described, priced/free, bookable service with duration receives `READY_FOR_BOOKING`.
4. Missing price and duration appear in `missingFields`.
5. Manager can create, update, archive, restore, and reorder.
6. Archived services disappear from the default active list.
7. Restoring recalculates readiness.

## Access And Isolation

1. Staff can list and view active services only.
2. Staff write actions return `FORBIDDEN`.
3. Staff cannot view archived service detail, even after an owner loaded it.
4. Cross-business detail/update/archive/restore/reorder returns `SERVICE_NOT_FOUND`.
5. The same service name is allowed in different businesses.
6. Case-insensitive duplicate non-archived names in one business return `SERVICE_NAME_ALREADY_EXISTS`.

## Limits And Usage

1. Basic blocks the sixth active service.
2. Plus blocks the twenty-first active service.
3. Premium blocks the one-hundred-and-first active service.
4. Archived and inactive services do not count.
5. Activating or restoring at the limit returns `SERVICE_LIMIT_REACHED`.
6. Account `servicesCount` remains synchronized after every lifecycle mutation.

## Side Effects

1. Mutations create the matching `BUSINESS_SERVICE_*` audit event.
2. List, detail, summary, and setup caches invalidate after mutations.
3. Realtime service lifecycle and summary events are emitted.
4. Setup status returns `serviceProgress`.
5. AI-context helpers return only active non-archived services and identify gaps.

## Migration Compatibility

1. Migrating legacy services with case-insensitive duplicate names preserves the oldest service and archives later duplicates before creating the unique index.
2. Legacy pricing-note-only services migrate to `QUOTE_ONLY` without gaining a missing-price gap.
3. Legacy services inherit the owning business's `defaultCurrency`.
