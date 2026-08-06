import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { KnowledgeArticleStatus, KnowledgeDocumentStatus } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { assertKnowledgeAssetCapacityForLimit } from "../src/services/knowledge-hub-capability.service";

test("article and document creation serialize at the final account asset slot", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const owner = await prisma.user.findFirst({
    where: { deletedAt: null },
    select: { id: true },
  });
  assert.ok(owner, "This integration test requires one test user.");

  const suffix = crypto.randomUUID();
  const account = await prisma.businessAccount.create({
    data: {
      name: `Knowledge quota test ${suffix}`,
      ownerId: owner.id,
      businesses: {
        create: {
          name: `Knowledge quota business ${suffix}`,
          industry: "Testing",
          slug: `knowledge-quota-${suffix}`,
          ownerId: owner.id,
          email: `knowledge-quota-${suffix}@example.test`,
        },
      },
    },
    include: { businesses: { select: { id: true } } },
  });
  const businessId = account.businesses[0]?.id;
  assert.ok(businessId);

  const createArticle = prisma.$transaction(async (tx) => {
    await assertKnowledgeAssetCapacityForLimit(tx, {
      businessAccountId: account.id,
      limit: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return tx.knowledgeArticle.create({
      data: {
        businessId,
        title: `Quota article ${suffix}`,
        body: "Quota concurrency test article.",
        status: KnowledgeArticleStatus.DRAFT,
      },
    });
  }, { timeout: 10_000 });

  const createDocument = prisma.$transaction(async (tx) => {
    await assertKnowledgeAssetCapacityForLimit(tx, {
      businessAccountId: account.id,
      limit: 1,
    });
    return tx.knowledgeDocument.create({
      data: {
        businessId,
        title: `Quota document ${suffix}`,
        fileUrl: `/test/${suffix}`,
        fileName: `${suffix}.pdf`,
        originalFileName: `${suffix}.pdf`,
        safeFileName: `${suffix}.pdf`,
        fileExtension: "pdf",
        mimeType: "application/pdf",
        fileSize: 1,
        checksum: suffix,
        status: KnowledgeDocumentStatus.ACTIVE,
      },
    });
  }, { timeout: 10_000 });

  try {
    const results = await Promise.allSettled([createArticle, createDocument]);
    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");

    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal((failures[0] as PromiseRejectedResult).reason?.code, "KNOWLEDGE_ASSET_LIMIT_REACHED");

    const [articles, documents] = await Promise.all([
      prisma.knowledgeArticle.count({ where: { businessId } }),
      prisma.knowledgeDocument.count({ where: { businessId } }),
    ]);
    assert.equal(articles + documents, 1);
  } finally {
    await prisma.businessAccount.delete({ where: { id: account.id } });
  }
});
