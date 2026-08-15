import {
  AuditAction,
  BusinessRole,
  KnowledgeDocumentProcessingStatus,
  KnowledgeDocumentStatus,
  Prisma,
} from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../utils/errors";
import { invalidateAiBusinessContext } from "../ai-context-builder.service";
import { AuditInput } from "../audit.service";
import { knowledgeEmbeddingService } from "../knowledge-embedding.service";
import { realtimeService } from "../realtime.service";
import {
  ApproveKnowledgeDocumentReviewInput,
  RejectKnowledgeDocumentReviewInput,
} from "../../validation/knowledge.schemas";
import { evaluateKnowledgeDocumentReviewState } from "./knowledge-document-review-policy";
import {
  assertCanManageKnowledgeDocuments,
  KnowledgeDocumentActor,
  throwKnowledgeDocumentNotFound,
} from "./knowledge-document.types";

type ReviewDecision = "APPROVED" | "REJECTED";

function reviewError(reason: string): AppError {
  if (reason === "KNOWLEDGE_DOCUMENT_REVIEW_VERSION_CHANGED") {
    return new AppError(409, "The active document version changed. Refresh and review the latest version.", reason);
  }
  if (reason === "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPROVABLE") {
    return new AppError(409, "This document cannot be approved because extraction and analysis are incomplete.", reason);
  }
  return new AppError(409, "The document review state changed. Refresh and try again.", "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
}

async function refreshRuntimeKnowledge(businessId: string, documentId: string) {
  const results = await Promise.allSettled([
    invalidateAiBusinessContext(businessId),
    knowledgeEmbeddingService.syncDocument(documentId),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("Knowledge runtime refresh failed after review decision", {
        businessId,
        documentId,
        error: result.reason,
      });
    }
  }
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
    : KnowledgeDocumentProcessingStatus.FAILED;
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('knowledge_document_review'), hashtext(${documentId}))`;
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
    });
    if (!reviewState.reviewable || (decision === "APPROVED" && !reviewState.approvable)) {
      throw reviewError(reviewState.reason ?? "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
    }

    const errorCode = decision === "REJECTED" ? "KNOWLEDGE_DOCUMENT_REVIEW_REJECTED" : null;
    const errorMessage = decision === "REJECTED"
      ? "The document analysis was rejected. Replace the document or retry processing after correcting the source."
      : null;
    const documentChanged = await tx.knowledgeDocument.updateMany({
      where: {
        id: documentId,
        businessId: actor.businessId,
        status: KnowledgeDocumentStatus.ACTIVE,
        deletedAt: null,
        activeVersionId: input.versionId,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      },
      data: { processingStatus, processingErrorCode: errorCode, processingErrorMessage: errorMessage },
    });
    const versionChanged = await tx.knowledgeDocumentVersion.updateMany({
      where: {
        id: input.versionId,
        documentId,
        businessId: actor.businessId,
        isActive: true,
        processingStatus: KnowledgeDocumentProcessingStatus.NEEDS_REVIEW,
      },
      data: { processingStatus, processingErrorCode: errorCode, processingErrorMessage: errorMessage },
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
          requiresHumanReview: true,
        },
        data: { requiresHumanReview: false },
      });
      if (analysisChanged.count !== 1) {
        throw reviewError("KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED");
      }
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
    return { id: documentId, versionId: input.versionId, reviewDecision: decision, processingStatus };
  });

  await refreshRuntimeKnowledge(actor.businessId, documentId);
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
