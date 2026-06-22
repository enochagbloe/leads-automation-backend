ALTER TABLE "AiInteractionLog"
ADD COLUMN IF NOT EXISTS "primaryModel" TEXT,
ADD COLUMN IF NOT EXISTS "finalModelUsed" TEXT,
ADD COLUMN IF NOT EXISTS "fallbackAttempted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "fallbackModelsTried" JSONB,
ADD COLUMN IF NOT EXISTS "fallbackFailureReasons" JSONB,
ADD COLUMN IF NOT EXISTS "providerRequestCount" INTEGER NOT NULL DEFAULT 1;

UPDATE "AiInteractionLog"
SET
  "primaryModel" = COALESCE("primaryModel", "model"),
  "finalModelUsed" = COALESCE("finalModelUsed", "model"),
  "providerRequestCount" = CASE WHEN "providerRequestCount" < 1 THEN 1 ELSE "providerRequestCount" END;

CREATE INDEX IF NOT EXISTS "AiInteractionLog_fallbackAttempted_createdAt_idx"
ON "AiInteractionLog"("fallbackAttempted", "createdAt");
