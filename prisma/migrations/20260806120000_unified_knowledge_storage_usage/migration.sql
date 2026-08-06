ALTER TABLE "KnowledgeArticle"
ADD COLUMN "pdfFileSize" INTEGER;

CREATE INDEX "KnowledgeArticle_businessId_pdfFileKey_idx"
ON "KnowledgeArticle"("businessId", "pdfFileKey");
