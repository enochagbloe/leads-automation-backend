import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryKnowledgeDocumentJob,
  knowledgeDocumentCompletionAllowed,
  knowledgeDocumentJobCanBeClaimed,
  knowledgeDocumentJobIsStale,
  knowledgeDocumentJobOwnershipMatches,
  knowledgeDocumentRetryAt,
} from "../src/services/knowledge-document/knowledge-document-worker-policy";
import { decideStaleUploadReconciliation } from "../src/services/knowledge-document/knowledge-document-upload-reconciliation-policy";
import {
  knowledgeDocumentStorageDeletionCanBeClaimed,
  knowledgeDocumentStorageDeletionRetryAt,
} from "../src/services/knowledge-document/knowledge-document-storage-cleanup-policy";

test("processing retries use bounded exponential backoff", () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(1, now).toISOString(), "2026-07-31T12:01:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(4, now).toISOString(), "2026-07-31T12:08:00.000Z");
  assert.equal(knowledgeDocumentRetryAt(20, now).toISOString(), "2026-07-31T13:00:00.000Z");
  assert.equal(canRetryKnowledgeDocumentJob(4, 5), true);
  assert.equal(canRetryKnowledgeDocumentJob(5, 5), false);
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
