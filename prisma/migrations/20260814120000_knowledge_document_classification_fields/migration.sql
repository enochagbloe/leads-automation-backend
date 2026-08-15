ALTER TABLE "KnowledgeDocumentAnalysis"
ADD COLUMN "classificationReason" TEXT,
ADD COLUMN "classificationConfidence" DOUBLE PRECISION;

ALTER TABLE "KnowledgeDocumentAnalysis"
ADD CONSTRAINT "KnowledgeDocumentAnalysis_classificationConfidence_check"
CHECK (
  "classificationConfidence" IS NULL
  OR ("classificationConfidence" >= 0 AND "classificationConfidence" <= 1)
);

UPDATE "KnowledgeDocumentAnalysis"
SET
  "classificationReason" = CASE "recommendedClassification"::text
    WHEN 'INTERNAL_ONLY' THEN 'Existing analysis classified this document for internal use.'
    WHEN 'CLIENT_SENDABLE' THEN 'Existing analysis recommended this document for customer sharing after review.'
    WHEN 'AI_REFERENCE_ONLY' THEN 'Existing analysis recommended this document for AI reference only.'
    ELSE 'Existing analysis requires classification review.'
  END,
  "classificationConfidence" = CASE "analysisConfidence"::text
    WHEN 'HIGH' THEN 0.90
    WHEN 'MEDIUM' THEN 0.65
    ELSE 0.35
  END
WHERE "status" = 'COMPLETED'
  AND (
    "classificationReason" IS NULL
    OR "classificationConfidence" IS NULL
  );
