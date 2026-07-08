ALTER TYPE "FollowUpJobStatus" ADD VALUE 'PROCESSING';

ALTER TABLE "FollowUpJob"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3);
