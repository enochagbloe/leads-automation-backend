UPDATE "Service"
SET
  "missingFields" =
    CASE WHEN NULLIF(BTRIM("description"), '') IS NULL THEN ARRAY['description']::TEXT[] ELSE ARRAY[]::TEXT[] END
    || CASE
      WHEN "priceType" = 'FREE' THEN ARRAY[]::TEXT[]
      WHEN "priceType" IN ('FIXED', 'STARTING_FROM') AND "basePrice" IS NOT NULL THEN ARRAY[]::TEXT[]
      WHEN "priceType" = 'RANGE' AND ("basePrice" IS NOT NULL OR NULLIF(BTRIM("priceDescription"), '') IS NOT NULL) THEN ARRAY[]::TEXT[]
      WHEN "priceType" = 'QUOTE_ONLY' AND NULLIF(BTRIM("priceDescription"), '') IS NOT NULL THEN ARRAY[]::TEXT[]
      ELSE ARRAY['price']::TEXT[]
    END
    || CASE WHEN "durationMinutes" IS NULL THEN ARRAY['durationMinutes']::TEXT[] ELSE ARRAY[]::TEXT[] END
    || CASE WHEN "paymentRequiredBeforeBooking" AND NOT "requiresPayment" THEN ARRAY['paymentRequirement']::TEXT[] ELSE ARRAY[]::TEXT[] END,
  "readinessStatus" = CASE
    WHEN "isArchived" THEN 'ARCHIVED'::"ServiceReadinessStatus"
    WHEN NULLIF(BTRIM("description"), '') IS NOT NULL
      AND "priceType" <> 'NOT_SET'
      AND (
        "priceType" = 'FREE'
        OR ("priceType" IN ('FIXED', 'STARTING_FROM') AND "basePrice" IS NOT NULL)
        OR ("priceType" = 'RANGE' AND ("basePrice" IS NOT NULL OR NULLIF(BTRIM("priceDescription"), '') IS NOT NULL))
        OR ("priceType" = 'QUOTE_ONLY' AND NULLIF(BTRIM("priceDescription"), '') IS NOT NULL)
      )
      AND "durationMinutes" IS NOT NULL
      AND "isBookable"
      AND (NOT "paymentRequiredBeforeBooking" OR "requiresPayment")
      THEN 'READY_FOR_BOOKING'::"ServiceReadinessStatus"
    WHEN NULLIF(BTRIM("description"), '') IS NOT NULL
      AND "priceType" <> 'NOT_SET'
      AND (
        "priceType" = 'FREE'
        OR ("priceType" IN ('FIXED', 'STARTING_FROM') AND "basePrice" IS NOT NULL)
        OR ("priceType" = 'RANGE' AND ("basePrice" IS NOT NULL OR NULLIF(BTRIM("priceDescription"), '') IS NOT NULL))
        OR ("priceType" = 'QUOTE_ONLY' AND NULLIF(BTRIM("priceDescription"), '') IS NOT NULL)
      )
      THEN 'READY_FOR_AI'::"ServiceReadinessStatus"
    WHEN NULLIF(BTRIM("category"), '') IS NOT NULL
      OR NULLIF(BTRIM("description"), '') IS NOT NULL
      OR "basePrice" IS NOT NULL
      OR "priceType" <> 'NOT_SET'
      OR NULLIF(BTRIM("priceDescription"), '') IS NOT NULL
      OR "durationMinutes" IS NOT NULL
      OR "isBookable"
      OR "requiresPayment"
      THEN 'INCOMPLETE'::"ServiceReadinessStatus"
    ELSE 'DRAFT'::"ServiceReadinessStatus"
  END;
