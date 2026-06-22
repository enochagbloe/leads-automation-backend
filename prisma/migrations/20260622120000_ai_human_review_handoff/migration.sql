DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HumanReviewType') THEN
    CREATE TYPE "HumanReviewType" AS ENUM (
      'LOW_CONFIDENCE',
      'CUSTOMER_REQUESTED_HUMAN',
      'COMPLAINT',
      'PAYMENT_OR_REFUND',
      'POLICY_UNCERTAINTY',
      'BOOKING_UNCLEAR',
      'MISSING_BUSINESS_CONTEXT',
      'MEDIA_OR_IMAGE_UNSUPPORTED',
      'AI_PROVIDER_FAILED',
      'QUOTA_EXCEEDED',
      'SAFETY_BLOCKED',
      'OTHER'
    );
  END IF;
END $$;

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_HUMAN_REVIEW_REQUESTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONVERSATION_HUMAN_TAKEOVER_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONVERSATION_AI_RESUMED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CONVERSATION_HUMAN_REVIEW_RESOLVED';

ALTER TABLE "Conversation"
ADD COLUMN IF NOT EXISTS "humanReviewType" "HumanReviewType",
ADD COLUMN IF NOT EXISTS "humanReviewCreatedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "humanReviewResolvedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "humanReviewResolvedByMembershipId" TEXT,
ADD COLUMN IF NOT EXISTS "lastAiBlockedReason" TEXT;

CREATE INDEX IF NOT EXISTS "Conversation_businessId_needsHumanReview_idx"
ON "Conversation"("businessId", "needsHumanReview");

CREATE INDEX IF NOT EXISTS "Conversation_humanReviewResolvedByMembershipId_idx"
ON "Conversation"("humanReviewResolvedByMembershipId");
