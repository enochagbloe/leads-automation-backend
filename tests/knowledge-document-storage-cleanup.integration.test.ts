import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentRetentionStatus,
  KnowledgeDocumentStatus,
  KnowledgeDocumentStorageDeletionJobStatus,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { processKnowledgeDocumentStorageDeletionJob } from "../src/services/knowledge-document/knowledge-document-storage-cleanup.service";

test("failed storage deletion retains references and a confirmed retry purges them", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const business = await prisma.business.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  assert.ok(business, "This integration test requires one test business.");
  const businessId = business.id;
  const suffix = crypto.randomUUID();
  const documentId = `storage-cleanup-document-${suffix}`;
  const versionId = `storage-cleanup-version-${suffix}`;
  const jobId = `storage-cleanup-job-${suffix}`;
  const objectKey = `businesses/${businessId}/knowledge/${documentId}/versions/${versionId}/document.pdf`;
  const now = new Date();

  await prisma.knowledgeDocument.create({
    data: {
      id: documentId,
      businessId,
      title: `Storage cleanup test ${suffix}`,
      fileUrl: `/api/business/knowledge/documents/${documentId}/download`,
      fileKey: objectKey,
      fileName: "document.pdf",
      originalFileName: "document.pdf",
      safeFileName: "document.pdf",
      fileExtension: "pdf",
      mimeType: "application/pdf",
      fileSize: 128,
      checksum: suffix,
      storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
      storageObjectKey: objectKey,
      status: KnowledgeDocumentStatus.DELETED,
      deletedAt: now,
      processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
      retentionStatus: KnowledgeDocumentRetentionStatus.PENDING_DELETION,
      retentionExpiresAt: now,
      versions: {
        create: {
          id: versionId,
          versionNumber: 1,
          originalFileName: "document.pdf",
          safeFileName: "document.pdf",
          fileExtension: "pdf",
          storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
          storageObjectKey: objectKey,
          fileSize: 128,
          mimeType: "application/pdf",
          checksum: suffix,
          processingStatus: KnowledgeDocumentProcessingStatus.FAILED,
          isActive: true,
        },
      },
    },
  });
  await prisma.knowledgeDocument.update({
    where: { id: documentId },
    data: { activeVersionId: versionId },
  });
  await prisma.knowledgeDocumentStorageDeletionJob.create({
    data: {
      id: jobId,
      businessId,
      documentId,
      versionId,
      storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
      storageObjectKey: objectKey,
      status: KnowledgeDocumentStorageDeletionJobStatus.SCHEDULED,
      scheduledFor: now,
      nextAttemptAt: now,
    },
  });

  try {
    await processKnowledgeDocumentStorageDeletionJob(jobId, {
      async deleteFile() {
        throw new Error("simulated storage outage");
      },
      async statFile() {
        return { fileSize: 128 };
      },
    });

    const failed = await prisma.knowledgeDocumentStorageDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
    const retainedVersion = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: versionId } });
    const failedDocument = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(failed.status, KnowledgeDocumentStorageDeletionJobStatus.FAILED);
    assert.equal(failed.attemptCount, 1);
    assert.equal(retainedVersion.storageObjectKey, objectKey);
    assert.equal(retainedVersion.storageDeletedAt, null);
    assert.equal(failedDocument.retentionStatus, KnowledgeDocumentRetentionStatus.DELETION_FAILED);

    await prisma.knowledgeDocumentStorageDeletionJob.update({
      where: { id: jobId },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    let deleteAttempts = 0;
    await processKnowledgeDocumentStorageDeletionJob(jobId, {
      async deleteFile() {
        deleteAttempts += 1;
      },
      async statFile() {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      },
    });

    const completed = await prisma.knowledgeDocumentStorageDeletionJob.findUniqueOrThrow({ where: { id: jobId } });
    const purgedVersion = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: versionId } });
    const purgedDocument = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(deleteAttempts, 1);
    assert.equal(completed.status, KnowledgeDocumentStorageDeletionJobStatus.COMPLETED);
    assert.equal(completed.storageObjectKey, objectKey);
    assert.equal(completed.attemptCount, 2);
    assert.equal(purgedVersion.storageObjectKey, null);
    assert.ok(purgedVersion.storageDeletedAt);
    assert.equal(purgedDocument.retentionStatus, KnowledgeDocumentRetentionStatus.PURGED);
    assert.ok(purgedDocument.storageDeletedAt);
    assert.equal(purgedDocument.activeVersionId, null);
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId, businessId } });
  }
});
