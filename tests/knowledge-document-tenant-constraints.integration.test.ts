import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  KnowledgeDocumentAnalysisStatus,
  KnowledgeDocumentDetectedType,
  KnowledgeDocumentExtractionStatus,
  KnowledgeDocumentFactType,
  KnowledgeDocumentProcessingJobStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentSourceKind,
  KnowledgeStorageProvider,
  Prisma,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";

function isForeignKeyViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003";
}

test("database rejects cross-business document, version, job, and active-version links", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const businesses = await prisma.business.findMany({
    where: { deletedAt: null },
    select: { id: true },
    orderBy: { id: "asc" },
    take: 2,
  });
  assert.equal(businesses.length, 2, "This integration test requires two test businesses.");
  const businessA = businesses[0];
  const businessB = businesses[1];
  if (!businessA || !businessB) throw new Error("This integration test requires two test businesses.");

  const suffix = crypto.randomUUID();
  const documentAId = `tenant-document-a-${suffix}`;
  const documentBId = `tenant-document-b-${suffix}`;
  const versionAId = `tenant-version-a-${suffix}`;
  const baseDocument = {
    title: "Tenant constraint test",
    fileUrl: "/test-only",
    fileName: "test.txt",
    mimeType: "text/plain",
    fileSize: 4,
    originalFileName: "test.txt",
    safeFileName: "test.txt",
    fileExtension: "txt",
    checksum: `test:${suffix}`,
    processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
  };

  try {
    await prisma.knowledgeDocument.createMany({
      data: [
        { ...baseDocument, id: documentAId, businessId: businessA.id },
        { ...baseDocument, id: documentBId, businessId: businessB.id },
      ],
    });
    await prisma.knowledgeDocumentVersion.create({
      data: {
        id: versionAId,
        documentId: documentAId,
        businessId: businessA.id,
        versionNumber: 1,
        originalFileName: "test.txt",
        safeFileName: "test.txt",
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 4,
        mimeType: "text/plain",
        checksum: `test:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.UPLOADING,
      },
    });

    await assert.rejects(
      prisma.knowledgeDocumentVersion.create({
        data: {
          id: `tenant-version-invalid-${suffix}`,
          documentId: documentAId,
          businessId: businessB.id,
          versionNumber: 2,
          originalFileName: "test.txt",
          safeFileName: "test.txt",
          fileExtension: "txt",
          storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
          fileSize: 4,
          mimeType: "text/plain",
          checksum: `invalid:${suffix}`,
        },
      }),
      isForeignKeyViolation,
    );

    await assert.rejects(
      prisma.knowledgeDocumentProcessingJob.create({
        data: {
          businessId: businessB.id,
          documentId: documentAId,
          versionId: versionAId,
          status: KnowledgeDocumentProcessingJobStatus.QUEUED,
        },
      }),
      isForeignKeyViolation,
    );

    await assert.rejects(
      prisma.knowledgeDocumentExtraction.create({
        data: {
          businessId: businessB.id,
          documentId: documentAId,
          versionId: versionAId,
          status: KnowledgeDocumentExtractionStatus.COMPLETED,
        },
      }),
      isForeignKeyViolation,
    );

    const extraction = await prisma.knowledgeDocumentExtraction.create({
      data: {
        businessId: businessA.id,
        documentId: documentAId,
        versionId: versionAId,
        status: KnowledgeDocumentExtractionStatus.COMPLETED,
        normalizedText: "Price GHS 100",
        contentHash: crypto.createHash("sha256").update("Price GHS 100").digest("hex"),
      },
    });
    await assert.rejects(
      prisma.knowledgeDocumentExtractedSection.create({
        data: {
          businessId: businessB.id,
          documentId: documentAId,
          versionId: versionAId,
          extractionId: extraction.id,
          ordinal: 0,
          sourceKind: KnowledgeDocumentSourceKind.PAGE,
          text: "Price GHS 100",
        },
      }),
      isForeignKeyViolation,
    );

    const analysis = await prisma.knowledgeDocumentAnalysis.create({
      data: {
        businessId: businessA.id,
        documentId: documentAId,
        versionId: versionAId,
        extractionId: extraction.id,
        status: KnowledgeDocumentAnalysisStatus.COMPLETED,
        detectedDocumentType: KnowledgeDocumentDetectedType.PRICING_INFORMATION,
      },
    });
    await assert.rejects(
      prisma.knowledgeDocumentFact.create({
        data: {
          businessId: businessB.id,
          documentId: documentAId,
          versionId: versionAId,
          analysisId: analysis.id,
          factType: KnowledgeDocumentFactType.PRICE,
          label: "Price",
          valueText: "GHS 100",
          sourceKind: KnowledgeDocumentSourceKind.PAGE,
        },
      }),
      isForeignKeyViolation,
    );

    await assert.rejects(
      prisma.knowledgeDocument.update({
        where: { id: documentBId },
        data: { activeVersionId: versionAId },
      }),
      isForeignKeyViolation,
    );
  } finally {
    await prisma.knowledgeDocument.deleteMany({
      where: { id: { in: [documentAId, documentBId] } },
    });
  }
});
