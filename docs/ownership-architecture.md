# User, Workspace, Business, and Subscription Architecture

## Canonical ownership chain

```text
User -> BusinessAccount / Workspace -> Businesses -> BusinessMembers
BusinessAccount / Workspace -> Subscription -> AccountUsageRecord
Business -> BusinessUsageRecord
```

- `User` represents a real person who authenticates.
- `BusinessAccount` is the paying workspace and owns the subscription.
- `Business` is an operational tenant inside the workspace.
- `BusinessMember` controls a person's role and access inside a specific business.
- `AccountUsageRecord` is the source of truth for billing and plan enforcement.
- `BusinessUsageRecord` is reporting-only.

All businesses under one workspace share plan features, business limits, conversation allowances, and AI-reply allowances.

## Active business selection

Authenticated requests may send:

```http
X-Business-Id: <businessId>
```

The authentication middleware verifies an active membership and resolves the business's workspace. Without the header, the earliest active membership is selected.

## Owner registration

`POST /api/auth/register` transactionally creates:

1. User
2. BusinessAccount / Workspace
3. First Business
4. Active `BUSINESS_OWNER` membership
5. Workspace BASIC subscription
6. Account usage record
7. Business reporting usage record
8. Email-verification token

## Additional businesses

`POST /api/businesses`:

- Requires an authenticated workspace owner.
- Enforces the workspace plan's `maxBusinesses`.
- Creates a business and owner membership under the existing workspace.
- Creates only a business reporting usage record.
- Never creates another subscription.

## Staff invitation

Invitations join users to an existing business. Staff usage is enforced and tracked at workspace level.

## Confirmed checks

| Check | Result |
|---|---|
| User exists separately from Business | Yes |
| BusinessAccount owns Businesses | Yes |
| BusinessMember links User and Business | Yes |
| Subscription belongs to BusinessAccount | Yes |
| AccountUsageRecord is billing source of truth | Yes |
| BusinessUsageRecord is reporting-only | Yes |
| Signup creates workspace + first business + one subscription | Yes |
| Additional business reuses workspace subscription | Yes |
| `/api/auth/me` returns account, businesses, active business, subscription, plan, and usage | Yes |
