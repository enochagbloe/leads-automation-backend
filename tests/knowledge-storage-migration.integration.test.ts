import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  KnowledgeArticleStatus,
  KnowledgeStorageMigrationJobStatus,
  KnowledgeStorageProvider,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { processKnowledgeStorageMigrationJob } from "../src/services/knowledge-storage-migration.service";

test("a failed legacy-source cleanup retries without losing the migrated reference", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const business = await prisma.business.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  assert.ok(business, "This integration test requires one test business.");
  const suffix = crypto.randomUUID();
  const articleId = `storage-migration-article-${suffix}`;
  const jobId = `storage-migration-job-${suffix}`;
  const sourceKey = `${business.id}/article-pdfs/legacy-${suffix}.pdf`;
  const targetKey = `businesses/${business.id}/legacy/${suffix}.pdf`;
  const content = Buffer.from("legacy article PDF");

  await prisma.knowledgeArticle.create({
    data: {
      id: articleId,
      businessId: business.id,
      title: `Storage migration article ${suffix}`,
      body: "Storage migration test.",
      status: KnowledgeArticleStatus.DRAFT,
      pdfFileKey: sourceKey,
      pdfFileUrl: `/api/business/knowledge/articles/${articleId}/download`,
      pdfFileSize: content.byteLength,
      pdfStorageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
      pdfStorageObjectKey: sourceKey,
      lastPdfGeneratedAt: new Date(),
    },
  });
  await prisma.knowledgeStorageMigrationJob.create({
    data: {
      id: jobId,
      businessId: business.id,
      sourceProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
      sourceObjectKey: sourceKey,
      targetProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
      targetObjectKey: targetKey,
      status: KnowledgeStorageMigrationJobStatus.SCHEDULED,
      nextAttemptAt: new Date(),
    },
  });

  let reads = 0;
  let uploads = 0;
  let deletes = 0;
  try {
    await processKnowledgeStorageMigrationJob(jobId, {
      async readBuffer(key, provider) {
        reads += 1;
        assert.equal(key, sourceKey);
        assert.equal(provider, KnowledgeStorageProvider.LOCAL_PRIVATE);
        return content;
      },
      async uploadBuffer(input) {
        uploads += 1;
        assert.equal(input.objectKey, targetKey);
        assert.equal(input.storageProvider, KnowledgeStorageProvider.S3_COMPATIBLE);
        return {
          fileKey: targetKey,
          fileUrl: "",
          fileName: "file.pdf",
          mimeType: input.contentType,
          fileSize: input.buffer.byteLength,
          storageProvider: KnowledgeStorageProvider.S3_COMPATIBLE,
        };
      },
      async statFile() {
        return { fileSize: content.byteLength };
      },
      async deleteFile() {
        deletes += 1;
        throw new Error("simulated local cleanup outage");
      },
    });

    const failed = await prisma.knowledgeStorageMigrationJob.findUniqueOrThrow({ where: { id: jobId } });
    const migrated = await prisma.knowledgeArticle.findUniqueOrThrow({ where: { id: articleId } });
    assert.equal(failed.status, KnowledgeStorageMigrationJobStatus.FAILED);
    assert.equal(migrated.pdfStorageProvider, KnowledgeStorageProvider.S3_COMPATIBLE);
    assert.equal(migrated.pdfStorageObjectKey, targetKey);
    assert.equal(migrated.pdfFileKey, targetKey);
    assert.equal(reads, 1);
    assert.equal(uploads, 1);
    assert.equal(deletes, 1);

    await prisma.knowledgeStorageMigrationJob.update({
      where: { id: jobId },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    await processKnowledgeStorageMigrationJob(jobId, {
      async readBuffer() {
        throw new Error("retry must not read a source with no remaining references");
      },
      async uploadBuffer() {
        throw new Error("retry must not copy an already migrated object");
      },
      async statFile() {
        throw new Error("retry must not restat an already migrated object");
      },
      async deleteFile(key, provider) {
        deletes += 1;
        assert.equal(key, sourceKey);
        assert.equal(provider, KnowledgeStorageProvider.LOCAL_PRIVATE);
      },
    });

    const completed = await prisma.knowledgeStorageMigrationJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(completed.status, KnowledgeStorageMigrationJobStatus.COMPLETED);
    assert.equal(completed.attemptCount, 2);
    assert.equal(reads, 1);
    assert.equal(uploads, 1);
    assert.equal(deletes, 2);
  } finally {
    await prisma.knowledgeStorageMigrationJob.deleteMany({ where: { id: jobId } });
    await prisma.knowledgeArticle.deleteMany({ where: { id: articleId, businessId: business.id } });
  }
});
