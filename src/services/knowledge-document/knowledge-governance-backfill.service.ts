import { KnowledgeDocumentDetectedType, KnowledgeGovernanceStatus } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { evaluateAndPersistKnowledgeGovernance } from "./knowledge-document-governance.service";
import { lockKnowledgeDocumentLifecycleChange } from "./knowledge-document-governance-lock.service";
import { enqueueKnowledgeRuntimeRefresh } from "./knowledge-runtime-refresh.service";

// Legacy READY versions received REVIEW_REQUIRED defaults without review rows.
// Reuse their completed analysis; do not consume another AI analysis reservation.
export async function backfillKnowledgeGovernance(limit: number) {
  const where = {
    status: "ACTIVE" as const, deletedAt: null,
    processingStatus: "READY" as const, governanceStatus: "REVIEW_REQUIRED" as const,
    activeVersion: { is: {
      isActive: true, governanceReviews: { none: {} },
      analysis: { is: { status: "COMPLETED" as const } },
    } },
  };
  const candidates = await prisma.knowledgeDocument.findMany({
    where, orderBy: { id: "asc" }, take: limit,
    select: { id: true, businessId: true },
  });
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      await lockKnowledgeDocumentLifecycleChange(tx, candidate.businessId, candidate.id);
      const document = await tx.knowledgeDocument.findFirst({
        where: { ...where, id: candidate.id, businessId: candidate.businessId },
        include: { activeVersion: { include: { analysis: true } } },
      });
      const version = document?.activeVersion;
      if (!document || !version?.analysis) return;
      const result = await evaluateAndPersistKnowledgeGovernance(tx, {
        businessId: candidate.businessId, documentId: candidate.id, versionId: version.id,
        versionNumber: version.versionNumber, documentTitle: document.title,
        detectedDocumentType: version.analysis.detectedDocumentType ?? KnowledgeDocumentDetectedType.OTHER,
        analysisRequiresHumanReview: version.analysis.requiresHumanReview,
      });
      const needsReview = result.governanceStatus !== KnowledgeGovernanceStatus.APPROVED;
      const data = {
        processingStatus: needsReview ? "NEEDS_REVIEW" as const : "READY" as const,
        processingErrorCode: needsReview ? "KNOWLEDGE_DOCUMENT_GOVERNANCE_REVIEW_REQUIRED" : null,
        processingErrorMessage: needsReview ? "Review the migrated document facts before customer use." : null,
      };
      await tx.knowledgeDocument.update({ where: { id: document.id }, data });
      await tx.knowledgeDocumentVersion.update({ where: { id: version.id }, data });
      await tx.knowledgeDocumentAnalysis.update({ where: { id: version.analysis.id }, data: { requiresHumanReview: needsReview } });
      await enqueueKnowledgeRuntimeRefresh(tx, { businessId: candidate.businessId, documentId: candidate.id });
    }, { maxWait: 10_000, timeout: 30_000 });
  }
  return candidates.length;
}
