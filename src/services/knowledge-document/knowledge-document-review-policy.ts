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
  const approvable = state.extractionStatus === KnowledgeDocumentExtractionStatus.COMPLETED
    && state.analysisStatus === KnowledgeDocumentAnalysisStatus.COMPLETED
    && state.requiresHumanReview === true;
  return {
    reviewable: true,
    approvable,
    reason: approvable ? null : "KNOWLEDGE_DOCUMENT_REVIEW_NOT_APPROVABLE",
  } as const;
}
