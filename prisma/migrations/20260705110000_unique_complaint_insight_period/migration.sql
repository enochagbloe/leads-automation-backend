-- Keep the newest generated report for each business/timeframe/period before enforcing uniqueness.
DELETE FROM "ComplaintInsightReport" old_report
USING "ComplaintInsightReport" keep_report
WHERE old_report."businessId" = keep_report."businessId"
  AND old_report."timeframe" = keep_report."timeframe"
  AND old_report."periodStart" = keep_report."periodStart"
  AND old_report."periodEnd" = keep_report."periodEnd"
  AND (
    old_report."generatedAt" < keep_report."generatedAt"
    OR (
      old_report."generatedAt" = keep_report."generatedAt"
      AND old_report."id" < keep_report."id"
    )
  );

-- Replace the previous lookup index with a unique period identity.
DROP INDEX IF EXISTS "ComplaintInsightReport_businessId_timeframe_periodStart_periodEnd_idx";

CREATE UNIQUE INDEX "ComplaintInsightReport_businessId_timeframe_periodStart_periodEnd_key"
ON "ComplaintInsightReport"("businessId", "timeframe", "periodStart", "periodEnd");
