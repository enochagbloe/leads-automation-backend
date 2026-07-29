ALTER TYPE "CustomerMemoryStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CUSTOMER_MEMORY_ARCHIVED';

-- Legacy soft-deleted memories still contain customer-derived content. Redact
-- them during deployment so the stronger forget contract applies retroactively.
UPDATE "CustomerMemoryItem"
SET
  "valueText" = '[REDACTED]',
  "structuredValue" = NULL,
  "sourceStatement" = NULL,
  "activeKey" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'DELETED';

-- A stored summary may contain text copied from a now-redacted memory item.
UPDATE "CustomerMemoryProfile" AS profile
SET
  "conversationSummary" = NULL,
  "summaryConversationId" = NULL,
  "summaryUpdatedAt" = NULL,
  "reconciliationRequiredAt" = CASE
    WHEN profile."memoryEnabled" THEN CURRENT_TIMESTAMP
    ELSE NULL
  END,
  "reconciliationReason" = CASE
    WHEN profile."memoryEnabled" THEN 'DELETED_MEMORY_REDACTED'
    ELSE NULL
  END,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE EXISTS (
  SELECT 1
  FROM "CustomerMemoryItem" AS item
  WHERE item."businessId" = profile."businessId"
    AND item."leadId" = profile."leadId"
    AND item."status" = 'DELETED'
);
