UPDATE "Service"
SET "missingFields" = ARRAY[]::TEXT[]
WHERE "isArchived" = true;
