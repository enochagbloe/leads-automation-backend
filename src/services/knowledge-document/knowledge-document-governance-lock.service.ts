import { KnowledgeGovernanceReviewStatus, Prisma } from "@prisma/client";
import { AppError } from "../../utils/errors";

export async function lockKnowledgeDocumentGovernance(
  tx: Prisma.TransactionClient,
  documentId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('knowledge_document_review'),
      hashtext(${documentId})
    )
  `;
}

export async function lockKnowledgeDocumentLifecycleChange(
  tx: Prisma.TransactionClient,
  businessId: string,
  documentId: string,
) {
  await lockKnowledgeDocumentGovernance(tx, documentId);
  const applyingReviews = await tx.knowledgeGovernanceReview.count({
    where: {
      businessId,
      documentId,
      reviewStatus: KnowledgeGovernanceReviewStatus.APPLYING,
    },
  });
  if (applyingReviews > 0) {
    throw new AppError(
      409,
      "A governance decision is currently being applied.",
      "KNOWLEDGE_DOCUMENT_REVIEW_IN_PROGRESS",
    );
  }
}

export async function lockKnowledgeGovernanceReview(
  tx: Prisma.TransactionClient,
  reviewId: string,
) {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtext('knowledge_governance_review'),
      hashtext(${reviewId})
    )
  `;
}
