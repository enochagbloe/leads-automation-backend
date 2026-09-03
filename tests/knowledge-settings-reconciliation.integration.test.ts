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
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  KnowledgeStorageProvider,
  MembershipStatus,
  ServicePriceType,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { serviceService } from "../src/services/service.service";

test("manual service pricing changes mark approved linked knowledge outdated", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const owner = await prisma.businessMember.findFirst({
    where: { role: BusinessRole.BUSINESS_OWNER, status: MembershipStatus.ACTIVE, business: { deletedAt: null } },
    select: { id: true, userId: true, businessId: true, business: { select: { businessAccountId: true } } },
  });
  assert.ok(owner, "This integration test requires an active business owner.");
  const suffix = crypto.randomUUID();
  const serviceId = `runtime-service-${suffix}`;
  const documentId = `runtime-document-${suffix}`;
  const versionId = `runtime-version-${suffix}`;
  const actor = {
    userId: owner.userId,
    businessAccountId: owner.business.businessAccountId,
    businessId: owner.businessId,
    membershipId: owner.id,
    role: BusinessRole.BUSINESS_OWNER,
  };

  try {
    await prisma.service.create({
      data: {
        id: serviceId,
        businessId: actor.businessId,
        name: `Runtime Consultation ${suffix.slice(0, 8)}`,
        slug: `runtime-consultation-${suffix}`,
        basePrice: "500",
        currency: "GHS",
        priceType: ServicePriceType.FIXED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.create({
      data: {
        id: documentId,
        businessId: actor.businessId,
        title: "Approved runtime pricing",
        fileUrl: "",
        fileName: "pricing.txt",
        mimeType: "text/plain",
        fileSize: 20,
        originalFileName: "pricing.txt",
        safeFileName: "pricing.txt",
        fileExtension: "txt",
        checksum: `runtime:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
      },
    });
    await prisma.knowledgeDocumentVersion.create({
      data: {
        id: versionId,
        documentId,
        businessId: actor.businessId,
        versionNumber: 1,
        originalFileName: "pricing.txt",
        safeFileName: "pricing.txt",
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 20,
        mimeType: "text/plain",
        checksum: `runtime:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { activeVersionId: versionId } });
    const extraction = await prisma.knowledgeDocumentExtraction.create({
      data: { businessId: actor.businessId, documentId, versionId, status: KnowledgeDocumentExtractionStatus.COMPLETED, normalizedText: "Consultation GHS 500" },
    });
    const analysis = await prisma.knowledgeDocumentAnalysis.create({
      data: { businessId: actor.businessId, documentId, versionId, extractionId: extraction.id, status: KnowledgeDocumentAnalysisStatus.COMPLETED },
    });
    const fact = await prisma.knowledgeDocumentFact.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        analysisId: analysis.id,
        factType: KnowledgeDocumentFactType.PRICE,
        label: "Consultation price",
        valueText: "GHS 500",
        currency: "GHS",
        numericValue: "500",
        sourceKind: KnowledgeDocumentSourceKind.DOCUMENT,
        governanceStatus: KnowledgeFactGovernanceStatus.APPROVED,
      },
    });
    await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        factId: fact.id,
        comparisonKey: `match:${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.MATCH,
        priority: KnowledgeGovernancePriority.CRITICAL,
        reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        canonicalEntityId: serviceId,
        canonicalField: "basePrice",
        existingValue: { value: "500", currency: "GHS" },
        documentValue: { value: "500", currency: "GHS" },
        normalizedExistingValue: "GHS:500",
        normalizedDocumentValue: "GHS:500",
        requiresHumanReview: false,
        blocksAiUse: false,
      },
    });

    await serviceService.update(actor, serviceId, { basePrice: "550" }, {});

    const [service, updatedFact, document, outdatedReview, refreshJob] = await Promise.all([
      prisma.service.findUniqueOrThrow({ where: { id: serviceId } }),
      prisma.knowledgeDocumentFact.findUniqueOrThrow({ where: { id: fact.id } }),
      prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId } }),
      prisma.knowledgeGovernanceReview.findFirst({
        where: { businessId: actor.businessId, versionId, factId: fact.id, comparisonType: KnowledgeGovernanceComparisonType.SETTINGS_CHANGED },
      }),
      prisma.knowledgeRuntimeRefreshJob.findUnique({ where: { documentId } }),
    ]);
    assert.equal(service.basePrice?.toString(), "550");
    assert.equal(updatedFact.governanceStatus, KnowledgeFactGovernanceStatus.OUTDATED);
    assert.equal(document.governanceStatus, KnowledgeGovernanceStatus.OUTDATED);
    assert.equal(outdatedReview?.reviewStatus, KnowledgeGovernanceReviewStatus.PENDING_REVIEW);
    assert.equal(outdatedReview?.blocksAiUse, false);
    assert.ok(refreshJob, "A durable runtime refresh must be queued in the mutation transaction.");
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId } });
    await prisma.service.deleteMany({ where: { id: serviceId } });
  }
});
