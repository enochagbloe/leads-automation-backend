-- Add durable idempotency for AI-created complaint cases.
ALTER TABLE "CustomerIssueLog" ADD COLUMN "complaintFingerprint" TEXT;

CREATE UNIQUE INDEX "CustomerIssueLog_businessId_complaintFingerprint_key"
ON "CustomerIssueLog"("businessId", "complaintFingerprint");
