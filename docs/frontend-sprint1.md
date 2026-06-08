# Frontend Sprint 1 Handoff

## Sprint goal

Build the authentication, account verification, business profile, role-aware navigation, and initial subscription-summary experience.

Shared API types and full request/response contracts:

- `docs/frontend-api-contract.md`
- `docs/api-examples.md`

## API configuration

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000/api
```

Use the environment-variable name expected by the frontend framework. Every API URL must include `http://` or `https://`.

## Pages to build

```text
/register
/login
/verify-email
/forgot-password
/reset-password
/dashboard
/settings/subscription
```

Email links open:

```text
/verify-email?token=<token>
/reset-password?token=<token>
```

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` | Register owner and business |
| POST | `/auth/login` | Login and receive access/refresh tokens |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke current refresh token |
| GET | `/auth/me` | Load authenticated profile |
| POST | `/auth/verify-email` | Verify email token |
| POST | `/auth/resend-verification` | Request another verification email |
| POST | `/auth/forgot-password` | Request password-reset email |
| POST | `/auth/reset-password` | Reset password using token |
| GET | `/plans` | List public plans |
| GET | `/subscription/current` | Load current subscription summary |
| GET | `/health` | Check API availability |

## Authentication behavior

1. Registration does not log the user in. Redirect to a check-email confirmation.
2. `EMAIL_NOT_VERIFIED` should show a resend-verification action.
3. Store the returned access and refresh tokens securely.
4. On access-token `401`, call `/auth/refresh` once and retry the request.
5. Refresh tokens rotate. Replace both tokens after a successful refresh.
6. On refresh failure, clear the session and redirect to `/login`.
7. Clear local session state even when the logout request fails.

## Roles

```text
PLATFORM_ADMIN
BUSINESS_OWNER
MANAGER
STAFF
```

Use `role` and `permissions` from `/auth/me` for navigation visibility. Backend authorization remains the source of truth.

## Required error handling

| Code | UI behavior |
|---|---|
| `VALIDATION_ERROR` | Map `error.details` to form fields |
| `EMAIL_EXISTS` | Show email-already-used error |
| `INVALID_CREDENTIALS` | Show login error |
| `EMAIL_NOT_VERIFIED` | Show verification-required state |
| `INVALID_TOKEN` | Show expired/invalid link state |
| `ACCOUNT_DISABLED` | Show account-disabled message |
| `RATE_LIMITED` | Disable retry temporarily |
| `UNAUTHENTICATED` / `INVALID_ACCESS_TOKEN` | Attempt refresh |
| `INVALID_REFRESH_TOKEN` | Clear session and redirect to login |

## Acceptance criteria

- User can register a business-owner account.
- User sees check-email confirmation after registration.
- Verification and password-reset links work from query-string tokens.
- Verified user can log in, refresh a session, load `/auth/me`, and log out.
- Dashboard displays user, business, role, plan, status, limits, and usage.
- Navigation respects backend permissions.
- Public plan comparison loads from `/plans`.

## Out of scope

- Staff invitation flow
- Services and appointments
- WhatsApp and AI features
- Leads and conversations
- Functional plan checkout or plan changes
