DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "KnowledgeDocumentVersion" version
    LEFT JOIN "KnowledgeDocument" document ON document."id" = version."documentId"
    WHERE document."id" IS NULL OR version."businessId" <> document."businessId"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Knowledge Document tenant constraints: inconsistent document versions exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "KnowledgeDocumentProcessingJob" job
    LEFT JOIN "KnowledgeDocument" document ON document."id" = job."documentId"
    LEFT JOIN "KnowledgeDocumentVersion" version ON version."id" = job."versionId"
    WHERE document."id" IS NULL
       OR version."id" IS NULL
       OR job."businessId" <> document."businessId"
       OR job."businessId" <> version."businessId"
       OR job."documentId" <> version."documentId"
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Knowledge Document tenant constraints: inconsistent processing jobs exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "KnowledgeDocument" document
    LEFT JOIN "KnowledgeDocumentVersion" version ON version."id" = document."activeVersionId"
    WHERE document."activeVersionId" IS NOT NULL
      AND (
        version."id" IS NULL
        OR version."documentId" <> document."id"
        OR version."businessId" <> document."businessId"
      )
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Knowledge Document tenant constraints: inconsistent active versions exist';
  END IF;
END $$;

ALTER TABLE "KnowledgeDocument" DROP CONSTRAINT "KnowledgeDocument_activeVersionId_fkey";
ALTER TABLE "KnowledgeDocumentVersion" DROP CONSTRAINT "KnowledgeDocumentVersion_documentId_fkey";
ALTER TABLE "KnowledgeDocumentProcessingJob" DROP CONSTRAINT "KnowledgeDocumentProcessingJob_documentId_fkey";
ALTER TABLE "KnowledgeDocumentProcessingJob" DROP CONSTRAINT "KnowledgeDocumentProcessingJob_versionId_fkey";

CREATE UNIQUE INDEX "KnowledgeDocument_id_businessId_key"
  ON "KnowledgeDocument"("id", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_id_businessId_key"
  ON "KnowledgeDocumentVersion"("id", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentVersion_id_documentId_businessId_key"
  ON "KnowledgeDocumentVersion"("id", "documentId", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentProcessingJob_versionId_documentId_busines_key"
  ON "KnowledgeDocumentProcessingJob"("versionId", "documentId", "businessId");

ALTER TABLE "KnowledgeDocumentVersion"
  ADD CONSTRAINT "KnowledgeDocumentVersion_documentId_businessId_fkey"
  FOREIGN KEY ("documentId", "businessId")
  REFERENCES "KnowledgeDocument"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocumentProcessingJob"
  ADD CONSTRAINT "KnowledgeDocumentProcessingJob_documentId_businessId_fkey"
  FOREIGN KEY ("documentId", "businessId")
  REFERENCES "KnowledgeDocument"("id", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocumentProcessingJob"
  ADD CONSTRAINT "KnowledgeDocumentProcessingJob_versionId_documentId_busine_fkey"
  FOREIGN KEY ("versionId", "documentId", "businessId")
  REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocument"
  ADD CONSTRAINT "KnowledgeDocument_activeVersionId_id_businessId_fkey"
  FOREIGN KEY ("activeVersionId", "id", "businessId")
  REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId")
  ON DELETE NO ACTION ON UPDATE CASCADE;
