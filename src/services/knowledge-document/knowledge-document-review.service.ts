import {
  AuditAction,
  BusinessRole,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentArchiveReason,
  KnowledgeDocumentStatus,
  KnowledgeFactGovernanceStatus,
  KnowledgeGovernanceResolutionAction,
  KnowledgeGovernanceReviewStatus,
  KnowledgeGovernanceStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { AuditInput } from "../audit.service";
import { realtimeService } from "../realtime.service";
import {
  ApproveKnowledgeDocumentReviewInput,
  RejectKnowledgeDocumentReviewInput,
} from "../../validation/knowledge.schemas";
import { evaluateKnowledgeDocumentReviewState } from "./knowledge-document-review-policy";
import { lockKnowledgeDocumentGovernance } from "./knowledge-document-governance-lock.service";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document.types";
import {
  enqueueKnowledgeRuntimeRefresh,
  knowledgeRuntimeRefreshService,
} from "./knowledge-runtime-refresh.service";

type ReviewDecision = "APPROVED" | "REJECTED";

function reviewError(reason: string): AppError {
  if (reason === "KNOWLEDGE_DOCUMENT_REVIEW_VERSION_CHANGED") {
    return new AppError(409, "The active document version changed. Refresh and review the latest version.", reason);
  }
  if (reason === "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPROVABLE") {
    return new AppError(409, "This document cannot be approved because extraction and analysis are incomplete.", reason);
  }
  if (reason === "KNOWLEDGE_DOCUMENT_GOVERNANCE_REVIEW_REQUIRED") {
    return new AppError(409, "Resolve every required fact review before approving this document.", reason);
  }
  if (reason === "KNOWLEDGE_DOCUMENT_FILTERED_CHUNKS_REQUIRED") {
    return new AppError(409, "This document contains rejected facts that cannot be exposed to customers.", reason);
  }
  if (reason === "KNOWLEDGE_DOCUMENT_REVIEW_IN_PROGRESS") {
    return new AppError(409, "A fact governance decision is currently being applied.", reason);
  }
  return new AppError(409, "The document review state changed. Refresh and try again.", "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
}

function publishReview(
  actor: KnowledgeDocumentActor,
  documentId: string,
  versionId: string,
  decision: ReviewDecision,
  processingStatus: KnowledgeDocumentProcessingStatus,
) {
  const payload = { documentId, versionId, decision, processingStatus };
  realtimeService.publish({
    type: decision === "APPROVED"
      ? "business.knowledge.document.review_approved"
      : "business.knowledge.document.review_rejected",
    businessId: actor.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload,
  });
  realtimeService.publish({
    type: "business.knowledge.document.updated",
    businessId: actor.businessId,
    roles: [BusinessRole.BUSINESS_OWNER, BusinessRole.MANAGER],
    payload,
  });
}

async function decide(
  actor: KnowledgeDocumentActor,
  documentId: string,
  input: { versionId: string; note?: string | null; reason?: string },
  decision: ReviewDecision,
  context: Omit<AuditInput, "action">,
) {
  await assertCanManageKnowledgeDocuments(actor, context, `KNOWLEDGE_DOCUMENT_REVIEW_${decision}`);
  const inScope = await prisma.knowledgeDocument.findFirst({
    where: { id: documentId, businessId: actor.businessId },
    select: { id: true },
  });
  if (!inScope) await throwKnowledgeDocumentNotFound(actor, documentId, context, `KNOWLEDGE_DOCUMENT_REVIEW_${decision}`);

  const processingStatus = decision === "APPROVED"
    ? KnowledgeDocumentProcessingStatus.READY
    : KnowledgeDocumentProcessingStatus.NEEDS_REVIEW;
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await lockKnowledgeDocumentGovernance(tx, documentId);
    const document = await tx.knowledgeDocument.findFirst({
      where: {
        id: documentId,
        businessId: actor.businessId,
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
      },
      include: {
        activeVersion: {
          include: {
            extraction: { select: { status: true } },
            analysis: { select: { status: true, requiresHumanReview: true } },
            _count: {
              select: {
                facts: true,
              },
            },
            facts: {
              where: { governanceStatus: { not: KnowledgeFactGovernanceStatus.APPROVED } },
              select: { id: true },
            },
            governanceReviews: {
              where: {
                reviewStatus: {
                  in: [
                    KnowledgeGovernanceReviewStatus.PENDING_REVIEW,
                    KnowledgeGovernanceReviewStatus.APPLYING,
                  ],
                },
                requiresHumanReview: true,
              },
              select: { id: true, reviewStatus: true },
            },
          },
        },
      },
    });
    if (!document?.activeVersion) {
      throw new AppError(404, "Active knowledge document not found.", "KNOWLEDGE_DOCUMENT_NOT_FOUND");
    }
    const reviewState = evaluateKnowledgeDocumentReviewState({
      documentProcessingStatus: document.processingStatus,
      versionProcessingStatus: document.activeVersion.processingStatus,
      activeVersionId: document.activeVersionId,
      expectedVersionId: input.versionId,
      versionIsActive: document.activeVersion.isActive,
      extractionStatus: document.activeVersion.extraction?.status ?? null,
      analysisStatus: document.activeVersion.analysis?.status ?? null,
      requiresHumanReview: document.activeVersion.analysis?.requiresHumanReview ?? null,
      unresolvedGovernanceReviewCount: document.activeVersion.governanceReviews.length,
      applyingGovernanceReviewCount: document.activeVersion.governanceReviews.filter(
        (item) => item.reviewStatus === KnowledgeGovernanceReviewStatus.APPLYING,
      ).length,
      governanceFactCount: document.activeVersion._count.facts,
      nonApprovedGovernanceFactCount: document.activeVersion.facts.length,
    });
    if (!reviewState.reviewable || (decision === "APPROVED" && !reviewState.approvable)) {
      throw reviewError(reviewState.reason ?? "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
    }
    const errorCode = decision === "REJECTED" ? "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPLIED" : null;
    const errorMessage = decision === "REJECTED" ? "The document was archived and will not be used." : null;
    const documentChanged = await tx.knowledgeDocument.updateMany({
      where: {
        id: documentId,
        businessId: actor.businessId,
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
        activeVersionId: input.versionId,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      },
      data: {
        processingStatus,
        processingErrorCode: errorCode,
        processingErrorMessage: errorMessage,
        governanceStatus: decision === "APPROVED" ? KnowledgeGovernanceStatus.APPROVED : KnowledgeGovernanceStatus.ARCHIVED,
        ...(decision === "REJECTED" ? {
          status: KnowledgeDocumentStatus.ARCHIVED,
          archivedAt: now,
          archiveReason: KnowledgeDocumentArchiveReason.REVIEW_NOT_APPLIED,
        } : {}),
      },
    });
    const versionChanged = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: input.versionId,
        documentId,
        businessId: actor.businessId,
        isActive: true,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      },
      data: {
        processingStatus,
        processingErrorCode: errorCode,
        processingErrorMessage: errorMessage,
        governanceStatus: decision === "APPROVED" ? KnowledgeGovernanceStatus.APPROVED : KnowledgeGovernanceStatus.ARCHIVED,
      },
    });
    if (documentChanged.count !== 1 || versionChanged.count !== 1) {
      throw reviewError("KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
    }
    if (decision === "APPROVED") {
      const analysisChanged = await tx.knowledgeDocumentAnalysis.updateMany({
        where: {
          versionId: input.versionId,
          documentId,
          businessId: actor.businessId,
          status: "COMPLETED",
        },
        data: { requiresHumanReview: false },
      });
      if (analysisChanged.count !== 1) {
        throw reviewError("KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
      }
    } else {
      await Promise.all([
        tx.knowledgeDocumentFact.updateMany({
          where: { businessId: actor.businessId, documentId, versionId: input.versionId },
          data: { governanceStatus: KnowledgeFactGovernanceStatus.ARCHIVED, governedAt: now },
        }),
        tx.knowledgeGovernanceReview.updateMany({
          where: {
            businessId: actor.businessId,
            documentId,
            versionId: input.versionId,
            reviewStatus: KnowledgeGovernanceReviewStatus.PENDING_REVIEW,
          },
          data: {
            reviewStatus: KnowledgeGovernanceReviewStatus.RESOLVED,
            requiresHumanReview: false,
            blocksAiUse: true,
            reviewedAt: now,
            reviewedByMembershipId: actor.membershipId,
            resolutionAction: KnowledgeGovernanceResolutionAction.REVIEW_NOT_APPLIED,
            resolutionReason: input.reason ?? "Document review was not applied.",
          },
        }),
      ]);
    }

    const metadata: Prisma.InputJsonObject = {
      documentId,
      versionId: input.versionId,
      decision,
      previousProcessingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      processingStatus,
      reviewedAt: now.toISOString(),
      ...(typeof input.note === "string" ? { note: input.note } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    await tx.auditLog.create({
      data: {
        ...context,
        action: decision === "APPROVED"
          ? AuditAction.KNOWLEDGE_DOCUMENT_REVIEW_APPROVED
          : AuditAction.KNOWLEDGE_DOCUMENT_REVIEW_REJECTED,
        businessId: actor.businessId,
        userId: actor.userId,
        actorMembershipId: actor.membershipId,
        metadata,
      },
    });
    await enqueueKnowledgeRuntimeRefresh(tx, {
      businessId: actor.businessId,
      documentId,
    });
    return {
      id: documentId,
      versionId: input.versionId,
      reviewDecision: decision,
      processingStatus,
      governanceStatus: decision === "APPROVED" ? KnowledgeGovernanceStatus.APPROVED : KnowledgeGovernanceStatus.ARCHIVED,
      documentStatus: decision === "REJECTED" ? KnowledgeDocumentStatus.ARCHIVED : KnowledgeDocumentStatus.ACTIVE,
    };
  });

  await knowledgeRuntimeRefreshService.processDocuments([documentId]);
  publishReview(actor, documentId, input.versionId, decision, processingStatus);
  return result;
}

export const knowledgeDocumentReviewService = {
  approve(
    actor: KnowledgeDocumentActor,
    documentId: string,
    input: ApproveKnowledgeDocumentReviewInput,
    context: Omit<AuditInput, "action">,
  ) {
    return decide(actor, documentId, input, "APPROVED", context);
  },

  reject(
    actor: KnowledgeDocumentActor,
    documentId: string,
    input: RejectKnowledgeDocumentReviewInput,
    context: Omit<AuditInput, "action">,
  ) {
    return decide(actor, documentId, input, "REJECTED", context);
  },
};
