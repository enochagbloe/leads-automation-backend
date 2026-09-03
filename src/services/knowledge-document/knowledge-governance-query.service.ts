import {
  KnowledgeGovernanceComparisonType,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { KnowledgeGovernanceReviewQueueQuery } from "../../validation/knowledge.schemas";
import { assertCanManageKnowledgeDocuments, KnowledgeDocumentActor } from "./knowledge-document.types";
import { allowedKnowledgeGovernanceActions } from "./knowledge-governance-resolution-policy";

function unresolvedWhere(businessId: string): Prisma.KnowledgeGovernanceReviewWhereInput {
  return {
    businessId,
    reviewStatus: { in: [KnowledgeGovernanceReviewStatus.PENDING_REVIEW, KnowledgeGovernanceReviewStatus.APPLYING] },
    document: { deletedAt: null },
    version: { isActive: true },
  };
}

export const knowledgeGovernanceQueryService = {
  async summary(actor: KnowledgeDocumentActor) {
    await assertCanManageKnowledgeDocuments(actor, undefined, "KNOWLEDGE_GOVERNANCE_SUMMARY");
    const unresolved = unresolvedWhere(actor.businessId);
    const [totalUnresolved, critical, high, normal, outdatedDocuments, conflictedDocuments, replacementSuggestions] = await Promise.all([
      prisma.knowledgeGovernanceReview.count({ where: unresolved }),
      prisma.knowledgeGovernanceReview.count({ where: { ...unresolved, priority: "CRITICAL" } }),
      prisma.knowledgeGovernanceReview.count({ where: { ...unresolved, priority: "HIGH" } }),
      prisma.knowledgeGovernanceReview.count({ where: { ...unresolved, priority: "NORMAL" } }),
      prisma.knowledgeDocument.count({ where: { businessId: actor.businessId, deletedAt: null, governanceStatus: KnowledgeGovernanceStatus.OUTDATED } }),
      prisma.knowledgeDocument.count({
        where: {
          businessId: actor.businessId,
          deletedAt: null,
          governanceReviews: { some: { ...unresolved, comparisonType: KnowledgeGovernanceComparisonType.CONFLICT } },
        },
      }),
      prisma.knowledgeGovernanceReview.count({ where: { ...unresolved, comparisonType: KnowledgeGovernanceComparisonType.POTENTIAL_REPLACEMENT } }),
    ]);
    return {
      totalUnresolved,
      priority: { critical, high, normal },
      outdatedDocuments,
      conflictedDocuments,
      replacementSuggestions,
    };
  },

  async queue(actor: KnowledgeDocumentActor, query: KnowledgeGovernanceReviewQueueQuery) {
    await assertCanManageKnowledgeDocuments(actor, undefined, "KNOWLEDGE_GOVERNANCE_QUEUE");
    const where: Prisma.KnowledgeGovernanceReviewWhereInput = {
      businessId: actor.businessId,
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.status ? { reviewStatus: query.status } : {}),
      ...(query.comparisonType ? { comparisonType: query.comparisonType } : {}),
      ...(query.documentId ? { documentId: query.documentId } : {}),
      ...(query.factType ? { fact: { factType: query.factType } } : {}),
      ...(query.outdated === true ? { comparisonType: KnowledgeGovernanceComparisonType.SETTINGS_CHANGED } : {}),
      ...(query.outdated === false ? { comparisonType: { not: KnowledgeGovernanceComparisonType.SETTINGS_CHANGED } } : {}),
      document: { deletedAt: null },
    };
    const [items, total] = await prisma.$transaction([
      prisma.knowledgeGovernanceReview.findMany({
        where,
        orderBy: [{ reviewStatus: "asc" }, { priority: "asc" }, { detectedAt: "desc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          documentId: true,
          versionId: true,
          factId: true,
          comparisonType: true,
          priority: true,
          reviewStatus: true,
          canonicalEntityType: true,
          canonicalEntityId: true,
          canonicalField: true,
          existingValue: true,
          documentValue: true,
          requiresHumanReview: true,
          blocksAiUse: true,
          detectedAt: true,
          reviewedAt: true,
          resolutionAction: true,
          document: { select: { title: true, governanceStatus: true } },
          fact: {
            select: {
              factType: true,
              label: true,
              sourceLabel: true,
              pageNumber: true,
              sheetName: true,
              slideNumber: true,
              governanceStatus: true,
            },
          },
        },
      }),
      prisma.knowledgeGovernanceReview.count({ where }),
    ]);
    return {
      data: items.map((item) => ({
        ...item,
        allowedResolutionActions: item.reviewStatus === KnowledgeGovernanceReviewStatus.PENDING_REVIEW
          ? allowedKnowledgeGovernanceActions(item)
          : [],
      })),
      pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  },
};
