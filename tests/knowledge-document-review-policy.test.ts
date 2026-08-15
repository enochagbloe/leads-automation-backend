import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeDocumentAnalysisStatus,
  KnowledgeDocumentExtractionStatus,
  KnowledgeDocumentProcessingStatus,
} from "@prisma/client";
import { evaluateKnowledgeDocumentReviewState } from "../src/services/knowledge-document/knowledge-document-review-policy";

const validState = {
  documentProcessingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
  versionProcessingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
  activeVersionId: "version-1",
  expectedVersionId: "version-1",
  versionIsActive: true,
  extractionStatus: KnowledgeDocumentExtractionStatus.COMPLETED,
  analysisStatus: KnowledgeDocumentAnalysisStatus.COMPLETED,
  requiresHumanReview: true,
};

test("a completed active analysis can be approved or rejected", () => {
  assert.deepEqual(evaluateKnowledgeDocumentReviewState(validState), {
    reviewable: true,
    approvable: true,
    reason: null,
  });
});

test("a stale version cannot be reviewed", () => {
  assert.deepEqual(evaluateKnowledgeDocumentReviewState({ ...validState, expectedVersionId: "version-old" }), {
    reviewable: false,
    approvable: false,
    reason: "KNOWLEDGE_DOCUMENT_REVIEW_VERSION_CHANGED",
  });
});

test("an already reviewed document cannot be reviewed again", () => {
  assert.deepEqual(evaluateKnowledgeDocumentReviewState({
    ...validState,
    documentProcessingStatus: KnowledgeDocumentProcessingStatus.READY,
  }), {
    reviewable: false,
    approvable: false,
    reason: "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED",
  });
});

test("unsupported extraction may be rejected but cannot be approved", () => {
  assert.deepEqual(evaluateKnowledgeDocumentReviewState({
    ...validState,
    extractionStatus: KnowledgeDocumentExtractionStatus.UNSUPPORTED,
    analysisStatus: null,
    requiresHumanReview: null,
  }), {
    reviewable: true,
    approvable: false,
    reason: "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPROVABLE",
  });
});
