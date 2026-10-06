# Knowledge quality audit

`GET /api/knowledge/quality-audit` uses the existing authentication, business scope and Knowledge manager authorization. It takes no client-selected business ID. The reusable backend API is `knowledgeQualityAuditService.audit(businessId)`; callers must authorize that tenant first.

The read-only repeatable-read audit inspects only PUBLISHED + CLIENT_SENDABLE articles. It returns `businessId`, `findings` (stable code, INFO/WARNING severity, sorted articleIds, suggestedAction), and summary counts: articlesScanned, findings, duplicateGroups, categoryConflictGroups, articlesNeedingReview. Counts of articles needing review are distinct across findings. The HTTP response is private/no-store.

Duplicate detection requires normalized matching titles and matching normalized summary/body or extremely similar five-word sequences. Changed numeric claims and negations cannot be near-duplicates; matching titles alone are insufficient. Category conflicts group case/spacing/punctuation variants. Metadata warnings use only category/title/tag cues and current service names, never inferred relationship IDs. Out-of-domain warnings inspect linked and unlinked articles, requiring sufficient business vocabulary and article text and zero informative lexical overlap with both business anchors and any current linked entity. Generic introductions (including titles naming the business) are exempt only from missing-metadata warnings; their body/summary is still checked for domain mismatch without letting the business name in the title count as evidence. These are conservative review signals, not semantic judgments. Multilingual content and synonyms can need human review.

The audit never edits, merges, archives, deletes, or reindexes content. Estate Ltd and every other tenant require separate human approval for any subsequent changes. Existing retrieval and conversation behavior are untouched. A business with more than 5000 eligible articles receives KNOWLEDGE_AUDIT_LIMIT_EXCEEDED rather than a misleading partial result; pagination/background audit can be added separately if needed.


## Relationship review (2B)

SUSPICIOUS_RELEVANCE_RELATIONSHIP identifies current linked tenant services/policies with no meaningful vocabulary overlap, only when article vocabulary is sufficient (at least eight informative tokens). STALE_RELEVANCE_RELATIONSHIP identifies IDs that do not resolve in the active, unarchived tenant catalog (policies must also be customer-facing). Deleted, inactive, archived, internal-policy and foreign-tenant references are never treated as valid. The finding does not disclose why an ID is unresolvable or any foreign entity data.

Both findings contain `metadata: { relatedServiceIds: string[], relatedPolicyIds: string[] }` with sorted, deduplicated implicated IDs. Valid relationships are supporting evidence rather than an unconditional exemption. A domain mismatch on a linked article explicitly suggests reviewing its existing relationships. Nothing is removed or rewritten, and no audit finding authorizes retrieval or workflow effects. Vocabulary matching remains conservative and cannot establish semantic irrelevance; human review is required.


## Missing metadata precision (2C)

Generic Customer Service, Customer Support, Support and General Information categories do not imply an operational relationship. Missing-metadata warnings now require an explicit operational title/tag (payment, deposit, refund, cancellation, pricing, fees or appointment), or a whole-phrase reference to a current tenant service name or customer-facing policy title. Non-generic categories may supply that catalog reference. Bare service/policy words alone are insufficient. Company-introduction exemptions still apply. All other audit findings and read-only behavior are unchanged.


## Explicit review and remediation (3A)

The audit remains read-only. Every finding now has a deterministic SHA-256 `findingKey`, sorted `articleRevisions: [{ articleId, updatedAt }]`, and `reviewStatus: OPEN | DISMISSED`. The fingerprint includes the tenant, code, sorted affected IDs, relationship metadata and current article revisions/content. Review annotations are excluded from the hash. Editing an affected article invalidates its previous fingerprint and dismissal. Dismissed findings remain visible and counted; no implicit resolved status is stored.

`POST /api/knowledge/quality-audit/resolve` uses the existing manager permission check and mutation limiter. Tenant scope comes exclusively from authentication. A nonempty `Idempotency-Key` header (maximum 200 characters) is mandatory. Strict request variants:

- `DISMISS`: findingKey, optional note.
- `UPDATE_CATEGORY`: findingKey, articleId, expectedArticleUpdatedAt, explicit category, optional note.
- `UPDATE_RELATIONSHIPS`: findingKey, articleId, expectedArticleUpdatedAt, complete desired relatedServiceIds and relatedPolicyIds arrays, optional note.
- `ARCHIVE_ARTICLE`: findingKey, explicit articleId, expectedArticleUpdatedAt, optional note.

No default article, category or relationships are selected. Notes are bounded to 1000 characters. Relationship arrays must be unique, explicit and bounded to 50 each. Current active/unarchived tenant services and active/unarchived customer-facing policies are required. The same finding can be corrected after dismissal using a new request key if it remains current.

Resolution reloads the audit, validates the selected article revision, locks all affected article rows in sorted order, then recomputes the finding inside the mutation transaction. Explicit relationship targets are tenant-scoped and share-locked against archival/deactivation. The canonical article update/status paths use an optional updatedAt compare-and-swap guard; existing callers remain compatible. The article change and immutable review/idempotency receipt commit together. A failed receipt rolls back the article change. Existing cache invalidation, audit log and realtime behavior are retained; embedding sync is scheduled immediately after commit, before fallible cache work. DISMISS only writes a review receipt and never schedules embeddings.

`KnowledgeQualityReview` stores business scope, finding fingerprint/code, explicit action, hashed idempotency key, request checksum, actor user/membership IDs, note, created timestamp and result snapshot. Uniqueness is `(businessId, idempotencyKey)`. Multiple explicit decisions can reference the same fingerprint; any DISMISS receipt annotates that exact fingerprint only. Reusing a key for a different payload returns KNOWLEDGE_QUALITY_IDEMPOTENCY_CONFLICT. Replay returns the committed result even after the finding disappears. No failed reservation is left behind.

Responses include action, selected articleId (null for dismissal), updatedAt/status where applicable, originalFindingStillAppears (exact fingerprint presence) and fresh relevant findings. A changed fingerprint does not imply the underlying issue is fixed: remaining problems appear as fresh findings. Fresh-audit errors can be retried with the same request key without applying the mutation again.

Stable conflict codes: KNOWLEDGE_QUALITY_FINDING_STALE and KNOWLEDGE_QUALITY_ARTICLE_STALE. Invalid current relationships return KNOWLEDGE_QUALITY_RELATIONSHIP_INVALID (the canonical preflight can also return its existing VALIDATION_ERROR). No client-supplied business scope is accepted.

Deployment: apply migration `20261006160000_knowledge_quality_review` before serving the updated audit/remediation endpoints, then regenerate Prisma as part of the normal deployment process. This patch does not apply the migration to a live database or remediate Estate Ltd records. Focused tests use an in-memory transactional fixture around the real audit and canonical mutation methods; live PostgreSQL lock behavior still warrants deployment-environment verification. Existing post-commit cache/realtime infrastructure remains best-effort; this patch adds no outbox or background repair subsystem.
