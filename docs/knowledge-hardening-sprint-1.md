# Knowledge Hardening Sprint 1

Retrieval revalidates every candidate against current tenant-scoped source data before ranking. Articles require published/customer-sendable status and matching indexed text. Chunks additionally require active, ready, approved, non-deleted, non-superseded documents with an active version and the existing all-facts-approved policy. Facts still load exclusively through the customer-safe fact loader, with an additional current parent/document-version check. Individually approved fact indexing remains available under the existing indexing policy; runtime retrieval is stricter about parent approval/readiness.

Groundings carry current category, related service/policy IDs where applicable, updated timestamp and document version ID. These are internal relevance metadata: the conversation adapter does not put these IDs into customer text.

Optional hints are serviceId, policyId and category. All candidates must first meet the unchanged semantic threshold. Ranking adds at most 0.06: 0.04 for the linked service, 0.01 for policy and 0.01 for category. Raw semantic scores remain unchanged. This bounded boost favors close semantic matches without forcing weak metadata matches. Generic knowledge remains eligible.

All bounded candidates (at most 32) are revalidated. Duplicate normalized titles and complete indexed content, including conservative near-duplicate comparison preserving numeric differences, collapse before topK selection. Newest current source wins, with deterministic source/fragment ID tie-breaks. No user content is deleted.

The conversation adapter sends a catalog-validated service hint only for fresh, scoped, active/waiting, unambiguous context. New primary goals, paused/stale/foreign contexts and unrelated questions cannot inherit the old hint. Current-message service changes use only the new catalog service. Demo bypass and the two-call conversation pipeline remain unchanged.

Lifecycle inspection: article edits/publication changes schedule sync; document edits and lifecycle operations sync; replacement queues runtime refresh for both old and new documents. Sync now explicitly empties superseded/inactive-version sources atomically. Existing preparation failure and source-snapshot checks remain intact. Grounding rejects obsolete sources even while asynchronous refresh is pending.

Verification covers metadata ranking, integrity, newest duplicate selection, lifecycle sync, scoped hints, existing local-language queries and conversation regressions. Tests use controlled providers and database fixtures. Live evaluation is still needed on larger tenant catalogs to assess the ranking boost and bounded candidate recall. No threshold, provider/model, schema or workflow permission changes were made. Content equality is checked against the existing bounded embedding representation, not a new full-document fingerprint.
