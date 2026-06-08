# API examples

Base URL: `http://localhost:3000/api`

## Register

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ama","lastName":"Mensah","email":"ama@example.com","password":"StrongPass!123","businessName":"Ama Foods","industry":"Food"}'
```

## Verify email and login

```bash
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H 'Content-Type: application/json' -d '{"token":"TOKEN_FROM_EMAIL"}'

curl -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ama@example.com","password":"StrongPass!123"}'
```

## Authenticated profile

```bash
curl http://localhost:3000/api/auth/me -H 'Authorization: Bearer ACCESS_TOKEN'
```

## Refresh and logout

```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refreshToken":"REFRESH_TOKEN"}'

curl -X POST http://localhost:3000/api/auth/logout \
  -H 'Authorization: Bearer ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"refreshToken":"REFRESH_TOKEN"}'
```

## Password reset

```bash
curl -X POST http://localhost:3000/api/auth/forgot-password \
  -H 'Content-Type: application/json' -d '{"email":"ama@example.com"}'

curl -X POST http://localhost:3000/api/auth/reset-password \
  -H 'Content-Type: application/json' \
  -d '{"token":"TOKEN_FROM_EMAIL","password":"NewStrongPass!123"}'
```

## Plans and subscription

```bash
curl http://localhost:3000/api/plans
curl http://localhost:3000/api/subscription/current -H 'Authorization: Bearer ACCESS_TOKEN'
curl -X POST http://localhost:3000/api/subscription/change-plan -H 'Authorization: Bearer ACCESS_TOKEN'
```

## Business memberships and invitations

```bash
curl http://localhost:3000/api/businesses \
  -H 'Authorization: Bearer ACCESS_TOKEN'

curl -X POST http://localhost:3000/api/businesses/invitations \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID' \
  -H 'Content-Type: application/json' \
  -d '{"email":"staff@example.com","role":"STAFF"}'

curl -X POST http://localhost:3000/api/businesses/invitations/accept \
  -H 'Content-Type: application/json' \
  -d '{"token":"INVITATION_TOKEN","firstName":"Ama","lastName":"Mensah","password":"StrongPass!123"}'
```

## Leads

```bash
curl -X POST http://localhost:3000/api/leads \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID' \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Kwame Mensah","phone":"+233200000000","source":"MANUAL","tags":["Hot Lead"]}'

curl 'http://localhost:3000/api/leads?page=1&limit=20&status=NEW' \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID'

curl http://localhost:3000/api/leads/stats \
  -H 'Authorization: Bearer ACCESS_TOKEN' \
  -H 'X-Business-Id: BUSINESS_ID'
```
