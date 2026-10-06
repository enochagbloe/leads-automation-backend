CREATE TABLE "KnowledgeQualityReview" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "findingKey" TEXT NOT NULL,
  "findingCode" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestChecksum" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "actorMembershipId" TEXT NOT NULL,
  "note" TEXT,
  "resultSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeQualityReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "KnowledgeQualityReview_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "KnowledgeQualityReview_businessId_idempotencyKey_key" ON "KnowledgeQualityReview"("businessId", "idempotencyKey");
CREATE INDEX "KnowledgeQualityReview_businessId_findingKey_action_idx" ON "KnowledgeQualityReview"("businessId", "findingKey", "action");
