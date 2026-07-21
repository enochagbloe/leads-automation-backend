UPDATE "CustomerMemoryExtractionJob"
SET
  "status" = 'EXHAUSTED',
  "nextAttemptAt" = NULL,
  "finalErrorCode" = COALESCE("lastErrorCode", 'CUSTOMER_MEMORY_EXTRACTION_FAILED'),
  "exhaustedAt" = COALESCE("lastErrorAt", "updatedAt")
WHERE
  "status" = 'FAILED'
  AND "attemptCount" >= 5;
