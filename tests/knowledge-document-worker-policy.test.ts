import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryKnowledgeDocumentJob,
  knowledgeDocumentBusinessIsProcessable,
  knowledgeDocumentCompletionAllowed,
  knowledgeDocumentCompletionUpdatesSucceeded,
  knowledgeDocumentJobCanBeClaimed,
  knowledgeDocumentJobIsStale,
  knowledgeDocumentJobOwnershipMatches,
  knowledgeDocumentProcessingFailureIsRetryable,
  knowledgeDocumentProcessingJobIdFromBatchId,
  knowledgeDocumentRetryAt,
  processKnowledgeDocumentBusinessFairBatch,
} from "../src/services/knowledge-document/knowledge-document-worker-policy";
import { decideStaleUploadReconciliation } from "../src/services/knowledge-document/knowledge-document-upload-reconciliation-policy";
import {
  knowledgeDocumentStorageDeletionCanBeClaimed,
  knowledgeDocumentStorageDeletionRetryAt,
} from "../src/services/knowledge-document/knowledge-document-storage-cleanup-policy";
import {
  KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION,
  knowledgeDocumentExtractionIsReusable,
  knowledgeDocumentExtractionRequiresRefresh,
} from "../src/services/knowledge-document/knowledge-document-extraction-policy";
import {
  buildKnowledgeDocumentChunks,
  KNOWLEDGE_DOCUMENT_CHUNK_LIMIT,
  KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS,
} from "../src/services/knowledge-document/knowledge-document-chunking";

test("analyzed document sections rebuild bounded runtime chunks with source pages", () => {
  const chunks = buildKnowledgeDocumentChunks({
    normalizedText: "fallback",
    sections: [
      { text: "First policy paragraph.", sourceLabel: "Page 1", pageNumber: 1 },
      { text: "Second policy paragraph.", sourceLabel: "Page 1", pageNumber: 1 },
      { text: "A".repeat(3_000), sourceLabel: "Page 2", pageNumber: 2 },
    ],
  });
  assert.equal(chunks[0]?.pageNumber, 1);
  assert.match(chunks[0]?.chunkText ?? "", /Page 1/);
  assert.ok(chunks.some((chunk) => chunk.pageNumber === 2));
  assert.ok(chunks.every((chunk) => chunk.chunkText.length <= KNOWLEDGE_DOCUMENT_CHUNK_MAX_CHARACTERS));
  assert.ok(chunks.every((chunk) => chunk.tokenCount > 0));
  assert.ok(chunks.length <= KNOWLEDGE_DOCUMENT_CHUNK_LIMIT);
});

test("chunk rebuilding falls back to normalized extraction text", () => {
  assert.deepEqual(buildKnowledgeDocumentChunks({
    normalizedText: "Fallback extracted content",
    sections: [],
  }), [{
    chunkText: "Fallback extracted content",
    pageNumber: null,
    tokenCount: 7,
  }]);
});

test("completed extraction reuse requires the current extraction security policy", () => {
  const current = {
    status: "COMPLETED",
    extractorVersion: KNOWLEDGE_DOCUMENT_EXTRACTION_POLICY_VERSION,
    normalizedText: "Approved business content",
    contentHash: "content-hash",
  };
  assert.equal(knowledgeDocumentExtractionIsReusable(current), true);
  assert.equal(knowledgeDocumentExtractionIsReusable({ ...current, extractorVersion: "knowledge-text-v1" }), false);
  assert.equal(knowledgeDocumentExtractionIsReusable({ ...current, extractorVersion: null }), false);
  assert.equal(knowledgeDocumentExtractionIsReusable({ ...current, normalizedText: null }), false);
  assert.equal(knowledgeDocumentExtractionIsReusable({ ...current, status: "PROCESSING" }), false);
  assert.equal(knowledgeDocumentExtractionRequiresRefresh(null), true);
  assert.equal(knowledgeDocumentExtractionRequiresRefresh(current), false);
  assert.equal(knowledgeDocumentExtractionRequiresRefresh({
    status: "COMPLETED",
    extractorVersion: "knowledge-text-v1",
  }), true);
  assert.equal(knowledgeDocumentExtractionRequiresRefresh({
    status: "PROCESSING",
    extractorVersion: "knowledge-text-v1",
  }), false);
});

test("processing retries use bounded exponential backoff", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(1, now).toISOString(), "2026-07-31T12:01:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(4, now).toISOString(), "2026-07-31T12:08:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(20, now).toISOString(), "2026-07-31T13:00:00.000Z");
  assert.equal(canRetryKnowledgeDocumentJob(4, 5), true);
  assert.equal(canRetryKnowledgeDocumentJob(5, 5), false);
});

test("knowledge processing is restricted to active non-deleted businesses", () => {
  assert.equal(knowledgeDocumentBusinessIsProcessable({ status: "ACTIVE", deletedAt: null }), true);
  assert.equal(knowledgeDocumentBusinessIsProcessable({ status: "SUSPENDED", deletedAt: null }), false);
  assert.equal(knowledgeDocumentBusinessIsProcessable({ status: "PENDING_SETUP", deletedAt: null }), false);
  assert.equal(knowledgeDocumentBusinessIsProcessable({ status: "ACTIVE", deletedAt: new Date() }), false);
});

test("replacement, ownership, and unresolved AI reconciliation states remain parked", () => {
  assert.equal(knowledgeDocumentProcessingFailureIsRetryable("KNOWLEDGE_DOCUMENT_PROCESSING_STATE_CHANGED"), false);
  assert.equal(knowledgeDocumentProcessingFailureIsRetryable("KNOWLEDGE_DOCUMENT_PROCESSING_SCOPE_MISMATCH"), false);
  assert.equal(knowledgeDocumentProcessingFailureIsRetryable("KNOWLEDGE_DOCUMENT_AI_RESULT_RECONCILIATION_REQUIRED"), false);
  assert.equal(knowledgeDocumentProcessingFailureIsRetryable("AI_PROVIDER_ERROR"), true);
});

test("AI usage processing batch IDs resolve only valid job attempts", () => {
  assert.equal(knowledgeDocumentProcessingJobIdFromBatchId("job-123:2"), "job-123");
  assert.equal(knowledgeDocumentProcessingJobIdFromBatchId("job-123:0"), null);
  assert.equal(knowledgeDocumentProcessingJobIdFromBatchId("job-123:not-a-number"), null);
  assert.equal(knowledgeDocumentProcessingJobIdFromBatchId("missing-attempt"), null);
});

test("storage deletion retries are due-aware and bounded", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(knowledgeDocumentStorageDeletionRetryAt(1, now).toISOString(), "2026-07-31T12:01:00.000Z");
  assert.equal(knowledgeDocumentStorageDeletionRetryAt(20, now).toISOString(), "2026-08-01T12:00:00.000Z");
  assert.equal(knowledgeDocumentStorageDeletionCanBeClaimed({
    status: "SCHEDULED",
    attemptCount: 0,
    maximumAttempts: 10,
    scheduledFor: now,
    nextAttemptAt: null,
    now,
  }), true);
  assert.equal(knowledgeDocumentStorageDeletionCanBeClaimed({
    status: "FAILED",
    attemptCount: 10,
    maximumAttempts: 10,
    scheduledFor: now,
    nextAttemptAt: now,
    now,
  }), false);
});

test("only due queued and retryable failed jobs can be claimed", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(knowledgeDocumentJobCanBeClaimed({ status: "QUEUED", attemptCount: 0, maximumAttempts: 5, nextAttemptAt: null, now }), true);
  assert.equal(knowledgeDocumentJobCanBeClaimed({ status: "FAILED", attemptCount: 1, maximumAttempts: 5, nextAttemptAt: new Date("2026-07-31T11:59:00.000Z"), now }), true);
  assert.equal(knowledgeDocumentJobCanBeClaimed({ status: "FAILED", attemptCount: 1, maximumAttempts: 5, nextAttemptAt: null, now }), false);
  assert.equal(knowledgeDocumentJobCanBeClaimed({ status: "FAILED", attemptCount: 5, maximumAttempts: 5, nextAttemptAt: now, now }), false);
  assert.equal(knowledgeDocumentJobCanBeClaimed({ status: "PROCESSING", attemptCount: 1, maximumAttempts: 5, nextAttemptAt: null, now }), false);
});

test("deletion or ownership changes prevent processing completion", () => {
  const lease = new Date("2026-07-31T12:00:00.000Z");
  const base = {
    expectedProcessingStartedAt: lease,
    currentProcessingStartedAt: lease,
  };
  assert.equal(knowledgeDocumentCompletionAllowed({ ...base, jobStatus: "PROCESSING", documentDeleted: false, ownershipMatches: true }), true);
  assert.equal(knowledgeDocumentCompletionAllowed({ ...base, jobStatus: "PROCESSING", documentDeleted: true, ownershipMatches: true }), false);
  assert.equal(knowledgeDocumentCompletionAllowed({ ...base, jobStatus: "PROCESSING", documentDeleted: false, ownershipMatches: false }), false);
  assert.equal(knowledgeDocumentCompletionAllowed({ ...base, jobStatus: "FAILED", documentDeleted: false, ownershipMatches: true }), false);
});

test("unsupported extraction completes only when job, document, and version all transition", () => {
  assert.equal(knowledgeDocumentCompletionUpdatesSucceeded({
    jobCount: 1,
    documentCount: 1,
    versionCount: 1,
  }), true);
  assert.equal(knowledgeDocumentCompletionUpdatesSucceeded({
    jobCount: 1,
    documentCount: 0,
    versionCount: 1,
  }), false);
  assert.equal(knowledgeDocumentCompletionUpdatesSucceeded({
    jobCount: 1,
    documentCount: 1,
    versionCount: 0,
  }), false);
  assert.equal(knowledgeDocumentCompletionUpdatesSucceeded({
    jobCount: 0,
    documentCount: 1,
    versionCount: 1,
  }), false);
});

test("a stale processing attempt cannot complete a newer retry claim", () => {
  assert.equal(knowledgeDocumentCompletionAllowed({
    jobStatus: "PROCESSING",
    documentDeleted: false,
    ownershipMatches: true,
    expectedProcessingStartedAt: new Date("2026-07-31T12:00:00.000Z"),
    currentProcessingStartedAt: new Date("2026-07-31T12:10:00.000Z"),
  }), false);
});

test("stale recovery applies only to processing attempts older than the cutoff", () => {
  const cutoff = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(knowledgeDocumentJobIsStale(new Date("2026-07-31T11:59:59.999Z"), cutoff), true);
  assert.equal(knowledgeDocumentJobIsStale(cutoff, cutoff), false);
  assert.equal(knowledgeDocumentJobIsStale(null, cutoff), false);
});

test("processing rejects mismatched business, document, and active-version ownership", () => {
  const valid = {
    jobBusinessId: "business-1",
    jobDocumentId: "document-1",
    jobVersionId: "version-1",
    documentBusinessId: "business-1",
    activeVersionId: "version-1",
    versionBusinessId: "business-1",
    versionDocumentId: "document-1",
    versionId: "version-1",
    versionIsActive: true,
  };
  assert.equal(knowledgeDocumentJobOwnershipMatches(valid), true);
  assert.equal(knowledgeDocumentJobOwnershipMatches({ ...valid, versionBusinessId: "business-2" }), false);
  assert.equal(knowledgeDocumentJobOwnershipMatches({ ...valid, versionDocumentId: "document-2" }), false);
  assert.equal(knowledgeDocumentJobOwnershipMatches({ ...valid, activeVersionId: "version-2" }), false);
  assert.equal(knowledgeDocumentJobOwnershipMatches({ ...valid, versionIsActive: false }), false);
});

test("processing gives each eligible business a turn before returning to a backlog", async () => {
  const queue = [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `a-${index}`, businessId: "business-a" })),
    { id: "b-1", businessId: "business-b" },
    { id: "c-1", businessId: "business-c" },
  ];
  const processed: string[] = [];
  await processKnowledgeDocumentBusinessFairBatch({
    limit: 5,
    claim: async (excluded) => {
      const index = queue.findIndex((job) => !excluded.has(job.businessId));
      return index < 0 ? null : queue.splice(index, 1)[0]!;
    },
    process: async (job) => { processed.push(job.businessId); },
  });
  assert.deepEqual(processed, ["business-a", "business-b", "business-c", "business-a", "business-a"]);
});

test("fair processing still fills the batch when only two businesses have work", async () => {
  const queue = [
    { id: "a-1", businessId: "business-a" },
    { id: "a-2", businessId: "business-a" },
    { id: "a-3", businessId: "business-a" },
    { id: "b-1", businessId: "business-b" },
    { id: "b-2", businessId: "business-b" },
  ];
  const processed: string[] = [];
  const count = await processKnowledgeDocumentBusinessFairBatch({
    limit: 5,
    claim: async (excluded) => {
      const index = queue.findIndex((job) => !excluded.has(job.businessId));
      return index < 0 ? null : queue.splice(index, 1)[0]!;
    },
    process: async (job) => { processed.push(job.id); },
  });
  assert.equal(count, 5);
  assert.deepEqual(processed, ["a-1", "b-1", "a-2", "b-2", "a-3"]);
});

const staleUpload = {
  ownershipMatches: true,
  expectedObjectKey: "businesses/business-1/knowledge/document-1/versions/version-1/file.pdf",
  documentObjectKey: "businesses/business-1/knowledge/document-1/versions/version-1/file.pdf",
  versionObjectKey: "businesses/business-1/knowledge/document-1/versions/version-1/file.pdf",
  expectedFileSize: 512,
};

test("a crash before object upload removes the incomplete database record", () => {
  assert.deepEqual(decideStaleUploadReconciliation({
    ...staleUpload,
    storage: { state: "MISSING" },
  }), { action: "REMOVE_INCOMPLETE" });
});

test("a crash after object upload recovers the same version into the processing queue", () => {
  assert.deepEqual(decideStaleUploadReconciliation({
    ...staleUpload,
    storage: { state: "PRESENT", fileSize: 512 },
  }), { action: "QUEUE" });
});

test("a crash before queue creation queues the verified deterministic object", () => {
  assert.deepEqual(decideStaleUploadReconciliation({
    ...staleUpload,
    storage: { state: "PRESENT", fileSize: 512 },
  }), { action: "QUEUE" });
});

test("a stale replacement uses its version key while the document retains the previous active key", () => {
  assert.deepEqual(decideStaleUploadReconciliation({
    ...staleUpload,
    documentObjectKey: "businesses/business-1/knowledge/document-1/versions/version-old/file.pdf",
    requireDocumentObjectKeyMatch: false,
    storage: { state: "PRESENT", fileSize: 512 },
  }), { action: "QUEUE" });
});

test("reconciliation never deletes an object referenced through a mismatched key", () => {
  assert.deepEqual(decideStaleUploadReconciliation({
    ...staleUpload,
    versionObjectKey: "businesses/another-business/knowledge/private.pdf",
    storage: { state: "PRESENT", fileSize: 512 },
  }), {
    action: "FAIL",
    errorCode: "KNOWLEDGE_DOCUMENT_STORAGE_KEY_MISMATCH",
    deleteExpectedObject: false,
  });
});
