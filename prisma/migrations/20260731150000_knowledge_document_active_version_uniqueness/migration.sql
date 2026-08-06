-- Align existing flags with the document's canonical activeVersionId before
-- enforcing one active version per document.
UPDATE "KnowledgeDocumentVersion" version
SET "isActive" = (version."id" = document."activeVersionId")
FROM "KnowledgeDocument" document
WHERE version."documentId" = document."id";

CREATE INDEX "KnowledgeDocumentVersion_documentId_isActive_idx"
  ON "KnowledgeDocumentVersion"("documentId", "isActive");

CREATE UNIQUE INDEX "KnowledgeDocumentVersion_one_active_per_document_key"
  ON "KnowledgeDocumentVersion"("documentId")
  WHERE "isActive" = true;
