UPDATE "KnowledgeDocumentVersion" version
SET "storageDeletedAt" = COALESCE(document."storageDeletedAt", document."deletedAt", CURRENT_TIMESTAMP)
FROM "KnowledgeDocument" document
WHERE version."documentId" = document."id"
  AND document."retentionStatus" = 'PURGED'
  AND version."storageObjectKey" IS NULL
  AND version."storageDeletedAt" IS NULL;
