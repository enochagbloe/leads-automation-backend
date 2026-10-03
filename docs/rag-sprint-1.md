# RAG Sprint 1: existing semantic-index foundation

## Scope

Reuses the SQL-owned KnowledgeSearchEmbedding table, OpenRouter embeddings,
customer-safe document/fact policy and refresh worker. No conversation retrieval,
planner, interpreter, response, chunking or frontend integration is added.

The original migration declares vector(1536), a NULLS NOT DISTINCT source key,
and tenant B-tree indexes. It has no ANN index; the new migration adds HNSW with
vector_cosine_ops, matching existing <=> search. No historical migration or Prisma
model is rewritten. The table remains raw-SQL managed, as before.

Embedding dimensions must be 1536. The provider must return exactly 1536 finite
values with a nonzero norm; oversized vectors are not silently truncated.
Deploy the new migration using the normal migration process. It requires pgvector
with HNSW support (0.5+). Index construction can lock writes; schedule deployment
appropriately for index size. No production migration was applied by this task.

## Explicit backfill

Run one bounded page at a time using an operator-authorized business ID:

```powershell
pnpm exec tsx scripts/backfill-knowledge-embeddings.ts BUSINESS_ID ARTICLE
pnpm exec tsx scripts/backfill-knowledge-embeddings.ts BUSINESS_ID DOCUMENT
# Continue the same kind using its returned nextCursor:
pnpm exec tsx scripts/backfill-knowledge-embeddings.ts BUSINESS_ID DOCUMENT LAST_ID 10
```

The service API is `knowledgeEmbeddingService.backfill(businessId,
{ kind, afterId?, limit? })`. Default page size is 10, maximum 25 sources; documents
retain the existing maximum of 80 chunks/facts. Pages sort by ID, never enumerate
other businesses, and return per-source SYNCED/FAILED outcomes plus nextCursor.
SYNCED includes removal of ineligible vectors. The command exits nonzero if any
source failed. Retry failed IDs with the scoped sync API or rerun that page before
advancing the cursor. A null cursor means the scanned page is finished, not that
all failed sources succeeded. Concurrent additions below the cursor require another
pass. No startup/global backfill is registered. This command incurs embedding calls.

## Governance and atomic replacement

- Published, client-sendable articles are indexed; other article states remove
  their scoped embeddings.
- Active, ready, approved, client-sendable, nondeleted documents whose active
  version satisfies the existing all-facts-approved policy use bounded raw chunks.
- Other documents use only facts returned by loadCustomerSafeKnowledgeFacts:
  approved facts, active analyzed version, eligible document, no blocking review,
  and valid linked services. Unsafe raw chunks never enter that fallback.
- Sync APIs now require businessId explicitly; existing callers pass their source,
  actor or refresh-job tenant. All SQL deletes and upserts retain tenant scope.
- All provider calls finish before replacement. The short serializable transaction
  locks the scoped source (and reuses the document governance lock), reloads its
  version/content/eligibility, and rejects changed sources. Chunk/fact representation
  changes, deletion and inserts commit together. Failure keeps the previous set.
  Serialization conflicts surface for worker/operator retry, never stale overwrite.

Preserved embeddings after a failed refresh do not authorize their use: consumers
must retain existing current-source governance checks. This sprint does not change
search consumers or expose DOCUMENT_FACT retrieval to conversations. Switching
embedding models requires an explicit full reindex; dimensions alone do not make
model vector spaces interchangeable.

## Verification boundaries

Focused tests mock the embedding provider and transaction-aware storage boundary;
there are no live model calls. They assert scoped queries/deletes/inserts, eligibility,
fact fallback, pagination/retry, dimension validation, provider/write rollback and
source changes. The repository's refresh and production/test TypeScript checks are
also run. Live PostgreSQL migration/index construction and ANN recall/performance
are not established by these tests; tenant-filtered ANN may return fewer than the
requested count and must be evaluated before future retrieval integration.
