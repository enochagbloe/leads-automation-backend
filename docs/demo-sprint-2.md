# Instant demo: Sprint 2

## Delivery and files

Added services: `demo-url.service.ts` (URL policy, DNS and pinned HTTP transport), `demo-crawler.service.ts` (robots, HTML and link selection), `demo-extraction.service.ts` (existing AI completion adapter and validation), `demo-context.service.ts` (schema, summaries and runtime reader), and `demo-setup.service.ts` (validation, claim, replacement, recovery and persistence).

Modified demo routes, rate limiting, session reader/destruction, cleanup worker, and the existing AI completion provider. Added tests in `demo-website.test.ts` and `demo-setup.test.ts`; extended session unit/HTTP and database integration tests. Added htmlparser2, ipaddr.js and robots-parser dependencies and updated the pnpm lockfile.

Migration `20260905140000_demo_website_setup` adds DemoSetupStatus plus setupStatus, setupAttemptId, setupStartedAt, setupCompletedAt and demoContext JSONB on DemoSession. No new production Service, KnowledgeDocument, embedding, quota or subscription records are created. There is one current temporary context per session.

## API and lifecycle

`POST /api/demo/session/setup` takes the demo Bearer token and `{ "businessName": "Acme", "websiteUrl": "https://example.com/" }`. Website is optional; an empty string is treated as omitted. Unknown body fields, invalid names and invalid/unsafe URLs return 400. Names are trimmed plain text (1?120 characters); URL input is capped at 2048 characters. Scope derives exclusively from req.demo, with persisted session/business ownership checked again in each write transaction. The existing WhatsApp provider guards, disabled demo owner and production authentication are unchanged.

The endpoint runs synchronously: up to 20 seconds crawling plus up to 10 seconds extraction, excluding short database work. It returns the ordinary compact session envelope with setupStatus, business info, website crawl metadata and summary counts. GET `/api/demo/session` restores this state without returning HTML, source text or the entire facts object. It remains free of mutation rate limits.

States: WAITING_FOR_BUSINESS ? PROCESSING_WEBSITE ? READY or READY_PARTIAL. READY requires a completed crawl, validated extraction and useful extracted description/services. Missing website, empty/JS-rendered site, denied access, timeout or AI failure permits READY_PARTIAL. FAILED exists in the enum for future terminal setup failures; crawl FAILED is deliberately distinct from usable partial setup.

A database conditional update claims one setup attempt. Concurrent requests receive 409 DEMO_SETUP_IN_PROGRESS. Replacement immediately clears the previous context and website-derived business fields, preserving the existing business/customer/conversation IDs. Final save rechecks session expiry, status, tenant and attempt ID; late completion after destroy/expiry/replacement returns DEMO_SETUP_STALE. No external HTTP/AI work occurs inside database transactions. Setup attempts stale for 60 seconds can be replaced and are recovered by the existing demo worker to READY_PARTIAL; that recovery can take one additional cleanup interval.

## Crawl and SSRF boundaries

Only HTTP/HTTPS on default ports, with no user info; fragments and query strings are removed. Single-label/internal hostnames, trailing-dot aliases, localhost, private/reserved/loopback/link-local/metadata IPv4 and IPv6, IPv4-mapped/transition IPv6 and non-global IPv6 are rejected. WHATWG URL parsing canonicalizes unusual numeric IPv4 spellings before IP classification.

Every request resolves all DNS answers and rejects the entire result if any answer is not public. The connection uses a validated numeric IP directly, retaining the original Host header and TLS servername. There is no second hostname lookup, connection pooling, cookie jar, browser session, environment-proxy transport or TLS verification bypass. Every redirect target is validated and must remain on the initial origin, including robots redirects. At most two redirects per fetch and twelve total HTTP requests are permitted.

Limits: five content pages, depth one, 20 seconds overall, six seconds per HTTP page request including DNS/body, 512 KiB per HTML/plain body, 64 KiB robots, 6,000 text characters per page and 24,000 total. Each response must be HTML or plain text; binary and compressed responses are refused (requests ask for identity encoding). This deliberately avoids decompression bombs and browser execution.

Robots is requested first with BizReplyDemoCrawler/1.0. Explicit denial is honored; 404/410 means absent rules, while robots errors/challenges fail closed to a partial demo. Crawl-delay is honored within the time budget and content requests are serial with at least 250ms spacing. Login/admin/account/cart/checkout/legal/search/blog/tag paths and common binary assets are excluded. Links found on the initial page are prioritized by service/pricing/about/contact/FAQ/booking/solution/appointment text or path, normalized and deduplicated; child links do not expand the crawl.

HTML parsing strips script/style/noscript/svg/iframe/nav/footer/form and hidden content, decodes entities and normalizes whitespace. It captures titles, descriptions, visible content and bounded same-origin links. No access-control, paywall or challenge bypass is attempted.

Transport implementation references: [Node HTTP options](https://nodejs.org/api/http.html#httprequestoptions-callback), [Node DNS lookup](https://nodejs.org/api/dns.html#dnslookuphostname-options-callback), [ipaddr.js classification](https://github.com/whitequark/ipaddr.js), [htmlparser2](https://github.com/fb55/htmlparser2).

## Extraction and temporary context

Reuses aiProvider.generateCompletion, with one provider attempt, a ten-second AbortSignal budget, JSON response format, low temperature, bounded input/output and isDemo/session metadata. The optional signal/maxAttempts completion settings leave existing callers' defaults unchanged. No second AI client is introduced. Demo extraction has no production quota writes, though the provider can still charge for its single request.

The prompt treats websites as untrusted data and demands exact supported phrases, null/empty unknowns and no inferred prices, durations, hours, locations or policies. JSON is parsed with a strict bounded Zod schema. Every returned fact must occur in supplied source text; related service/hour/FAQ fields must occur on the same page. Unsupported or malformed output falls back to deterministic meta description and visible email, preserving user-supplied business name and source titles/descriptions. These checks reduce invention but do not prove semantic relationships between all facts on a page; this remains untrusted temporary demo context.

Facts include industry, description, services, hours, contacts, locations, FAQs and policies. Booking/contact links come from deterministic same-origin link discovery. Missing values remain null/empty, with explicit unknowns including live availability. The entered business name is always authoritative for the demo name. Only name, website, industry and description are copied onto the demo Business; prices, operational rules, timezone and availability are not inferred or written.

No HTML or raw page text is persisted. Retained context is capped at 40,000 JSON characters; a size overflow falls back to minimal metadata. Logging includes only session ID, hostname, status, page count and duration, with no query strings or website body. The internal `demoContextService.getBusinessContext(actor)` validates active ownership and setup readiness and returns the normalized object for Sprint 3. It does not accept frontend resource IDs as authority.

Destroy clears demoContext and setup metadata in the same transaction that deletes domain records. Expiry cleanup uses that same path, so website data is not retained in destroyed-session tombstones.

## Rate limits and operation

Setup allows five requests/session/15 minutes and ten requests/IP/15 minutes, using existing express-rate-limit infrastructure. The database setup claim works across instances; request-rate stores remain per-process like the existing application. No additional environment variables are required. DEMO_ENABLED remains false unless explicitly enabled; the existing TTL and worker interval still apply.

Apply both demo migrations with the existing migration deployment command before running the updated backend. Regenerate Prisma Client normally. No migration is applied automatically by this implementation.

## Verification and remaining work

`npm run test:demo` includes URL/input validation, address classification, mixed DNS rejection, pinned connection destination, private redirects, robots blocking, depth/page/text/body bounds, content types, JS-only fallback, timeout, strict AI output validation, company-only setup, context replacement, concurrent setup, stale-save rejection, tenant rejection and prior Sprint 1 regressions.

Database tests are opt-in with RUN_DATABASE_INTEGRATION_TESTS=true against a migrated disposable PostgreSQL database. Added coverage verifies setup persistence/restore, cross-tenant setup/context rejection, one business after replacement and context erasure during destruction. Verification result: 26 runnable tests passed and four PostgreSQL integration tests were skipped. Application/test typechecks and Prisma schema validation passed. After the reported login failure, both pending demo migrations were deployed to the configured database. A live nonexistent-user lookup using the full login User projection, demo setup recovery, and demo cleanup sweep all succeeded. The four database integration tests remain unrun; this verification did not exercise a real user login or the full setup lifecycle. Prisma generation refreshed generated client code/types but reported Windows EPERM while replacing the native query-engine DLL; regenerate normally after the local engine lock is released. Fixture tests use controlled HTTP/AI results; no live website or paid AI completion is required.

Limitations: no JavaScript rendering; compressed-only sites and cross-origin canonical redirects (including www/HTTPS moves) fall back; no PDF parsing; robots failures are conservative; exact-quote extraction may discard useful paraphrases; rate limiting and realtime remain process-local. This is deliberately small website intake, not exhaustive site indexing or authoritative operational knowledge.

Sprint 3 should add the authorized demo inbound message transport, adapt this normalized context to the existing AI/business-context layer, enforce demo message limits and use session/conversation-scoped realtime delivery. No customer simulator API, AI reply loop, generated leads/appointments, follow-ups, payments, RAG or production conversion is implemented here.
