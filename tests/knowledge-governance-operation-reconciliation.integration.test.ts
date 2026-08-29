import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  BusinessRole,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  KnowledgeGovernanceCanonicalEntityType,
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernancePriority,
  KnowledgeGovernanceResolutionAction,
  KnowledgeGovernanceResolutionOperationStatus,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  KnowledgeStorageProvider,
  MembershipStatus,
  ServicePriceType,
  ServiceSource,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { knowledgeGovernanceResolutionService } from "../src/services/knowledge-document/knowledge-governance-resolution.service";
import { AppError } from "../src/utils/errors";

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("stale governance leases are recovered without requiring the original caller", {
  skip: process.env.RUN_DATABASE_INTEGRATION_TESTS !== "true",
}, async () => {
  const membership = await prisma.businessMember.findFirst({
    where: {
      role: BusinessRole.BUSINESS_OWNER,
      status: MembershipStatus.ACTIVE,
      business: { deletedAt: null },
    },
    select: {
      id: true,
      userId: true,
      businessId: true,
      business: { select: { businessAccountId: true } },
    },
  });
  assert.ok(membership, "This integration test requires an active business owner.");

  const suffix = crypto.randomUUID();
  const documentId = `governance-recovery-document-${suffix}`;
  const versionId = `governance-recovery-version-${suffix}`;
  const serviceId = `governance-recovery-service-${suffix}`;
  const unrelatedServiceId = `governance-unrelated-service-${suffix}`;
  const recoveredServiceId = `governance-created-service-${suffix}`;
  const actor = {
    userId: membership.userId,
    businessAccountId: membership.business.businessAccountId,
    businessId: membership.businessId,
    membershipId: membership.id,
    role: BusinessRole.BUSINESS_OWNER,
  };
  const expiredAt = new Date(Date.now() - 60_000);
  const futureLease = new Date(Date.now() + 10 * 60_000);

  try {
    await prisma.service.create({
      data: {
        id: serviceId,
        businessId: actor.businessId,
        name: `Governance recovery ${suffix}`,
        slug: `governance-recovery-${suffix}`,
        basePrice: "400",
        currency: "GHS",
        priceType: ServicePriceType.FIXED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.create({
      data: {
        id: documentId,
        businessId: actor.businessId,
        title: "Governance operation recovery",
        fileUrl: "",
        fileName: "recovery.txt",
        mimeType: "text/plain",
        fileSize: 20,
        originalFileName: "recovery.txt",
        safeFileName: "recovery.txt",
        fileExtension: "txt",
        checksum: `governance-recovery:${suffix}`,
        status: KnowledgeDocumentStatus.ACTIVE,
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
        originalFileName: "recovery.txt",
        safeFileName: "recovery.txt",
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 20,
        mimeType: "text/plain",
        checksum: `governance-recovery:${suffix}`,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
        governanceStatus: KnowledgeGovernanceStatus.REVIEW_REQUIRED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { activeVersionId: versionId },
    });

    const createReviewAndOperation = async (input: {
      label: string;
      proposedPrice: string;
      leaseExpiresAt: Date;
    }) => {
      const review = await prisma.knowledgeGovernanceReview.create({
        data: {
          businessId: actor.businessId,
          documentId,
          versionId,
          comparisonKey: `recovery:${input.label}:${suffix}`,
          comparisonType: KnowledgeGovernanceComparisonType.CONFLICT,
          priority: KnowledgeGovernancePriority.CRITICAL,
          reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING,
          canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
          canonicalEntityId: serviceId,
          canonicalField: "basePrice",
          existingValue: { value: "400", currency: "GHS" },
          documentValue: {
            valueText: `GHS ${input.proposedPrice}`,
            numericValue: input.proposedPrice,
            currency: "GHS",
          },
          normalizedExistingValue: "GHS:400",
          normalizedDocumentValue: `GHS:${input.proposedPrice}`,
        },
      });
      const requestInput = {
        expectedVersionId: versionId,
        action: KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS,
        expectedCanonicalValue: { value: "400", currency: "GHS" },
      };
      const operation = await prisma.knowledgeGovernanceResolutionOperation.create({
        data: {
          businessId: actor.businessId,
          reviewId: review.id,
          actorMembershipId: actor.membershipId,
          idempotencyKey: `recovery-${input.label}-${suffix}`,
          requestHash: crypto.createHash("sha256").update(stable({ reviewId: review.id, ...requestInput })).digest("hex"),
          action: KnowledgeGovernanceResolutionAction.UPDATE_SETTINGS,
          expectedVersionId: versionId,
          requestInput,
          status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
          processingStartedAt: new Date(input.leaseExpiresAt.getTime() - 60_000),
          leaseOwner: `dead-worker-${input.label}`,
          leaseExpiresAt: input.leaseExpiresAt,
          attemptCount: 1,
        },
      });
      return { review, operation, requestInput };
    };

    const preDomain = await createReviewAndOperation({
      label: "pre-domain",
      proposedPrice: "500",
      leaseExpiresAt: expiredAt,
    });
    const released = await knowledgeGovernanceResolutionService.reconcileStaleOperations(100);
    assert.ok(released.released >= 1);
    assert.equal(
      (await prisma.knowledgeGovernanceResolutionOperation.findUniqueOrThrow({ where: { id: preDomain.operation.id } })).status,
      KnowledgeGovernanceResolutionOperationStatus.FAILED,
    );
    assert.equal(
      (await prisma.knowledgeGovernanceReview.findUniqueOrThrow({ where: { id: preDomain.review.id } })).reviewStatus,
      KnowledgeGovernanceReviewStatus.PENDING_REVIEW,
    );

    const postDomain = await createReviewAndOperation({
      label: "post-domain",
      proposedPrice: "600",
      leaseExpiresAt: expiredAt,
    });
    await prisma.service.update({ where: { id: serviceId }, data: { basePrice: "600" } });
    const recovered = await knowledgeGovernanceResolutionService.reconcileStaleOperations(100);
    assert.ok(recovered.recovered >= 1);
    assert.equal(
      (await prisma.knowledgeGovernanceResolutionOperation.findUniqueOrThrow({ where: { id: postDomain.operation.id } })).status,
      KnowledgeGovernanceResolutionOperationStatus.COMPLETED,
    );
    assert.equal(
      (await prisma.knowledgeGovernanceReview.findUniqueOrThrow({ where: { id: postDomain.review.id } })).reviewStatus,
      KnowledgeGovernanceReviewStatus.RESOLVED,
    );

    await prisma.service.update({ where: { id: serviceId }, data: { basePrice: "400" } });
    const activeLease = await createReviewAndOperation({
      label: "active-lease",
      proposedPrice: "700",
      leaseExpiresAt: futureLease,
    });
    await assert.rejects(
      knowledgeGovernanceResolutionService.resolve(
        actor,
        activeLease.review.id,
        activeLease.requestInput,
        activeLease.operation.idempotencyKey,
        {},
      ),
      (error: unknown) => error instanceof AppError
        && error.code === "KNOWLEDGE_REVIEW_OPERATION_IN_PROGRESS",
    );
    await knowledgeGovernanceResolutionService.reconcileStaleOperations(100);
    const unchangedActiveLease = await prisma.knowledgeGovernanceResolutionOperation.findUniqueOrThrow({
      where: { id: activeLease.operation.id },
    });
    assert.equal(unchangedActiveLease.status, KnowledgeGovernanceResolutionOperationStatus.APPLYING);
    assert.equal(unchangedActiveLease.leaseOwner, "dead-worker-active-lease");

    const duplicateName = `Governance duplicate ${suffix}`;
    await prisma.service.create({
      data: {
        id: unrelatedServiceId,
        businessId: actor.businessId,
        name: duplicateName,
        slug: `governance-unrelated-${suffix}`,
        basePrice: "999",
        currency: "GHS",
        durationMinutes: 15,
        priceType: ServicePriceType.FIXED,
        source: ServiceSource.MANUAL,
      },
    });
    const duplicateReview = await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        comparisonKey: `duplicate-service:${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
        priority: KnowledgeGovernancePriority.HIGH,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        documentValue: {
          label: duplicateName,
          valueText: duplicateName,
          numericValue: "500",
          currency: "GHS",
        },
      },
    });
    const duplicateInput = {
      expectedVersionId: versionId,
      action: KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS,
      settingsInput: { name: duplicateName, durationMinutes: 60 },
    };
    await assert.rejects(
      knowledgeGovernanceResolutionService.resolve(
        actor,
        duplicateReview.id,
        duplicateInput,
        `duplicate-service-${suffix}`,
        {},
      ),
      (error: unknown) => error instanceof AppError && error.code === "SERVICE_NAME_ALREADY_EXISTS",
    );
    const duplicateReviewAfter = await prisma.knowledgeGovernanceReview.findUniqueOrThrow({
      where: { id: duplicateReview.id },
    });
    assert.equal(duplicateReviewAfter.reviewStatus, KnowledgeGovernanceReviewStatus.PENDING_REVIEW);
    assert.equal(duplicateReviewAfter.canonicalEntityId, null);

    const recoveredName = `Governance recovered ${suffix}`;
    const recoveredReview = await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId,
        versionId,
        comparisonKey: `recovered-service:${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.MISSING_IN_SETTINGS,
        priority: KnowledgeGovernancePriority.HIGH,
        reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.SERVICE,
        documentValue: {
          label: recoveredName,
          valueText: recoveredName,
          numericValue: "800",
          currency: "GHS",
        },
      },
    });
    const recoveredInput = {
      expectedVersionId: versionId,
      action: KnowledgeGovernanceResolutionAction.ADD_TO_SETTINGS,
      settingsInput: {
        name: recoveredName,
        category: "Consultation",
        description: "Recovered from the exact governance operation.",
        durationMinutes: 90,
      },
    };
    const recoveredOperation = await prisma.knowledgeGovernanceResolutionOperation.create({
      data: {
        businessId: actor.businessId,
        reviewId: recoveredReview.id,
        actorMembershipId: actor.membershipId,
        idempotencyKey: `recovered-service-${suffix}`,
        requestHash: crypto.createHash("sha256").update(stable({
          reviewId: recoveredReview.id,
          ...recoveredInput,
        })).digest("hex"),
        action: recoveredInput.action,
        expectedVersionId: versionId,
        settingsInput: recoveredInput.settingsInput,
        requestInput: recoveredInput,
        status: KnowledgeGovernanceResolutionOperationStatus.APPLYING,
        processingStartedAt: new Date(expiredAt.getTime() - 60_000),
        leaseOwner: "dead-worker-service-create",
        leaseExpiresAt: expiredAt,
        attemptCount: 1,
      },
    });
    await prisma.service.create({
      data: {
        id: recoveredServiceId,
        businessId: actor.businessId,
        name: recoveredName,
        slug: `governance-recovered-${suffix}`,
        category: "Consultation",
        description: "Recovered from the exact governance operation.",
        basePrice: "800",
        currency: "GHS",
        durationMinutes: 90,
        priceType: ServicePriceType.NOT_SET,
        source: ServiceSource.AI_APPROVED,
        governanceCreationOperationId: recoveredOperation.id,
      },
    });
    await knowledgeGovernanceResolutionService.reconcileStaleOperations(100);
    const recoveredReviewAfter = await prisma.knowledgeGovernanceReview.findUniqueOrThrow({
      where: { id: recoveredReview.id },
    });
    assert.equal(recoveredReviewAfter.reviewStatus, KnowledgeGovernanceReviewStatus.RESOLVED);
    assert.equal(recoveredReviewAfter.canonicalEntityId, recoveredServiceId);
    assert.equal(
      (await prisma.knowledgeGovernanceResolutionOperation.findUniqueOrThrow({
        where: { id: recoveredOperation.id },
      })).status,
      KnowledgeGovernanceResolutionOperationStatus.COMPLETED,
    );
  } finally {
    await prisma.knowledgeDocument.deleteMany({ where: { id: documentId, businessId: actor.businessId } });
    await prisma.service.deleteMany({
      where: {
        id: { in: [serviceId, unrelatedServiceId, recoveredServiceId] },
        businessId: actor.businessId,
      },
    });
  }
});
