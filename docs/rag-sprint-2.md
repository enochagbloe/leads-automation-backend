# RAG Sprint 2: safe semantic retrieval

`knowledgeRetrievalService.retrieve({ businessId, query, topK? })` is standalone.
No route, conversation runtime, provider registration, prompt, planner or response
integration is added. It reuses the existing embedding service and Knowledge Hub
source policies, including the approved-fact loader used by runtime-knowledge.provider.

## Contract

- Required trimmed businessId and query; query length 1–2000 characters.
- Default topK 4, accepted integer range 1–8. Invalid inputs throw
  KNOWLEDGE_RETRIEVAL_INPUT_INVALID before any provider/database call.
- Bounded overfetch: topK × 4 candidates, never more than 32.
- KNOWLEDGE_SEMANTIC_MIN_SCORE defaults to 0.78 (inclusive cosine similarity).
  Configure between 0 and 1. This is an explicit conservative initial cutoff,
  not an empirically calibrated quality guarantee.
- Return `{ status, matches }`, with MATCHES_FOUND, NO_RELEVANT_KNOWLEDGE or
  RETRIEVAL_UNAVAILABLE. The latter two have empty arrays; any provider/vector DB/
  source-validation failure discards partial results. No generated fallback facts.
- Each match has sourceType, sourceId, title (max 200 characters), text (max 900),
  pageNumber or null, score and retrieval="semantic". Chunks have chunkId;
  facts have factId. DOCUMENT_FACT sourceId is the document ID.

## Authorization and grounding

Embedding candidates are never authority. Both the vector SQL and current-source
queries use businessId. Rows from a different tenant are discarded again in code.

Articles must currently be PUBLISHED and CLIENT_SENDABLE. Chunks must belong to
the requested document and business; their current document must be nondeleted,
ACTIVE, READY, APPROVED and CLIENT_SENDABLE, satisfying the shared active-version
all-facts-approved policy. Facts are loaded only with loadCustomerSafeKnowledgeFacts,
which owns approval, active analyzed version, blocking-review and linked-service
validation. The fact/document IDs must match the candidate.

Text comes from the current source. Its embedding input must still equal the indexed
content using the same bounded text builders as indexing; changed sources are omitted
until resynced. Scores are finite, above threshold and at most 1. Candidates are sorted
by descending score and deduplicated by source type/document-or-article ID/chunk-or-fact
ID. The index query uses the configured embedding model so incompatible vector spaces
are not compared. No source can trigger workflow actions here.

The existing embedding `search` API continues returning only article/chunk assets.
`searchCandidates` explicitly adds facts and reports unavailable embeddings through
errors, allowing retrieval to distinguish unavailability from no match. Existing
Knowledge asset search retains its lexical fallback behavior.

## Verification and limits

Run:

```text
pnpm test:knowledge-embeddings
pnpm test:knowledge-retrieval
pnpm typecheck
pnpm typecheck:tests
```

Tests use controlled embedding responses and scoped database doubles, exercising
actual search, retrieval and fact-policy code. They do not measure live model relevance,
PostgreSQL ANN recall or index latency. Bounded overfetch may yield fewer matches after
governance filtering; this is safe and intentional. A source can change after the read;
future consumers must retain authorization checks at their action/use boundary.
No migration, production backfill or live customer query is run in this sprint.
