DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "AccountUsageRecord"
    GROUP BY "businessAccountId", "periodStart", "periodEnd"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate account usage periods require reconciliation before this migration can continue.';
  END IF;
END $$;

CREATE UNIQUE INDEX "AccountUsageRecord_businessAccountId_periodStart_periodEnd_key"
  ON "AccountUsageRecord"("businessAccountId", "periodStart", "periodEnd");
