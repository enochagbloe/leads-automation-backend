import {
  KnowledgeDocumentAnalysisStatus,
  KnowledgeDocumentExtractionStatus,
  KnowledgeDocumentProcessingStatus,
} from "@prisma/client";

export type KnowledgeDocumentReviewState = {
  documentProcessingStatus: KnowledgeDocumentProcessingStatus;
  versionProcessingStatus: KnowledgeDocumentProcessingStatus;
  activeVersionId: string | null;
  expectedVersionId: string;
  versionIsActive: boolean;
  extractionStatus: KnowledgeDocumentExtractionStatus | null;
  analysisStatus: KnowledgeDocumentAnalysisStatus | null;
  requiresHumanReview: boolean | null;
  unresolvedGovernanceReviewCount: number;
  applyingGovernanceReviewCount: number;
  governanceFactCount: number;
  nonApprovedGovernanceFactCount: number;
};

export function evaluateKnowledgeDocumentReviewState(state: KnowledgeDocumentReviewState) {
  if (state.activeVersionId !== state.expectedVersionId || !state.versionIsActive) {
    return { reviewable: false, approvable: false, reason: "KNOWLEDGE_DOCUMENT_REVIEW_VERSION_CHANGED" } as const;
  }
  if (
    state.documentProcessingStatus !== KnowledgeDocumentProcessingStatus.NEEDS_REVIEW
    || state.versionProcessingStatus !== KnowledgeDocumentProcessingStatus.NEEDS_REVIEW
  ) {
    return { reviewable: false, approvable: false, reason: "KNOWLEDGE_DOCUMENT_REVIEW_STATE_CHANGED" } as const;
  }
  if (state.applyingGovernanceReviewCount > 0) {
    return { reviewable: false, approvable: false, reason: "KNOWLEDGE_DOCUMENT_REVIEW_IN_PROGRESS" } as const;
  }
  const approvable = state.extractionStatus === KnowledgeDocumentExtractionStatus.COMPLETED
    && state.analysisStatus === KnowledgeDocumentAnalysisStatus.COMPLETED
    && (state.requiresHumanReview === true || state.governanceFactCount === 0)
    && state.unresolvedGovernanceReviewCount === 0
    && state.nonApprovedGovernanceFactCount === 0;
  return {
    reviewable: true,
    approvable,
    reason: approvable
      ? null
      : state.unresolvedGovernanceReviewCount > 0
        ? "KNOWLEDGE_DOCUMENT_GOVERNANCE_REVIEW_REQUIRED"
        : state.nonApprovedGovernanceFactCount > 0
          ? "KNOWLEDGE_DOCUMENT_FILTERED_CHUNKS_REQUIRED"
          : "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPROVABLE",
  } as const;
}
