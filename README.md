# BizReply AI Backend

Production foundation for authentication, business ownership, RBAC, subscription-aware Sprint 2 limits, usage tracking, email verification, password resets, and audit logging.

## Stack

- Node.js 20+, Express 5, TypeScript
- PostgreSQL and Prisma
- JWT access tokens with rotating, hashed refresh tokens
- bcrypt password hashing
- Resend transactional email transport
- Zod validation

## Local setup

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and set secure secrets and database credentials.
3. Install dependencies and initialize the database:

```bash
pnpm install
pnpm prisma:migrate:dev -- --name init
pnpm prisma:seed
pnpm dev
```

Set `RESEND_API_KEY` and `EMAIL_FROM` to a verified Resend sender/domain to deliver transactional emails. In development, email delivery is skipped and logged when `RESEND_API_KEY` is empty. Production startup rejects a missing Resend API key.

The centralized `EmailService` provides verification, password-reset, and welcome-email templates with HTML and plain-text versions. The welcome email is a Sprint 1 placeholder and is not automatically sent yet. Provider failures are logged internally and never returned directly by API endpoints.

The application adds conservative Prisma pool defaults to `DATABASE_URL` at runtime: `DB_CONNECTION_LIMIT=3`, `DB_POOL_TIMEOUT_SECONDS=30`, and `DB_CONNECT_TIMEOUT_SECONDS=15`. These reduce connection pressure on pooled Neon databases and can be overridden per environment.

WhatsApp inbound processing defaults to `WHATSAPP_PROVIDER_MODE=mock`. Mock mode does not require Meta credentials and exposes the development simulator outside production. Live mode requires every `META_*` credential at startup and verifies incoming `x-hub-signature-256` signatures. The fallback verification token in mock mode is `bizreplyai-mock-verify-token` when `META_WHATSAPP_VERIFY_TOKEN` is empty.

## Production

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm prisma:migrate
pnpm prisma:seed
pnpm start
```

`render.yaml` defines a Render web service and PostgreSQL database. Add `FRONTEND_URL`, `CORS_ORIGINS`, `EMAIL_FROM`, and `RESEND_API_KEY` in Render.

## Security decisions

- Passwords require at least 10 characters with uppercase, lowercase, number, and special character.
- Emails are normalized to lowercase.
- Verification and reset tokens are random, SHA-256 hashed in storage, expiring, and single-use.
- Refresh tokens are JWTs stored only as SHA-256 hashes and rotated when refreshed.
- Password reset revokes every active refresh token for the user.
- Login, registration, verification resend, and reset endpoints are rate-limited.
- Forgot-password and resend-verification responses avoid account enumeration.
- Helmet, explicit CORS origins, request-size limits, input validation, and generic internal errors are enabled.

## Roles and tenancy

`BusinessMember` binds a user to a business and role. `PLATFORM_ADMIN` can be assigned via `User.platformRole` and does not require a business. Business routes should combine `authenticate`, `requireBusiness`, and `requireRole(...)`.

Example:

```ts
router.get(
  "/admin",
  authenticate,
  requireBusiness,
  requireRole(BusinessRole.BUSINESS_OWNER),
  handler,
);
```

Subscription helpers live in `src/middleware/subscription-guard.ts`. Subscription and billing usage belong to the business account/workspace. Businesses under one workspace share plan limits. Helpers include `canCreateBusiness`, `canAddStaff`, `canCreateService`, `canCreateAppointment`, prepared conversation/AI checks, and matching account/business usage helpers. `null` consistently means an unlimited plan limit.

## API

| Method | Route | Auth |
|---|---|---|
| POST | `/api/auth/register` | Public |
| POST | `/api/auth/login` | Public |
| POST | `/api/auth/refresh` | Public, refresh token |
| POST | `/api/auth/logout` | Access token |
| GET | `/api/auth/me` | Access token |
| POST | `/api/auth/verify-email` | Public |
| POST | `/api/auth/resend-verification` | Public |
| POST | `/api/auth/forgot-password` | Public |
| POST | `/api/auth/reset-password` | Public |
| GET | `/api/plans` | Public |
| GET | `/api/subscription/current` | Access token |
| POST | `/api/subscription/change-plan` | Owner, placeholder |
| GET | `/api/businesses` | Access token |
| POST | `/api/businesses` | Access token |
| POST | `/api/businesses/invitations` | Business owner |
| POST | `/api/businesses/invitations/accept` | Public |
| POST | `/api/leads` | Business member |
| GET | `/api/leads` | Business member |
| GET | `/api/leads/stats` | Business member |
| GET | `/api/leads/:id` | Business member |
| PATCH | `/api/leads/:id` | Role-scoped |
| PATCH | `/api/leads/:id/assign` | Owner/manager |
| PATCH | `/api/leads/:id/status` | Role-scoped |
| DELETE | `/api/leads/:id` | Owner/manager, soft delete |
| POST | `/api/conversations` | Business member, role-scoped |
| GET | `/api/conversations` | Business member, role-scoped |
| GET | `/api/conversations/stats` | Business member, role-scoped |
| GET | `/api/conversations/:id` | Business member, role-scoped |
| POST | `/api/conversations/:id/messages` | Business member, role-scoped |
| POST | `/api/conversations/:id/messages/:messageId/retry` | Business member, role-scoped |
| PATCH | `/api/conversations/:id` | Business member, role-scoped workspace update |
| PATCH | `/api/conversations/:id/assign` | Owner/manager |
| PATCH | `/api/conversations/:id/status` | Business member, role-scoped |
| PATCH | `/api/conversations/:id/read` | Business member, role-scoped |
| DELETE | `/api/conversations/:id` | Owner/manager, soft delete |
| GET | `/api/webhooks/whatsapp` | Public provider verification |
| POST | `/api/webhooks/whatsapp` | Public provider webhook, signature checked in live mode |
| POST | `/api/dev/mock-whatsapp/inbound-message` | Development only |
| GET | `/api/health` | Public |

Frontend handoffs use `docs/frontend-sprint[number].md` for every sprint:

- `docs/frontend-sprint1.md`
- `docs/frontend-sprint2.md`
- `docs/frontend-sprint3.md`
- `docs/frontend-sprint4.md`
- `docs/frontend-sprint-template.md`

See `docs/ownership-architecture.md` for the canonical customer/membership model, `docs/api-examples.md` for curl examples, `docs/frontend-api-contract.md` for the shared frontend contract, and `docs/sprint-2-subscription-guards.md` for backend integration of future staff, service, and appointment modules.
