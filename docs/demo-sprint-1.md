# Instant demo: Sprint 1

## Architecture inspected

- `middleware/auth.ts` verifies production JWTs, active users and memberships; `req.auth` carries user/account/business/membership/role. It is unchanged.
- `business.service.ts` creates memberships, subscriptions and usage through production policies. Demo initialization uses a transaction over the same domain models without invoking these production side effects.
- `conversation.service.ts` scopes reads and mutations by business and membership; lifecycle/message services provide the later shared ingestion path. Sprint 1 creates only the existing Conversation row with defaults.
- Lead is the contact/customer model and is required by Conversation. One synthetic opted-out Lead supplies the initial customer; no lead generation workflow runs.
- Leads and appointment access use businessId; child records cascade from Business. Demo callers cannot reach those production routes.
- WhatsApp outbound calls converge on whatsapp-provider.service.ts. Guards now check persisted business/conversation scope, including direct provider class calls.
- Realtime uses in-process SSE. The new internal demo adapter has a separate subscriber map and filters by session AND conversation; expiry and destruction close subscriptions. There is no public demo SSE route yet.
- Subscription guards and usage services are account-based. Demo has no subscription, usage record, membership, provider integration, or enabled AI/follow-up automation.
- Existing workers start/stop in server.ts; demo cleanup follows this lifecycle, including while creation is disabled.

## Schema and migration

`20260905120000_demo_session_foundation/migration.sql` adds DemoSession (hashed credential, hashed IP, hashed idempotency key, ACTIVE/EXPIRED/DESTROYED status, timestamps) and a DEMO conversation channel. Nullable unique demoSessionId foreign keys on Business, BusinessAccount and User identify the temporary parents. Existing records retain null values.

Required owner/account relations are satisfied by a disabled, non-login system identity with a generated `.invalid` email, unusable password, no platform role and no memberships. No production token is issued. Customer and conversation inherit isolation/retention from Business.

Migration was created but is not automatically deployed. Deploy with the existing `prisma:migrate` command before enabling demo or starting the updated cleanup worker.

## API

- POST `/api/demo/session`: public, returns 201 `{success, demo, token}`. Optional random `Idempotency-Key` (16?128 letters/digits/underscore/hyphen) deduplicates retries for the same IP. Request bodies never select resources.
- GET `/api/demo/session`: `Authorization: Bearer <token>` returns session, expiry, business, conversation, customer, empty messages and limits.
- DELETE `/api/demo/session`: same authentication; invalidates the session and transactionally removes its temporary domain records. Returns `{success:true}`.

The explicit `req.demo` actor has no production role. Unknown credentials, expired sessions and destroyed sessions return 401. Cross-business `X-Business-Id` returns 403. No arbitrary resource read/mutation endpoints exist. Responses use `Cache-Control: no-store`; CORS explicitly includes https://app.bizreplyhq.com.

Frontend should retain the token for refresh on `/conversations` and GET the existing session. Entering `/demo` starts a new session. Retrying a POST should reuse its idempotency key; do not reuse a key after expiry/destroy. A destroyed-key tombstone remains for one day, after which reuse creates a new session. Tokens are opaque 256-bit credentials stored only as SHA-256 hashes; keyed derivation permits returning the same credential for retries without plaintext storage. Rotating JWT_ACCESS_SECRET changes IP/dedupe derivation, but existing opaque tokens remain valid until expiry.

## Limits and cleanup

Creation: 20 requests per IP/hour using existing express-rate-limit infrastructure. Database advisory locks enforce dedupe and the active-per-IP cap across processes. GET/DELETE use existing mutation rate limits. The request-rate store remains per process, matching the existing infrastructure; deployments must keep trusted proxy configuration accurate.

Sprint 1 permits exactly one conversation and one contact, zero messages/appointments or additional leads. No quota bypass is added to production services. Future message endpoints must explicitly enforce tighter demo limits before calling shared domain logic.

TTL is absolute, never extended by reads. Auth updates lastActivityAt. Cleanup processes 100 expired sessions per sweep and retries failed cleanup on subsequent sweeps. Deletes and status changes share a transaction; mismatched owner/account associations fail closed. Business cascades remove domain records, then temporary account and owner are removed. Destroyed session tombstones are purged after one day. Cleanup logs contain isDemo/session IDs, not tokens. Initial business audit metadata labels the demo and is removed with the business.

## Configuration

- DEMO_ENABLED=false (explicit true required in development and production)
- DEMO_SESSION_TTL_MINUTES=60 (1?60)
- DEMO_MAX_ACTIVE_SESSIONS_PER_IP=3 (1?20)
- DEMO_CLEANUP_INTERVAL_SECONDS=60 (10?3600)

## Verification and limits

Run `npm run test:demo`. The database lifecycle suite is opt-in with RUN_DATABASE_INTEGRATION_TESTS=true and requires a migrated disposable PostgreSQL database. It verifies concurrent dedupe, creation, absence of membership/subscription/usage records, expiry, invalidation and cascading deletion. Never target a production database for these tests.

Unit/HTTP tests cover disabled mode, production auth rejection, tenant isolation, expiry, provider suppression, retry reuse, cleanup ownership protection and response contracts. Database migration and real PostgreSQL concurrency/cascade execution still require the integration environment. Realtime remains process-local, as in production SSE. Future global reporting must filter demoSessionId when including all businesses/accounts/users.

Sprint 2 should implement website intake/crawling and extraction, then an explicit internal message ingestion adapter with demo limits and scoped realtime authorization. No crawler, RAG, simulator, message-send endpoint, lead/appointment generation or workspace conversion is implemented here.
