CREATE TABLE IF NOT EXISTS "ComplaintInsightReport" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "totalComplaints" INTEGER NOT NULL DEFAULT 0,
  "openComplaints" INTEGER NOT NULL DEFAULT 0,
  "resolvedComplaints" INTEGER NOT NULL DEFAULT 0,
  "reopenedComplaints" INTEGER NOT NULL DEFAULT 0,
  "criticalComplaints" INTEGER NOT NULL DEFAULT 0,
  "averageResolutionTimeMs" INTEGER,
  "aiSummary" TEXT NOT NULL,
  "rootCauses" JSONB NOT NULL,
  "trends" JSONB NOT NULL,
  "recommendations" JSONB NOT NULL,
  "recurringIssues" JSONB NOT NULL,
  "predictiveAlerts" JSONB NOT NULL,
  "executiveSummary" JSONB NOT NULL,
  "businessMemory" JSONB NOT NULL,
  "sourceComplaintIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "provider" TEXT,
  "model" TEXT,
  "promptTokens" INTEGER,
  "completionTokens" INTEGER,
  "totalTokens" INTEGER,
  "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ComplaintInsightReport_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ComplaintInsightReport_businessId_fkey'
  ) THEN
    ALTER TABLE "ComplaintInsightReport"
    ADD CONSTRAINT "ComplaintInsightReport_businessId_fkey"
    FOREIGN KEY ("businessId") REFERENCES "Business"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "ComplaintInsightReport_businessId_timeframe_periodStart_periodEnd_idx"
ON "ComplaintInsightReport"("businessId", "timeframe", "periodStart", "periodEnd");

CREATE INDEX IF NOT EXISTS "ComplaintInsightReport_businessId_generatedAt_idx"
ON "ComplaintInsightReport"("businessId", "generatedAt");
