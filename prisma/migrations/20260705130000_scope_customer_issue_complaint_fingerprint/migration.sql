-- Scope complaint fingerprint idempotency to the conversation.
DROP INDEX IF EXISTS "CustomerIssueLog_businessId_complaintFingerprint_key";

CREATE UNIQUE INDEX "CustomerIssueLog_businessId_conversationId_complaintFingerprint_key"
ON "CustomerIssueLog"("businessId", "conversationId", "complaintFingerprint");
