import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  KnowledgeArticleStatus,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import {
  calculateKnowledgeStorageUsage,
  calculateKnowledgeStorageUsageByBusiness,
} from "../src/services/knowledge-storage-usage.service";

test("retained document versions and generated article PDFs share one storage total", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const business = await prisma.business.findFirst({
    where: { deletedAt: null },
    select: { id: true, businessAccountId: true },
  });
  assert.ok(business, "This integration test requires one test business.");
  const suffix = crypto.randomUUID();
  const documentId = `storage-usage-document-${suffix}`;
  const versionId = `storage-usage-version-${suffix}`;
  const articleId = `storage-usage-article-${suffix}`;
  const versionBytes = 1_337;
  const articlePdfBytes = 733;
  const baseline = await calculateKnowledgeStorageUsage(prisma, business.businessAccountId);

  try {
    await prisma.knowledgeDocument.create({
      data: {
        id: documentId,
        businessId: business.id,
        title: `Storage usage test ${suffix}`,
        fileUrl: `/api/business/knowledge/documents/${documentId}/download`,
        fileKey: `businesses/${business.id}/knowledge/${documentId}/document.pdf`,
        fileName: "document.pdf",
        originalFileName: "document.pdf",
        safeFileName: "document.pdf",
        fileExtension: "pdf",
        mimeType: "application/pdf",
        fileSize: versionBytes,
        checksum: suffix,
        storageProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
        storageObjectKey: `businesses/${business.id}/knowledge/${documentId}/document.pdf`,
        status: KnowledgeDocumentStatus.ACTIVE,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        versions: {
          create: {
            id: versionId,
            versionNumber: 1,
            originalFileName: "document.pdf",
            safeFileName: "document.pdf",
            fileExtension: "pdf",
            storageProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
            storageObjectKey: `businesses/${business.id}/knowledge/${documentId}/document.pdf`,
            fileSize: versionBytes,
            mimeType: "application/pdf",
            checksum: suffix,
            processingStatus: KnowledgeDocumentProcessingStatus.READY,
            isActive: true,
          },
        },
      },
    });
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { activeVersionId: versionId },
    });
    await prisma.knowledgeArticle.create({
      data: {
        id: articleId,
        businessId: business.id,
        title: `Storage usage article ${suffix}`,
        body: "Storage usage test article.",
        status: KnowledgeArticleStatus.DRAFT,
        pdfFileKey: `businesses/${business.id}/article-pdfs/${articleId}.pdf`,
        pdfFileUrl: `/api/business/knowledge/articles/${articleId}/download`,
        pdfFileSize: articlePdfBytes,
        lastPdfGeneratedAt: new Date(),
      },
    });

    const accountUsage = await calculateKnowledgeStorageUsage(prisma, business.businessAccountId);
    const byBusiness = await calculateKnowledgeStorageUsageByBusiness(prisma, business.businessAccountId);
    const businessUsage = byBusiness.get(business.id);
    assert.ok(businessUsage);
    assert.equal(accountUsage.documentVersionBytes - baseline.documentVersionBytes, versionBytes);
    assert.equal(accountUsage.articlePdfBytes - baseline.articlePdfBytes, articlePdfBytes);
    assert.equal(accountUsage.totalBytes - baseline.totalBytes, versionBytes + articlePdfBytes);
    assert.equal(businessUsage.totalBytes, accountUsage.totalBytes);
    assert.equal(accountUsage.unmeasuredArticlePdfCount, baseline.unmeasuredArticlePdfCount);
  } finally {
    await prisma.knowledgeArticle.deleteMany({ where: { id: articleId, businessId: business.id } });
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId, businessId: business.id } });
  }
});
