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
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  KnowledgeStorageProvider,
  MembershipStatus,
} from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { knowledgeGovernanceResolutionService } from "../src/services/knowledge-document/knowledge-governance-resolution.service";
import { AppError } from "../src/utils/errors";

test("replacement comparison and completion reject an advanced target version", {
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
  const oldDocumentId = `governance-old-${suffix}`;
  const oldVersionOneId = `governance-old-v1-${suffix}`;
  const oldVersionTwoId = `governance-old-v2-${suffix}`;
  const newDocumentId = `governance-new-${suffix}`;
  const newVersionId = `governance-new-v1-${suffix}`;
  const actor = {
    userId: membership.userId,
    businessAccountId: membership.business.businessAccountId,
    businessId: membership.businessId,
    membershipId: membership.id,
    role: BusinessRole.BUSINESS_OWNER,
  };

  const createDocument = async (input: {
    id: string;
    versionId: string;
    title: string;
    checksum: string;
  }) => {
    await prisma.knowledgeDocument.create({
      data: {
        id: input.id,
        businessId: actor.businessId,
        title: input.title,
        fileUrl: "",
        fileName: `${input.id}.txt`,
        mimeType: "text/plain",
        fileSize: 20,
        originalFileName: `${input.id}.txt`,
        safeFileName: `${input.id}.txt`,
        fileExtension: "txt",
        checksum: input.checksum,
        status: KnowledgeDocumentStatus.ACTIVE,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
      },
    });
    await prisma.knowledgeDocumentVersion.create({
      data: {
        id: input.versionId,
        documentId: input.id,
        businessId: actor.businessId,
        versionNumber: 1,
        originalFileName: `${input.id}.txt`,
        safeFileName: `${input.id}.txt`,
        fileExtension: "txt",
        storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
        fileSize: 20,
        mimeType: "text/plain",
        checksum: input.checksum,
        processingStatus: KnowledgeDocumentProcessingStatus.READY,
        governanceStatus: KnowledgeGovernanceStatus.APPROVED,
        isActive: true,
      },
    });
    await prisma.knowledgeDocument.update({
      where: { id: input.id },
      data: { activeVersionId: input.versionId },
    });
  };

  try {
    await createDocument({
      id: oldDocumentId,
      versionId: oldVersionOneId,
      title: "Old active document",
      checksum: `old-v1:${suffix}`,
    });
    await createDocument({
      id: newDocumentId,
      versionId: newVersionId,
      title: "Proposed replacement",
      checksum: `new-v1:${suffix}`,
    });
    const review = await prisma.knowledgeGovernanceReview.create({
      data: {
        businessId: actor.businessId,
        documentId: newDocumentId,
        versionId: newVersionId,
        comparisonKey: `replacement:${suffix}`,
        comparisonType: KnowledgeGovernanceComparisonType.POTENTIAL_REPLACEMENT,
        priority: KnowledgeGovernancePriority.HIGH,
        reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
        canonicalEntityType: KnowledgeGovernanceCanonicalEntityType.DOCUMENT_VERSION,
        relatedDocumentId: oldDocumentId,
        relatedVersionId: oldVersionOneId,
        resolutionAction: KnowledgeGovernanceResolutionAction.REPLACE,
        reviewedAt: new Date(),
        reviewedByMembershipId: actor.membershipId,
      },
    });

    await knowledgeGovernanceResolutionService.compareReplacement(
      actor,
      newDocumentId,
      review.id,
      {},
    );

    await prisma.$transaction(async (tx) => {
      await tx.knowledgeDocumentVersion.update({
        where: { id: oldVersionOneId },
        data: { isActive: false },
      });
      await tx.knowledgeDocumentVersion.create({
        data: {
          id: oldVersionTwoId,
          documentId: oldDocumentId,
          businessId: actor.businessId,
          versionNumber: 2,
          originalFileName: "old-v2.txt",
          safeFileName: "old-v2.txt",
          fileExtension: "txt",
          storageProvider: KnowledgeStorageProvider.LOCAL_PRIVATE,
          fileSize: 25,
          mimeType: "text/plain",
          checksum: `old-v2:${suffix}`,
          processingStatus: KnowledgeDocumentProcessingStatus.READY,
          governanceStatus: KnowledgeGovernanceStatus.APPROVED,
          isActive: true,
        },
      });
      await tx.knowledgeDocument.update({
        where: { id: oldDocumentId },
        data: { activeVersionId: oldVersionTwoId },
      });
    });

    const targetChanged = (error: unknown) => error instanceof AppError
      && error.code === "KNOWLEDGE_DOCUMENT_REPLACEMENT_TARGET_CHANGED";
    await assert.rejects(
      knowledgeGovernanceResolutionService.compareReplacement(
        actor,
        newDocumentId,
        review.id,
        {},
      ),
      targetChanged,
    );
    await assert.rejects(
      knowledgeGovernanceResolutionService.completeReplacement(
        actor,
        newDocumentId,
        { reviewId: review.id, expectedVersionId: newVersionId },
        {},
      ),
      targetChanged,
    );

    const oldDocument = await prisma.knowledgeDocument.findUniqueOrThrow({
      where: { id: oldDocumentId },
      select: { status: true, activeVersionId: true, archivedAt: true },
    });
    assert.deepEqual(oldDocument, {
      status: KnowledgeDocumentStatus.ACTIVE,
      activeVersionId: oldVersionTwoId,
      archivedAt: null,
    });
    assert.equal((await prisma.knowledgeDocumentVersion.findUniqueOrThrow({
      where: { id: oldVersionTwoId },
      select: { isActive: true, governanceStatus: true },
    })).governanceStatus, KnowledgeGovernanceStatus.APPROVED);
  } finally {
    await prisma.knowledgeDocument.deleteMany({
      where: { id: { in: [oldDocumentId, newDocumentId] }, businessId: actor.businessId },
    });
  }
});
