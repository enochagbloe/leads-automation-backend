# RAG Sprint 3: contextual conversation retrieval

The shared production runtime now runs:

```text
snapshot → interpreter + validated state commands → contextual semantic query
         → existing planner/workflow inspection → bounded response knowledge
         → existing response generator + policy validator
```

The deterministic conversationKnowledgeRetrievalService composes one query (maximum
2000 characters). Current message and canonical intent come first, followed by
current purpose/need, resolved service/reason and, only for short related continuity,
validated serviceNeed/reason and the canonical service name. It adds
generic intent search terms for support, complaint, payment, refund/cancellation,
rescheduling and pricing. There is no customer-phrase or industry keyword router,
no language-model query rewrite and no additional conversational AI stage.

New primary goals, changed services, unrelated topics and ambiguous interpretations
do not inherit an old booking's fields/history. Short payment questions can retain
the current topical anchor. Human requests and complaints retain their prior safety
behavior. No inherited dates, times, location, awaiting field, options, last assistant
question or booking execution state are composed into the query.
Inheritance requires an active/waiting state, matching conversation scope and context
within 30 minutes of the current message. Short means at most 80 characters/eight
words; paused goals are excluded, including pending resume proposals. When no validated
topical anchor exists, at most two bounded recent customer messages provide a fallback;
messages with numeric details or known operational entity values are excluded.
This gating is a conservative deterministic relevance heuristic, not a new intent
system or topic-resume planner.

The adapter calls Sprint 2 retrieval once with topK=8 (bounded diversity candidates),
then collapses normalized title/text duplicates and near-identical editorial copies,
retaining at most four groundings. Distinct numeric claims are not merged. Articles
become knowledgeArticles; document chunks and approved facts become bounded text in
knowledgeDocumentChunks. approvedKnowledgeFacts is cleared rather than promoting
retrieved prose into operational fields. Titles/text remain capped at 200/900 chars.

The planner receives its original context, and retrieval never mutates state,
services, policies, availability, governance guards, plan or trusted execution
results. Before response generation, all three broad knowledge arrays are replaced.
No-match/unavailable outcomes inject empty semantic arrays and do not automatically
request human review. Existing response policy and trusted workflow receipts still
own confirmation/action claims; retrieved prose is not evidence that an action ran.

Demo sessions bypass production semantic retrieval and preserve their website context.
No environment or relevance-threshold change is included; the local evaluation
threshold is left untouched.

Telemetry: conversation_knowledge.retrieved records scope IDs, status, retained count
and duration without message/query text. Request timing includes knowledgeRetrievalMs.

Focused tests exercise query composition, noise/slang using controlled validated
interpretations, history limits, scope, deduplication, bounds, fallback, demo bypass,
and the real interpreter/planner/response runtime order. Shared test fixtures stub
the vector boundary to prevent live provider/DB calls from existing runtime suites.
These are controlled tests, not live language-quality or retrieval-recall evaluation.

Verification commands:

```text
pnpm test:conversation-knowledge-retrieval
pnpm test:knowledge-retrieval
pnpm test:conversation-interpreter
pnpm test:conversation-planner
pnpm test:conversation-response
pnpm typecheck
pnpm typecheck:tests
```

Remaining limits: retrieval can underfill after deduplication; there is no second
search or LLM rewrite. Quality depends on existing interpretation and eligible indexed
sources. Production context loading itself is unchanged; this sprint replaces the
broad arrays at the response boundary rather than redesigning Knowledge Hub loading.
