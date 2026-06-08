# Frontend Sprint 2 Handoff

## Sprint goal

Make the frontend subscription-aware using the `BASIC`, `PLUS`, and `PREMIUM` plans, including usage displays, feature visibility, and upgrade prompts.

Shared API types and complete contracts:

- `docs/frontend-api-contract.md`
- `docs/sprint-2-subscription-guards.md`

## Plan rules

```text
BASIC
PLUS
PREMIUM
```

`null` is the only unlimited-limit marker. Display it as `Unlimited`. Never display `null`, `0`, or `-1` directly as an unlimited allowance.

Sprint 2 enforces:

- `maxBusinesses`
- `maxStaff`
- `maxServices`
- `maxAppointmentsPerMonth`

Conversation and AI-reply usage are visible but are not enforced yet.

## Endpoints

| Method | Endpoint | Frontend use |
|---|---|---|
| GET | `/auth/me` | Dashboard bootstrap with subscription summary |
| GET | `/subscription/current` | Current plan, usage, limits, and features |
| GET | `/plans` | Plan comparison |
| POST | `/subscription/change-plan` | Placeholder only; do not enable checkout |
| POST | `/businesses` | Create an additional owned business |
| GET | `/businesses` | List active business memberships |
| POST | `/businesses/invitations` | Owner invites manager or staff |
| POST | `/businesses/invitations/accept` | Invitee joins the existing business |

## Ownership architecture

```text
User -> BusinessAccount/Workspace -> Businesses -> BusinessMembers
BusinessAccount/Workspace -> Subscription -> AccountUsageRecord
Business -> BusinessUsageRecord
```

- The workspace is the paying SaaS account.
- Subscription and billing usage belong to the workspace.
- Businesses share the workspace plan and conversation/AI allowances.
- Users may belong to multiple businesses.
- Send `X-Business-Id` to select the active business.
- Invitation acceptance creates a membership only; it never creates a business.

## Subscription response

`/subscription/current` exposes the workspace subscription summary. `/auth/me` also returns `account`, `businesses`, `activeBusiness`, `accountUsage`, and active-business `businessUsage`.

```ts
interface SubscriptionSummary {
  id: string;
  plan: "BASIC" | "PLUS" | "PREMIUM";
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED" | "EXPIRED";
  accountUsage: {
    businessesCount: number;
    staffCount: number;
    servicesCount: number;
    appointmentsUsed: number;
    conversationsUsed: number;
    aiRepliesUsed: number;
    knowledgeItemsCount: number;
  };
  limits: {
    maxBusinesses: number | null;
    maxStaff: number | null;
    maxServices: number | null;
    maxAppointmentsPerMonth: number | null;
    maxConversationsPerMonth: number | null;
    maxAiRepliesPerMonth: number | null;
    maxKnowledgeItems: number | null;
  };
  features: {
    allowAnalytics: boolean;
    allowRemoveBranding: boolean;
    allowPrioritySupport: boolean;
  };
}
```

## UI to build

- Workspace summary and business allowance (`businessesCount / maxBusinesses`).
- Current-plan badge and subscription-status badge.
- Usage summary for staff, services, and appointments.
- Plan comparison for Basic, Plus, and Premium.
- `Unlimited` presentation for nullable limits.
- Feature availability indicators.
- Upgrade prompts when the API returns a plan-limit or feature error.
- Disabled plan-change/checkout action marked as coming soon.

## Upgrade error handling

Example:

```json
{
  "error": {
    "code": "PLAN_LIMIT_REACHED",
    "message": "Basic allows up to 2 staff members. Upgrade to Plus to add more staff.",
    "currentPlan": "BASIC",
    "recommendedPlan": "PLUS",
    "limit": 2,
    "current": 2
  }
}
```

Handle:

| Code | UI behavior |
|---|---|
| `PLAN_LIMIT_REACHED` | Show message and upgrade prompt using `recommendedPlan` |
| `PLAN_UPGRADE_REQUIRED` | Show locked-feature and upgrade prompt |
| `SUBSCRIPTION_REQUIRED` | Show subscription-required state |
| `NOT_IMPLEMENTED` | Keep plan-change action disabled |
| `INVITATION_PENDING` | Redirect owner registration attempt to invitation acceptance |
| `INVALID_INVITATION` | Show expired/invalid invitation state |
| `BUSINESS_ACCESS_DENIED` | Clear invalid active-business selection |

Do not calculate authorization solely on the frontend. Use API errors as the final decision.

## Acceptance criteria

- Frontend shows `BASIC`, `PLUS`, and `PREMIUM`; no `PRO` references remain.
- Dashboard shows current usage, limits, features, plan, and status.
- Business creation is blocked with an upgrade prompt when `maxBusinesses` is reached.
- Premium nullable limits display as `Unlimited`.
- Limit errors produce a clear upgrade prompt.
- Feature-locked UI uses backend feature booleans.
- Plan-change UI is visibly unavailable until billing integration exists.
- `/auth/me` renders `account`, `businesses`, `activeBusiness`, `membership`, `subscription`, `plan`, `accountUsage`, `businessUsage`, and `permissions`.
- Business memberships can load from `/businesses`.
- Owner can invite a manager or staff member into the selected business.

## Out of scope

- Payment provider integration
- Actual upgrade/downgrade execution
- Conversation or AI-reply limit blocking
- Staff, services, and appointment feature implementation unless separately scoped
