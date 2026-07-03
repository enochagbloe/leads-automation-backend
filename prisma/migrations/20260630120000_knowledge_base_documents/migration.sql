ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_NEEDS_REVIEW';
ALTER TYPE "BusinessNotificationType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ASSET_SEND_FAILED';
ALTER TYPE "BusinessNotificationEntityType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE';
ALTER TYPE "BusinessNotificationEntityType" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_AI_DRAFT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_PUBLISHED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ARTICLE_PDF_GENERATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_UPLOADED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_DOCUMENT_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'KNOWLEDGE_ASSET_SENT_TO_CUSTOMER';

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE "KnowledgeArticleStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "KnowledgeArticleSource" AS ENUM ('AI_DRAFT', 'MANUAL', 'IMPORTED');
CREATE TYPE "KnowledgeAssetVisibility" AS ENUM ('INTERNAL_ONLY', 'CLIENT_SENDABLE');
CREATE TYPE "KnowledgeDocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "KnowledgeAssetSendType" AS ENUM ('ARTICLE_PDF', 'UPLOADED_DOCUMENT');
CREATE TYPE "KnowledgeAssetSentByType" AS ENUM ('STAFF', 'AI', 'SYSTEM');
CREATE TYPE "KnowledgeAssetSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

CREATE TABLE "KnowledgeArticle" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "slug" TEXT,
  "summary" TEXT,
  "body" TEXT NOT NULL,
  "category" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relatedServiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relatedPolicyIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "KnowledgeArticleStatus" NOT NULL DEFAULT 'DRAFT',
  "source" "KnowledgeArticleSource" NOT NULL DEFAULT 'MANUAL',
  "visibility" "KnowledgeAssetVisibility" NOT NULL DEFAULT 'INTERNAL_ONLY',
  "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
  "aiPromptVersion" TEXT,
  "aiDraftReason" TEXT,
  "aiConfidence" DOUBLE PRECISION,
  "pdfFileKey" TEXT,
  "pdfFileUrl" TEXT,
  "lastPdfGeneratedAt" TIMESTAMP(3),
  "reviewedByMembershipId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "publishedByMembershipId" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdByMembershipId" TEXT,
  "updatedByMembershipId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocument" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "category" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "relatedServiceIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fileUrl" TEXT NOT NULL,
  "fileKey" TEXT,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "status" "KnowledgeDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
  "visibility" "KnowledgeAssetVisibility" NOT NULL DEFAULT 'INTERNAL_ONLY',
  "uploadedByMembershipId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeAssetSendLog" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "leadId" TEXT,
  "customerPhone" TEXT,
  "assetType" "KnowledgeAssetSendType" NOT NULL,
  "articleId" TEXT,
  "documentId" TEXT,
  "sentByMembershipId" TEXT,
  "sentByType" "KnowledgeAssetSentByType" NOT NULL DEFAULT 'STAFF',
  "messageId" TEXT,
  "whatsappMessageId" TEXT,
  "status" "KnowledgeAssetSendStatus" NOT NULL DEFAULT 'QUEUED',
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeAssetSendLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocumentChunk" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "chunkText" TEXT NOT NULL,
  "pageNumber" INTEGER,
  "tokenCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocumentChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversationMessageAttachment" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "fileKey" TEXT,
  "mimeType" TEXT NOT NULL,
  "fileSize" INTEGER NOT NULL,
  "assetType" "KnowledgeAssetSendType" NOT NULL,
  "articleId" TEXT,
  "documentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationMessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeSearchEmbedding" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "chunkId" TEXT,
  "title" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "embedding" vector(1536) NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeSearchEmbedding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeArticle_businessId_slug_key" ON "KnowledgeArticle"("businessId", "slug");
CREATE INDEX "KnowledgeArticle_businessId_idx" ON "KnowledgeArticle"("businessId");
CREATE INDEX "KnowledgeArticle_businessId_status_idx" ON "KnowledgeArticle"("businessId", "status");
CREATE INDEX "KnowledgeArticle_businessId_visibility_idx" ON "KnowledgeArticle"("businessId", "visibility");
CREATE INDEX "KnowledgeArticle_businessId_source_idx" ON "KnowledgeArticle"("businessId", "source");
CREATE INDEX "KnowledgeArticle_businessId_category_idx" ON "KnowledgeArticle"("businessId", "category");
CREATE INDEX "KnowledgeArticle_businessId_updatedAt_idx" ON "KnowledgeArticle"("businessId", "updatedAt");

CREATE INDEX "KnowledgeDocument_businessId_idx" ON "KnowledgeDocument"("businessId");
CREATE INDEX "KnowledgeDocument_businessId_status_idx" ON "KnowledgeDocument"("businessId", "status");
CREATE INDEX "KnowledgeDocument_businessId_visibility_idx" ON "KnowledgeDocument"("businessId", "visibility");
CREATE INDEX "KnowledgeDocument_businessId_category_idx" ON "KnowledgeDocument"("businessId", "category");
CREATE INDEX "KnowledgeDocument_businessId_updatedAt_idx" ON "KnowledgeDocument"("businessId", "updatedAt");

CREATE INDEX "KnowledgeDocumentChunk_businessId_idx" ON "KnowledgeDocumentChunk"("businessId");
CREATE INDEX "KnowledgeDocumentChunk_businessId_documentId_idx" ON "KnowledgeDocumentChunk"("businessId", "documentId");
CREATE INDEX "KnowledgeDocumentChunk_businessId_createdAt_idx" ON "KnowledgeDocumentChunk"("businessId", "createdAt");

CREATE INDEX "KnowledgeAssetSendLog_businessId_idx" ON "KnowledgeAssetSendLog"("businessId");
CREATE INDEX "KnowledgeAssetSendLog_businessId_conversationId_createdAt_idx" ON "KnowledgeAssetSendLog"("businessId", "conversationId", "createdAt");
CREATE INDEX "KnowledgeAssetSendLog_businessId_articleId_idx" ON "KnowledgeAssetSendLog"("businessId", "articleId");
CREATE INDEX "KnowledgeAssetSendLog_businessId_documentId_idx" ON "KnowledgeAssetSendLog"("businessId", "documentId");
CREATE INDEX "KnowledgeAssetSendLog_businessId_status_idx" ON "KnowledgeAssetSendLog"("businessId", "status");

CREATE INDEX "ConversationMessageAttachment_businessId_idx" ON "ConversationMessageAttachment"("businessId");
CREATE INDEX "ConversationMessageAttachment_messageId_idx" ON "ConversationMessageAttachment"("messageId");
CREATE INDEX "ConversationMessageAttachment_businessId_articleId_idx" ON "ConversationMessageAttachment"("businessId", "articleId");
CREATE INDEX "ConversationMessageAttachment_businessId_documentId_idx" ON "ConversationMessageAttachment"("businessId", "documentId");

CREATE UNIQUE INDEX "KnowledgeSearchEmbedding_businessId_sourceType_sourceId_chunkId_key" ON "KnowledgeSearchEmbedding"("businessId", "sourceType", "sourceId", "chunkId") NULLS NOT DISTINCT;
CREATE INDEX "KnowledgeSearchEmbedding_businessId_sourceType_idx" ON "KnowledgeSearchEmbedding"("businessId", "sourceType");
CREATE INDEX "KnowledgeSearchEmbedding_businessId_updatedAt_idx" ON "KnowledgeSearchEmbedding"("businessId", "updatedAt");

ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_reviewedByMembershipId_fkey" FOREIGN KEY ("reviewedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_publishedByMembershipId_fkey" FOREIGN KEY ("publishedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_updatedByMembershipId_fkey" FOREIGN KEY ("updatedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_uploadedByMembershipId_fkey" FOREIGN KEY ("uploadedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KnowledgeDocumentChunk" ADD CONSTRAINT "KnowledgeDocumentChunk_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentChunk" ADD CONSTRAINT "KnowledgeDocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_sentByMembershipId_fkey" FOREIGN KEY ("sentByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "KnowledgeAssetSendLog" ADD CONSTRAINT "KnowledgeAssetSendLog_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ConversationMessageAttachment" ADD CONSTRAINT "ConversationMessageAttachment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessageAttachment" ADD CONSTRAINT "ConversationMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMessageAttachment" ADD CONSTRAINT "ConversationMessageAttachment_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "KnowledgeArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ConversationMessageAttachment" ADD CONSTRAINT "ConversationMessageAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
