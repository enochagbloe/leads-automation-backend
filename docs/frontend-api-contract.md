# BizReply AI Shared Frontend API Contract

## Base configuration

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

All requests and responses use JSON. Authenticated requests must include:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Send `X-Business-Id: <businessId>` to select a specific active business. Without it, the backend selects the user's earliest active membership.

Dates are ISO 8601 strings. Prisma decimal values such as `priceMonthly` are returned as strings.

## Frontend routes

The backend emails link to these frontend routes:

```text
/verify-email?token=<token>
/reset-password?token=<token>
/accept-invite?token=<token>
```

Recommended frontend pages:

```text
/register
/login
/verify-email
/forgot-password
/reset-password
/accept-invite
/dashboard
/settings/subscription
```

## Shared types

```ts
export type UserRole =
  | "PLATFORM_ADMIN"
  | "BUSINESS_OWNER"
  | "MANAGER"
  | "STAFF";

export type BusinessStatus = "ACTIVE" | "SUSPENDED" | "PENDING_SETUP";
export type UserStatus = "ACTIVE" | "DISABLED";
export type MembershipStatus = "ACTIVE" | "INVITED" | "DISABLED" | "REMOVED";
export type PlanCode = "BASIC" | "PLUS" | "PREMIUM";
export type SubscriptionStatus =
  | "TRIALING"
  | "ACTIVE"
  | "PAST_DUE"
  | "CANCELLED"
  | "EXPIRED";

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  emailVerified: boolean;
  status: UserStatus;
  createdAt: string;
}

export interface Business {
  id: string;
  businessAccountId: string;
  name: string;
  industry: string;
  slug: string;
  ownerId: string;
  email: string;
  phone: string | null;
  status: BusinessStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Plan {
  id: string;
  name: string;
  code: PlanCode;
  priceMonthly: string;
  currency: string;
  maxStaff: number | null;
  maxServices: number | null;
  maxAppointmentsPerMonth: number | null;
  maxConversationsPerMonth: number | null;
  maxAiRepliesPerMonth: number | null;
  maxKnowledgeItems: number | null;
  maxBusinesses: number | null;
  allowAnalytics: boolean;
  allowRemoveBranding: boolean;
  allowPrioritySupport: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccountUsage {
  businessesCount: number;
  staffCount: number;
  servicesCount: number;
  appointmentsUsed: number;
  conversationsUsed: number;
  aiRepliesUsed: number;
  knowledgeItemsCount: number;
}

export interface BusinessUsage {
  conversationsUsed: number;
  aiRepliesUsed: number;
  appointmentsUsed: number;
  leadsCreated: number;
}

export interface Limits {
  maxBusinesses: number | null;
  maxStaff: number | null;
  maxServices: number | null;
  maxAppointmentsPerMonth: number | null;
  maxConversationsPerMonth: number | null;
  maxAiRepliesPerMonth: number | null;
  maxKnowledgeItems: number | null;
}

export interface PlanFeatures {
  allowAnalytics: boolean;
  allowRemoveBranding: boolean;
  allowPrioritySupport: boolean;
}

export interface ProfileSubscription {
  id: string;
  status: SubscriptionStatus;
  startsAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
}

export interface ActiveMembership {
  id: string;
  role: "BUSINESS_OWNER" | "MANAGER" | "STAFF";
  status: MembershipStatus;
  joinedAt: string | null;
}

export interface ActivePlan {
  id: string;
  code: PlanCode;
  name: string;
  priceMonthly: string;
  currency: string;
  limits: Limits;
  features: PlanFeatures;
}

export interface AuthProfile {
  user: User;
  account: { id: string; name: string; ownerId: string } | null;
  businesses: Business[];
  activeBusiness: Business | null;
  membership: ActiveMembership | null;
  role: UserRole;
  subscription: ProfileSubscription | null;
  plan: ActivePlan | null;
  accountUsage: AccountUsage | null;
  businessUsage: BusinessUsage;
  limits: Limits | null;
  features: PlanFeatures | null;
  permissions: string[];
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    currentPlan?: PlanCode;
    recommendedPlan?: PlanCode;
    limit?: number;
    current?: number;
    featureKey?: keyof PlanFeatures;
  };
}
```

## Authentication endpoints

### Register

`POST /auth/register`

```ts
interface RegisterRequest {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  businessName: string;
  industry: string;
}

interface RegisterResponse {
  user: User;
  business: Business;
  message: string;
}
```

Registration creates a business, assigns the user as `BUSINESS_OWNER`, and starts a 14-day `BASIC` trial. Registration does not log the user in. Redirect to a "check your email" screen.

Password rules:

- 10 to 128 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character

### Verify email

`POST /auth/verify-email`

```json
{ "token": "TOKEN_FROM_FRONTEND_QUERY_STRING" }
```

Success:

```json
{ "message": "Email verified successfully" }
```

After success, redirect to `/login`.

### Resend verification

`POST /auth/resend-verification`

```json
{ "email": "owner@example.com" }
```

Always returns a generic success message to prevent account discovery.

### Login

`POST /auth/login`

```json
{
  "email": "owner@example.com",
  "password": "StrongPass!123"
}
```

Response:

```ts
interface LoginResponse extends AuthProfile {
  accessToken: string;
  refreshToken: string;
}
```

An unverified account returns `EMAIL_NOT_VERIFIED`. Show a verification prompt with a resend action.

### Current user

`GET /auth/me`

Requires access token. Returns `AuthProfile`.

Use this endpoint when bootstrapping an authenticated session and after refreshing profile-sensitive data.

Send `X-Business-Id` to load a specific active business membership.

### Refresh token

`POST /auth/refresh`

```json
{ "refreshToken": "REFRESH_TOKEN" }
```

Response:

```json
{
  "accessToken": "NEW_ACCESS_TOKEN",
  "refreshToken": "NEW_REFRESH_TOKEN"
}
```

Refresh tokens rotate. Replace both stored tokens after every successful refresh. A refresh token cannot be reused after rotation.

### Logout

`POST /auth/logout`

Requires access token.

```json
{ "refreshToken": "CURRENT_REFRESH_TOKEN" }
```

Success:

```json
{ "message": "Logged out successfully" }
```

Clear frontend auth state even if the logout request fails.

### Forgot password

`POST /auth/forgot-password`

```json
{ "email": "owner@example.com" }
```

Always returns a generic success message. Show the same confirmation regardless of whether the account exists.

### Reset password

`POST /auth/reset-password`

```json
{
  "token": "TOKEN_FROM_FRONTEND_QUERY_STRING",
  "password": "NewStrongPass!123"
}
```

Success:

```json
{ "message": "Password reset successfully" }
```

Resetting a password revokes all existing refresh tokens. Redirect to `/login`.

## Subscription endpoints

### List plans

`GET /plans`

Public endpoint. Returns `Plan[]`.

### Current subscription

`GET /subscription/current`

Requires access token and business membership.

```ts
interface CurrentSubscription {
  account: { id: string; name: string; ownerId: string };
  businesses: Business[];
  activeBusiness: Business | null;
  id: string;
  plan: PlanCode;
  status: SubscriptionStatus;
  accountUsage: AccountUsage;
  businessUsage: BusinessUsage;
  limits: Limits;
  features: PlanFeatures;
  startsAt: string;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelledAt: string | null;
}
```

`null` in a plan limit means unlimited. Business, staff, service, and appointment limits are account-wide. Conversation and AI-reply usage is shared across the workspace but is not enforced yet.

### Change plan

`POST /subscription/change-plan`

Requires `BUSINESS_OWNER`. This is a placeholder and currently returns:

```json
{
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "Plan changes will be enabled when billing integration is added."
  }
}
```

Do not expose an active checkout/change-plan action yet.

## Business membership endpoints

### Create an additional business

`POST /businesses`

Requires an access token and workspace ownership. This creates a new business under the existing workspace and an active `BUSINESS_OWNER` membership. It does not create another subscription.

```json
{
  "businessName": "Enoch Properties",
  "industry": "Real Estate",
  "notificationEmail": "hello@enochproperties.com",
  "phone": "+233200000000"
}
```

The endpoint accepts either `businessName` or `name`, and either `notificationEmail` or `email`. Only the business name and `industry` are required. When an email is omitted, the authenticated user's email is used. Additional onboarding fields may be submitted but are not persisted until the business-profile and availability modules are implemented.

After creation, select the returned `business.id` as the active business and send it in `X-Business-Id` for business-scoped endpoints.

### List active memberships

`GET /businesses`

Requires an access token. Returns every active membership with its business. Use this for a future business switcher.

### Invite a member

`POST /businesses/invitations`

Requires an access token, selected business, and `BUSINESS_OWNER`.

```json
{ "email": "staff@example.com", "role": "STAFF" }
```

Allowed roles are `MANAGER` and `STAFF`.

### Accept a business invitation

`POST /businesses/invitations/accept`

Existing users submit only the token. New users must also submit `firstName`, `lastName`, and `password`.

```json
{
  "token": "INVITATION_TOKEN",
  "firstName": "Ama",
  "lastName": "Mensah",
  "password": "StrongPass!123"
}
```

Acceptance creates a membership in the invited business. It never creates a business or subscription.

## Health endpoint

`GET /health`

```json
{
  "status": "ok",
  "timestamp": "2026-06-07T12:00:00.000Z"
}
```

## Lead endpoints

All lead endpoints require an access token and active business context.

| Method | Endpoint |
|---|---|
| POST | `/leads` |
| GET | `/leads` |
| GET | `/leads/stats` |
| GET | `/leads/:id` |
| PATCH | `/leads/:id` |
| PATCH | `/leads/:id/assign` |
| PATCH | `/leads/:id/status` |
| DELETE | `/leads/:id` |

Lead list query parameters:

```text
page, limit, search, status, source, assignedStaffId, tag,
dateFrom, dateTo, sortBy, sortOrder
```

Lead detail returns:

```ts
interface LeadDetailResponse {
  lead: Lead;
  activities: LeadActivity[];
}
```

See `docs/frontend-sprint3.md` for lead types, RBAC behavior, and UI scope.

## Error handling

All errors use:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable message",
    "details": {
      "fieldName": ["Optional validation message"]
    }
  }
}
```

Important codes:

| HTTP | Code | Frontend behavior |
|---|---|---|
| 400 | `INVALID_TOKEN` | Show expired/invalid link screen |
| 401 | `INVALID_CREDENTIALS` | Show login form error |
| 401 | `UNAUTHENTICATED` | Attempt refresh, then redirect to login |
| 401 | `INVALID_ACCESS_TOKEN` | Attempt refresh, then redirect to login |
| 401 | `INVALID_REFRESH_TOKEN` | Clear session and redirect to login |
| 403 | `EMAIL_NOT_VERIFIED` | Show verification/resend screen |
| 403 | `ACCOUNT_DISABLED` | Show account-disabled support message |
| 403 | `FORBIDDEN` | Show permission-denied state |
| 403 | `SUBSCRIPTION_REQUIRED` | Show subscription-required state |
| 403 | `PLAN_UPGRADE_REQUIRED` | Show feature upgrade prompt using `recommendedPlan` |
| 403 | `PLAN_LIMIT_REACHED` | Show usage-limit prompt using `currentPlan` and `recommendedPlan` |
| 409 | `EMAIL_EXISTS` | Mark registration email as already used |
| 409 | `INVITATION_PENDING` | Send user to invitation acceptance instead of owner registration |
| 409 | `MEMBERSHIP_EXISTS` | Explain that the user already belongs to the business |
| 400 | `INVALID_INVITATION` | Show invalid/expired invitation state |
| 422 | `INVITEE_ACCOUNT_DETAILS_REQUIRED` | Ask new invitee for name and password |
| 403 | `BUSINESS_ACCESS_DENIED` | Clear invalid active-business selection |
| 409 | `DUPLICATE_LEAD` | Show existing-phone lead error |
| 422 | `INVALID_LEAD_ASSIGNEE` | Refresh staff options and show assignment error |
| 404 | `LEAD_NOT_FOUND` | Show lead not found |
| 404 | `CONVERSATION_NOT_FOUND` | Show conversation not found |
| 409 | `CONVERSATION_ALREADY_EXISTS` | Open the existing active conversation |
| 422 | `INVALID_CONVERSATION_ASSIGNEE` | Refresh staff options and show assignment error |
| 422 | `INVALID_CONVERSATION_STATUS` | Refresh conversation and show status error |
| 500 | `MESSAGE_CREATE_FAILED` | Keep draft and allow retry |
| 422 | `VALIDATION_ERROR` | Map `error.details` to form fields |
| 429 | `RATE_LIMITED` | Disable retry temporarily |
| 501 | `NOT_IMPLEMENTED` | Hide or disable unfinished action |

## Recommended frontend auth structure

```text
src/
  api/
    client.ts
    auth.api.ts
    plans.api.ts
    subscription.api.ts
    types.ts
  auth/
    AuthProvider.tsx
    ProtectedRoute.tsx
    PermissionGate.tsx
    token-store.ts
  pages/
    auth/
      RegisterPage.tsx
      LoginPage.tsx
      VerifyEmailPage.tsx
      ForgotPasswordPage.tsx
      ResetPasswordPage.tsx
    dashboard/
    subscription/
```

Recommended session behavior:

1. Keep the access token in memory where practical.
2. The current backend returns refresh tokens in JSON, so the frontend must persist the refresh token if sessions should survive reloads. Treat it as sensitive.
3. On an access-token `401`, call `/auth/refresh` once and retry the original request.
4. Prevent parallel refresh calls by sharing one in-flight refresh promise.
5. If refresh fails, clear tokens/profile and redirect to `/login`.
6. Use `permissions` and `role` for UI visibility, but rely on backend authorization for actual security.

## Sprint 1 UI scope

Build:

- Registration and check-email confirmation
- Email verification result and resend flow
- Login and logout
- Forgot/reset password
- Authenticated dashboard shell
- Profile/business summary
- Current plan, status, limits, and usage summary
- Public plan comparison
- Role/permission-aware navigation

## Conversation endpoints

All conversation endpoints are business-scoped and role-filtered.

```text
POST   /conversations
GET    /conversations
GET    /conversations/stats
GET    /conversations/:id?messageLimit=50&beforeMessageId=
POST   /conversations/:id/messages
PATCH  /conversations/:id
PATCH  /conversations/:id/assign
PATCH  /conversations/:id/status
PATCH  /conversations/:id/read
DELETE /conversations/:id
```

See `docs/frontend-sprint3-module2.md` for the complete inbox contract.

Do not build yet:

- WhatsApp integration
- AI configuration
- Leads
- Appointments
- Real-time conversation sockets
- Staff invitation flow
- Functional plan checkout/change-plan
