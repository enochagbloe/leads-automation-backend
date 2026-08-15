UPDATE "KnowledgeDocumentExtraction"
SET "warnings" = ARRAY[]::TEXT[]
WHERE "warnings" IS NULL;

UPDATE "KnowledgeDocumentAnalysis"
SET "topics" = ARRAY[]::TEXT[]
WHERE "topics" IS NULL;

UPDATE "KnowledgeDocumentAnalysis"
SET "warnings" = ARRAY[]::TEXT[]
WHERE "warnings" IS NULL;

ALTER TABLE "KnowledgeDocumentExtraction"
    ALTER COLUMN "warnings" SET NOT NULL;

ALTER TABLE "KnowledgeDocumentAnalysis"
    ALTER COLUMN "topics" SET NOT NULL,
    ALTER COLUMN "warnings" SET NOT NULL;
