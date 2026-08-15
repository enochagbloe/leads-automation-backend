import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeDocumentQueryPolicy } from "../src/services/knowledge-document/knowledge-document-query.service";

function assertFieldsExcluded(selection: object, fields: string[]) {
  for (const field of fields) assert.equal(field in selection, false, `${field} must not be publicly selected`);
}

test("public document queries exclude storage metadata", () => {
  assertFieldsExcluded(knowledgeDocumentQueryPolicy.publicDocumentFields, [
    "businessId",
    "fileUrl",
    "fileKey",
    "safeFileName",
    "fileExtension",
    "storageProvider",
    "storageObjectKey",
    "checksum",
    "activeVersionId",
    "uploadedByUserId",
    "uploadedByMembershipId",
    "retentionStatus",
    "retentionExpiresAt",
    "storageDeletedAt",
  ]);
});

test("public version queries exclude storage, scanner, and idempotency metadata", () => {
  assertFieldsExcluded(knowledgeDocumentQueryPolicy.publicVersionSummarySelect, [
    "businessId",
    "documentId",
    "safeFileName",
    "fileExtension",
    "storageProvider",
    "storageObjectKey",
    "checksum",
    "malwareScanStatus",
    "malwareScannedAt",
    "malwareScanner",
    "uploadedByUserId",
    "uploadedByMembershipId",
    "processingErrorCode",
    "processingErrorMessage",
    "uploadIdempotencyKey",
    "storageDeletedAt",
  ]);
});

test("public detail excludes extraction and AI provider internals", () => {
  const detail = knowledgeDocumentQueryPolicy.publicActiveVersionDetailSelect as {
    extraction: { select: object };
    analysis: { select: object };
  };
  assertFieldsExcluded(detail.extraction.select, [
    "extractorName",
    "extractorVersion",
    "normalizedText",
    "contentHash",
  ]);
  assertFieldsExcluded(detail.analysis.select, [
    "analyzerName",
    "analyzerVersion",
    "provider",
    "model",
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "providerResultSnapshot",
    "providerResultContentHash",
    "providerUsageReservationKey",
    "providerCheckpointedAt",
  ]);
});
