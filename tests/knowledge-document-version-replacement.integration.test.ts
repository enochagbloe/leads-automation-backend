import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  KnowledgeStorageProvider,
  Prisma,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import {
  activateKnowledgeDocumentReplacement,
  allocateKnowledgeDocumentReplacement,
} from "../src/services/knowledge-document/knowledge-document-version.service";

test("concurrent replacements allocate once and switch one active version atomically", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const business = await prisma.business.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  assert.ok(business, "This integration test requires one test business.");
  const businessId = business.id;
  const suffix = crypto.randomUUID();
  const documentId = `replacement-document-${suffix}`;
  const originalVersionId = `replacement-v1-${suffix}`;
  const baseObjectKey = `businesses/${businessId}/knowledge/${documentId}/versions/${originalVersionId}/original.pdf`;

  await prisma.knowledgeDocument.create({
    data: {
      id: documentId,
      businessId,
      title: `Replacement test ${suffix}`,
      fileUrl: `/api/business/knowledge/documents/${documentId}/download`,
      fileKey: baseObjectKey,
      fileName: "original.pdf",
      originalFileName: "original.pdf",
      safeFileName: "original.pdf",
      fileExtension: "pdf",
      mimeType: "application/pdf",
      fileSize: 10,
      checksum: `original-${suffix}`,
      storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
      storageObjectKey: baseObjectKey,
      status: KnowledgeDocumentStatus.ACTIVE,
      processingStatus: KnowledgeDocumentProcessingStatus.READY,
      versions: {
        create: {
          id: originalVersionId,
          versionNumber: 1,
          originalFileName: "original.pdf",
          safeFileName: "original.pdf",
          fileExtension: "pdf",
          storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
          storageObjectKey: baseObjectKey,
          fileSize: 10,
          mimeType: "application/pdf",
          checksum: `original-${suffix}`,
          processingStatus: KnowledgeDocumentProcessingStatus.READY,
          isActive: true,
        },
      },
    },
  });
  await prisma.knowledgeDocument.update({
    where: { id: documentId },
    data: { activeVersionId: originalVersionId },
  });

  function allocate(label: string, delayAfterAllocation = 0) {
    const versionId = `replacement-${label}-${suffix}`;
    const storageObjectKey = `businesses/${businessId}/knowledge/${documentId}/versions/${versionId}/${label}.pdf`;
    return prisma.$transaction(async (tx) => {
      const result = await allocateKnowledgeDocumentReplacement(tx, {
        businessId,
        documentId,
        uploadedByUserId: "integration-test",
        uploadedByMembershipId: "integration-test",
        uploadIdempotencyKey: null,
        versionId,
        file: {
          originalFileName: `${label}.pdf`,
          safeFileName: `${label}.pdf`,
          extension: "pdf",
          mimeType: "application/pdf",
          fileSize: 20,
          checksum: `${label}-${suffix}`,
          malwareScanStatus: "CLEAN",
          malwareScannedAt: new Date(),
          malwareScanner: "TEST_SCANNER",
          storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
          storageObjectKey,
        },
      });
      if (delayAfterAllocation) {
        await new Promise((resolve) => setTimeout(resolve, delayAfterAllocation));
      }
      return result;
    }, { timeout: 10_000 });
  }

  try {
    const allocations = await Promise.allSettled([
      allocate("a", 100),
      allocate("b"),
    ]);
    const successful = allocations.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof allocate>>> => result.status === "fulfilled");
    const rejected = allocations.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(successful.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.reason?.code, "KNOWLEDGE_DOCUMENT_REPLACEMENT_IN_PROGRESS");

    const allocated = successful[0]!.value;
    assert.equal(allocated.version.versionNumber, 2);
    const switched = await prisma.$transaction((tx) => activateKnowledgeDocumentReplacement(tx, {
      businessId,
      documentId,
      versionId: allocated.version.id,
      previousActiveVersionId: originalVersionId,
      storageProvider: allocated.version.storageProvider,
      storageObjectKey: allocated.version.storageObjectKey!,
    }));
    assert.equal(switched.activeVersionId, allocated.version.id);

    const versions = await prisma.knowledgeDocumentVersion.findMany({
      where: { documentId, businessId },
      orderBy: { versionNumber: "asc" },
      select: { id: true, versionNumber: true, isActive: true },
    });
    assert.deepEqual(versions, [
      { id: originalVersionId, versionNumber: 1, isActive: false },
      { id: allocated.version.id, versionNumber: 2, isActive: true },
    ]);

    await assert.rejects(
      prisma.knowledgeDocumentVersion.update({
        where: { id: originalVersionId },
        data: { isActive: true },
      }),
      (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId, businessId } });
  }
});
