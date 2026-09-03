import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  BusinessRole,
  KnowledgeDocumentAnalysisStatus,
  KnowledgeDocumentExtractionStatus,
  KnowledgeDocumentFactType,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentSourceKind,
  KnowledgeFactGovernanceStatus,
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernancePriority,
  KnowledgeGovernanceResolutionAction,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  KnowledgeStorageProvider,
  MembershipStatus,
  ServicePriceType,
  SubscriptionStatus,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { knowledgeGovernanceResolutionService } from "../src/services/knowledge-document/knowledge-governance-resolution.service";
import { customerSafeKnowledgeDocumentWhere } from "../src/services/knowledge-document/knowledge-document-runtime-policy";
import { knowledgeDocumentLifecycleService } from "../src/services/knowledge-document/knowledge-document-lifecycle.service";
import { knowledgeDocumentReviewService } from "../src/services/knowledge-document/knowledge-document-review.service";
import { knowledgeEmbeddingService } from "../src/services/knowledge-embedding.service";
import { serviceService } from "../src/services/service.service";
import { AppError } from "../src/utils/errors";

test("human review updates settings once and rejects a stale competing review", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const now = new Date();
  const membership = await prisma.businessMember.findFirst({
    where: {
      role: BusinessRole.BUSINESS_OWNER,
      status: MembershipStatus.ACTIVE,
      business: {
        deletedAt: null,
        businessAccount: {
          subscriptions: {
            some: {
              status: { in: [SubscriptionStatus.ACTIVE, SubscriptionStatus.TRIALING] },
              currentPeriodStart: { lte: now },
              currentPeriodEnd: { gt: now },
              usageRecords: { some: {} },
            },
          },
        },
      },
    },
    select: { id: true, userId: true, businessId: true, business: { select: { businessAccountId: true } } },
  });
  assert.ok(membership, "This integration test requires an active business owner subscription.");

  const suffix = crypto.randomUUID();
  const documentId = `governance-document-${suffix}`;
  const versionId = `governance-version-${suffix}`;
  const serviceId = `governance-service-${suffix}`;
  const actor = {
    userId: membership.userId,
    businessAccountId: membership.business.businessAccountId,
    businessId: membership.businessId,
    membershipId: membership.id,
    role: BusinessRole.BUSINESS_OWNER,
  };

  try {
    await prisma.service.create({
      data: {
        id: serviceId,
        businessId: actor.businessId,
        name: `Governance Consultation ${suffix.slice(0, 8)}`,
        slug: `governance-consultation-${suffix}`,
        basePrice: "400.00",
        currency: "GHS",
        priceType: ServicePriceType.FIXED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.create({
      data: {
        id: documentId,
        businessId: actor.businessId,
        title: "Governance price test",
        fileUrl: "",
        fileName: "governance.txt",
        mimeType: "text/plain",
        fileSize: 20,
        originalFileName: "governance.txt",
        safeFileName: "governance.txt",
        fileExtension: "txt",
        checksum: `governance:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
        governanceStatus: KnowledgeGovernanceStatus.REVIEW_REQUIRED,
      },
    });
    await prisma.knowledgeDocumentVersion.create({
      data: {
        id: versionId,
        documentId,
        businessId: actor.businessId,
        versionNumber: 1,
        originalFileName: "governance.txt",
        safeFileName: "governance.txt",
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 20,
        mimeType: "text/plain",
        checksum: `governance:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
        governanceStatus: KnowledgeGovernanceStatus.REVIEW_REQUIRED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { activeVersionId: versionId } });
    const extraction = await prisma.knowledgeDocumentExtraction.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        status: KnowledgeDocumentExtractionStatus.COMPLETED,
        normalizedText: "Consultation GHS 500",
      },
    });
    const analysis = await prisma.knowledgeDocumentAnalysis.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        extractionId: extraction.id,
        status: KnowledgeDocumentAnalysisStatus.COMPLETED,
        requiresHumanReview: true,
      },
    });
    const facts = await Promise.all(["first", "stale"].map((label) => prisma.knowledgeDocumentFact.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        analysisId: analysis.id,
        factType: KnowledgeDocumentFactType.PRICE,
        label,
        valueText: "GHS 500",
        currency: "GHS",
        numericValue: "500",
        sourceKind: KnowledgeDocumentSourceKind.DOCUMENT,
        sourceExcerpt: "Consultation GHS 500",
        governanceStatus: KnowledgeFactGovernanceStatus.CONFLICT,
      },
    })));
    const reviews = await Promise.all(facts.map((fact, index) => prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        factId: fact.id,
        comparisonKey: `price-${index}-${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
        priority: KnowledgeGovernancePriority.CRITICAL,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        canonicalEntityId: serviceId,
        canonicalField: "basePrice",
        existingValue: { value: "400.00", currency: "GHS" },
        documentValue: { valueText: "GHS 500", numericValue: "500", currency: "GHS" },
        normalizedExistingValue: "GHS:400",
        normalizedDocumentValue: "GHS:500",
      },
    })));

    const input = {
      expectedVersionId: versionId,
      action: KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS,
      expectedCanonicalValue: { value: "400.00", currency: "GHS" },
    };
    const first = await knowledgeGovernanceResolutionService.resolve(actor, reviews[0]!.id, input, `resolution-${suffix}`, {});
    assert.equal((first as { duplicate: boolean }).duplicate, false);
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).basePrice?.toString(), "500");
    const resolvedFact = await prisma.knowledgeDocumentFact.findUniqueOrThrow({ where: { id: facts[0]!.id } });
    assert.equal(resolvedFact.governanceStatus, KnowledgeFactGovernanceStatus.APPROVED);
    assert.equal(resolvedFact.canonicalEntityId, serviceId);
    assert.equal(resolvedFact.reviewedByMembershipId, actor.membershipId);
    assert.equal((await prisma.knowledgeGovernanceReview.findUniqueOrThrow({ where: { id: reviews[0]!.id } })).reviewStatus, KnowledgeGovernanceReviewStatus.RESOLVED);
    assert.equal((await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } })).governanceStatus, KnowledgeGovernanceStatus.REVIEW_REQUIRED);

    const duplicate = await knowledgeGovernanceResolutionService.resolve(actor, reviews[0]!.id, input, `resolution-${suffix}`, {});
    assert.equal((duplicate as { duplicate: boolean }).duplicate, true);
    assert.equal(await prisma.knowledgeGovernanceResolutionOperation.count({ where: { businessId: actor.businessId, idempotencyKey: `resolution-${suffix}` } }), 1);

    await assert.rejects(
      knowledgeGovernanceResolutionService.resolve(actor, reviews[1]!.id, input, `stale-${suffix}`, {}),
      (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_REVIEW_STALE",
    );
    assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).basePrice?.toString(), "500");

    await prisma.service.update({ where: { id: serviceId }, data: { basePrice: "400" } });
    const racingFact = await prisma.knowledgeDocumentFact.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        analysisId: analysis.id,
        factType: KnowledgeDocumentFactType.PRICE,
        label: "concurrent",
        valueText: "GHS 500",
        currency: "GHS",
        numericValue: "500",
        sourceKind: KnowledgeDocumentSourceKind.DOCUMENT,
        sourceExcerpt: "Consultation GHS 500",
        governanceStatus: KnowledgeFactGovernanceStatus.CONFLICT,
      },
    });
    const racingReview = await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        factId: racingFact.id,
        comparisonKey: `price-race-${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
        priority: KnowledgeGovernancePriority.CRITICAL,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        canonicalEntityId: serviceId,
        canonicalField: "basePrice",
        existingValue: { value: "400.00", currency: "GHS" },
        documentValue: { valueText: "GHS 500", numericValue: "500", currency: "GHS" },
        normalizedExistingValue: "GHS:400",
        normalizedDocumentValue: "GHS:500",
      },
    });

    const originalUpdate = serviceService.update.bind(serviceService);
    let releaseDomainUpdate!: () => void;
    let signalDomainUpdate!: () => void;
    const domainUpdateReached = new Promise<void>((resolve) => { signalDomainUpdate = resolve; });
    const domainUpdateReleased = new Promise<void>((resolve) => { releaseDomainUpdate = resolve; });
    serviceService.update = async (...args: Parameters<typeof serviceService.update>) => {
      signalDomainUpdate();
      await domainUpdateReleased;
      return originalUpdate(...args);
    };
    try {
      const resolution = knowledgeGovernanceResolutionService.resolve(
        actor,
        racingReview.id,
        input,
        `race-${suffix}`,
        {},
      );
      await domainUpdateReached;
      await assert.rejects(
        knowledgeDocumentReviewService.approve(actor, documentId, { versionId }, {}),
        (error: unknown) => error instanceof AppError
          && error.code === "KNOWLEDGE_DOCUMENT_REVIEW_IN_PROGRESS",
      );
      for (const lifecycleOperation of [
        () => knowledgeDocumentLifecycleService.archive(actor, documentId, {}),
        () => knowledgeDocumentLifecycleService.softDelete(actor, documentId, {}),
        () => knowledgeDocumentLifecycleService.permanentlyDelete(actor, documentId, true, {}),
      ]) {
        await assert.rejects(
          lifecycleOperation(),
          (error: unknown) => error instanceof AppError
            && error.code === "KNOWLEDGE_DOCUMENT_REVIEW_IN_PROGRESS",
        );
      }
      assert.equal(
        (await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } })).processingStatus,
        KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      );
      await prisma.service.update({ where: { id: serviceId }, data: { basePrice: "450" } });
      releaseDomainUpdate();
      await assert.rejects(
        resolution,
        (error: unknown) => error instanceof AppError && error.code === "KNOWLEDGE_REVIEW_STALE",
      );
      assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).basePrice?.toString(), "450");
    } finally {
      serviceService.update = originalUpdate;
      releaseDomainUpdate();
    }

    await prisma.knowledgeGovernanceReview.deleteMany({
      where: { id: { in: [reviews[1]!.id, racingReview.id] } },
    });
    await prisma.knowledgeDocumentFact.deleteMany({
      where: { id: { in: [facts[1]!.id, racingFact.id] } },
    });
    const rejectedFact = await prisma.knowledgeDocumentFact.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        analysisId: analysis.id,
        factType: KnowledgeDocumentFactType.PRICE,
        label: "rejected",
        valueText: "GHS 500",
        currency: "GHS",
        numericValue: "500",
        sourceKind: KnowledgeDocumentSourceKind.DOCUMENT,
        sourceExcerpt: "Consultation GHS 500",
        governanceStatus: KnowledgeFactGovernanceStatus.CONFLICT,
      },
    });
    const rejectedReview = await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        factId: rejectedFact.id,
        comparisonKey: `price-rejected-${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
        priority: KnowledgeGovernancePriority.CRITICAL,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        canonicalEntityId: serviceId,
        canonicalField: "basePrice",
        existingValue: { value: "450.00", currency: "GHS" },
        documentValue: { valueText: "GHS 500", numericValue: "500", currency: "GHS" },
        normalizedExistingValue: "GHS:450",
        normalizedDocumentValue: "GHS:500",
      },
    });
    const rejected = await knowledgeGovernanceResolutionService.resolve(actor, rejectedReview.id, {
      expectedVersionId: versionId,
      action: KnowledgeGovernanceResolutionAction.KEEP_CURRENT_SETTINGS,
      expectedCanonicalValue: { value: "450.00", currency: "GHS" },
    }, `reject-${suffix}`, {}) as {
      factStatus: KnowledgeFactGovernanceStatus;
      documentGovernanceStatus: KnowledgeGovernanceStatus;
      documentProcessingStatus: KnowledgeDocumentProcessingStatus;
    };
    assert.equal(rejected.factStatus, KnowledgeFactGovernanceStatus.REJECTED);
    assert.equal(rejected.documentGovernanceStatus, KnowledgeGovernanceStatus.REVIEW_REQUIRED);
    assert.equal(rejected.documentProcessingStatus, KnowledgeDocumentProcessingStatus.NEEDS_REVIEW);
    const blockedDocument = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } });
    assert.equal(blockedDocument.processingErrorCode, "KNOWLEDGE_DOCUMENT_FILTERED_CHUNKS_REQUIRED");
    assert.equal(await prisma.knowledgeDocument.count({
      where: { id: documentId, ...customerSafeKnowledgeDocumentWhere },
    }), 0);

    const historicalVersion = await prisma.knowledgeDocumentVersion.create({
      data: {
        documentId,
        businessId: actor.businessId,
        versionNumber: 2,
        originalFileName: "governance-history.txt",
        safeFileName: "governance-history.txt",
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 20,
        mimeType: "text/plain",
        checksum: `governance-history:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.OUTDATED,
        isActive: false,
      },
    });
    const historicalExtraction = await prisma.knowledgeDocumentExtraction.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId: historicalVersion.id,
        status: KnowledgeDocumentExtractionStatus.COMPLETED,
        normalizedText: "Historical consultation GHS 350",
      },
    });
    const historicalAnalysis = await prisma.knowledgeDocumentAnalysis.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId: historicalVersion.id,
        extractionId: historicalExtraction.id,
        status: KnowledgeDocumentAnalysisStatus.COMPLETED,
      },
    });
    const historicalGovernedAt = new Date("2026-01-02T03:04:05.000Z");
    const historicalFact = await prisma.knowledgeDocumentFact.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId: historicalVersion.id,
        analysisId: historicalAnalysis.id,
        factType: KnowledgeDocumentFactType.PRICE,
        label: "historical",
        valueText: "GHS 350",
        currency: "GHS",
        numericValue: "350",
        sourceKind: KnowledgeDocumentSourceKind.DOCUMENT,
        sourceExcerpt: "Historical consultation GHS 350",
        governanceStatus: KnowledgeFactGovernanceStatus.SUPERSEDED,
        governedAt: historicalGovernedAt,
      },
    });
    const governedFactsBeforeLifecycle = await prisma.knowledgeDocumentFact.findMany({
      where: { id: { in: [facts[0]!.id, rejectedFact.id, historicalFact.id] } },
      select: { id: true, governanceStatus: true, governedAt: true },
      orderBy: { id: "asc" },
    });

    const originalSyncDocument = knowledgeEmbeddingService.syncDocument.bind(knowledgeEmbeddingService);
    knowledgeEmbeddingService.syncDocument = async () => undefined;
    try {
      await knowledgeDocumentLifecycleService.archive(actor, documentId, {});
      assert.deepEqual(
        await prisma.knowledgeDocumentFact.findMany({
          where: { id: { in: governedFactsBeforeLifecycle.map((fact) => fact.id) } },
          select: { id: true, governanceStatus: true, governedAt: true },
          orderBy: { id: "asc" },
        }),
        governedFactsBeforeLifecycle,
      );

      await knowledgeDocumentLifecycleService.restore(actor, documentId, {});
      assert.deepEqual(
        await prisma.knowledgeDocumentFact.findMany({
          where: { id: { in: governedFactsBeforeLifecycle.map((fact) => fact.id) } },
          select: { id: true, governanceStatus: true, governedAt: true },
          orderBy: { id: "asc" },
        }),
        governedFactsBeforeLifecycle,
      );
    } finally {
      knowledgeEmbeddingService.syncDocument = originalSyncDocument;
    }
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId } });
    await prisma.service.deleteMany({ where: { id: serviceId } });
  }
});
