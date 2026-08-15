CREATE TYPE "KnowledgeDocumentExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'UNSUPPORTED', 'FAILED');
CREATE TYPE "KnowledgeDocumentAnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "KnowledgeDocumentDetectedType" AS ENUM ('SERVICE_INFORMATION', 'PRICING_INFORMATION', 'PAYMENT_INSTRUCTIONS', 'APPOINTMENT_INFORMATION', 'BUSINESS_POLICY', 'TERMS_AND_CONDITIONS', 'RENTAL_INFORMATION', 'PRODUCT_INFORMATION', 'FAQ', 'INTERNAL_GUIDE', 'MIXED_BUSINESS_DOCUMENT', 'OTHER');
CREATE TYPE "KnowledgeDocumentAudience" AS ENUM ('CUSTOMER', 'INTERNAL', 'MIXED', 'UNKNOWN');
CREATE TYPE "KnowledgeDocumentRecommendedClassification" AS ENUM ('AI_REFERENCE_ONLY', 'CLIENT_SENDABLE', 'INTERNAL_ONLY', 'UNKNOWN');
CREATE TYPE "KnowledgeDocumentAnalysisConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "KnowledgeDocumentSourceKind" AS ENUM ('DOCUMENT', 'PAGE', 'PARAGRAPH', 'SHEET', 'ROW', 'SLIDE');
CREATE TYPE "KnowledgeDocumentFactType" AS ENUM ('SERVICE', 'PRODUCT', 'PRICE', 'FEE', 'DEPOSIT', 'DISCOUNT', 'PAYMENT_METHOD', 'PAYMENT_INSTRUCTION', 'BOOKING_RULE', 'APPOINTMENT_POLICY', 'CANCELLATION_POLICY', 'REFUND_RULE', 'BUSINESS_HOURS', 'LOCATION', 'CONTACT_INFORMATION', 'CUSTOMER_REQUIREMENT', 'REQUIRED_DOCUMENT', 'DELIVERY_INFORMATION', 'RENTAL_RULE', 'LATE_FEE', 'DAMAGE_POLICY', 'TERMS', 'FAQ', 'CUSTOMER_INSTRUCTION', 'OTHER');

ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_TEXT_EXTRACTION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_ANALYSIS_STARTED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_ANALYSIS_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_ANALYSIS_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'KNOWLEDGE_DOCUMENT_NEEDS_REVIEW';

CREATE TABLE "KnowledgeDocumentExtraction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" "KnowledgeDocumentExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "extractorName" TEXT,
    "extractorVersion" TEXT,
    "normalizedText" TEXT,
    "contentHash" TEXT,
    "language" TEXT,
    "characterCount" INTEGER NOT NULL DEFAULT 0,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "pageCount" INTEGER,
    "sheetCount" INTEGER,
    "slideCount" INTEGER,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "extractionStartedAt" TIMESTAMP(3),
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeDocumentExtraction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocumentExtractedSection" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "sourceKind" "KnowledgeDocumentSourceKind" NOT NULL,
    "sourceLabel" TEXT,
    "pageNumber" INTEGER,
    "sheetName" TEXT,
    "slideNumber" INTEGER,
    "paragraphIndex" INTEGER,
    "rowNumber" INTEGER,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeDocumentExtractedSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocumentAnalysis" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "status" "KnowledgeDocumentAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "suggestedTitle" TEXT,
    "detectedDocumentType" "KnowledgeDocumentDetectedType",
    "shortSummary" TEXT,
    "detectedPurpose" TEXT,
    "likelyAudience" "KnowledgeDocumentAudience",
    "recommendedClassification" "KnowledgeDocumentRecommendedClassification",
    "analysisConfidence" "KnowledgeDocumentAnalysisConfidence",
    "requiresHumanReview" BOOLEAN NOT NULL DEFAULT false,
    "topics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "relatedServiceSuggestions" JSONB,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "analyzerName" TEXT,
    "analyzerVersion" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "analysisStartedAt" TIMESTAMP(3),
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeDocumentAnalysis_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeDocumentFact" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "factType" "KnowledgeDocumentFactType" NOT NULL,
    "label" TEXT NOT NULL,
    "valueText" TEXT NOT NULL,
    "currency" TEXT,
    "numericValue" DECIMAL(18,4),
    "sourceKind" "KnowledgeDocumentSourceKind" NOT NULL,
    "sourceLabel" TEXT,
    "pageNumber" INTEGER,
    "sheetName" TEXT,
    "slideNumber" INTEGER,
    "paragraphIndex" INTEGER,
    "rowNumber" INTEGER,
    "sourceExcerpt" TEXT,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeDocumentFact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "KnowledgeDocumentExtraction_versionId_key" ON "KnowledgeDocumentExtraction"("versionId");
CREATE INDEX "KnowledgeDocumentExtraction_businessId_status_idx" ON "KnowledgeDocumentExtraction"("businessId", "status");
CREATE INDEX "KnowledgeDocumentExtraction_businessId_documentId_idx" ON "KnowledgeDocumentExtraction"("businessId", "documentId");
CREATE UNIQUE INDEX "KnowledgeDocumentExtraction_versionId_documentId_businessId_key" ON "KnowledgeDocumentExtraction"("versionId", "documentId", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentExtraction_id_versionId_documentId_busines_key" ON "KnowledgeDocumentExtraction"("id", "versionId", "documentId", "businessId");
CREATE INDEX "KnowledgeDocumentExtractedSection_businessId_documentId_ver_idx" ON "KnowledgeDocumentExtractedSection"("businessId", "documentId", "versionId");
CREATE UNIQUE INDEX "KnowledgeDocumentExtractedSection_extractionId_ordinal_key" ON "KnowledgeDocumentExtractedSection"("extractionId", "ordinal");
CREATE UNIQUE INDEX "KnowledgeDocumentAnalysis_versionId_key" ON "KnowledgeDocumentAnalysis"("versionId");
CREATE UNIQUE INDEX "KnowledgeDocumentAnalysis_extractionId_key" ON "KnowledgeDocumentAnalysis"("extractionId");
CREATE INDEX "KnowledgeDocumentAnalysis_businessId_status_idx" ON "KnowledgeDocumentAnalysis"("businessId", "status");
CREATE INDEX "KnowledgeDocumentAnalysis_businessId_documentId_idx" ON "KnowledgeDocumentAnalysis"("businessId", "documentId");
CREATE UNIQUE INDEX "KnowledgeDocumentAnalysis_id_versionId_documentId_businessI_key" ON "KnowledgeDocumentAnalysis"("id", "versionId", "documentId", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentAnalysis_versionId_documentId_businessId_key" ON "KnowledgeDocumentAnalysis"("versionId", "documentId", "businessId");
CREATE UNIQUE INDEX "KnowledgeDocumentAnalysis_extractionId_versionId_documentId_key" ON "KnowledgeDocumentAnalysis"("extractionId", "versionId", "documentId", "businessId");
CREATE INDEX "KnowledgeDocumentFact_businessId_documentId_versionId_idx" ON "KnowledgeDocumentFact"("businessId", "documentId", "versionId");
CREATE INDEX "KnowledgeDocumentFact_businessId_factType_idx" ON "KnowledgeDocumentFact"("businessId", "factType");

ALTER TABLE "KnowledgeDocumentExtraction" ADD CONSTRAINT "KnowledgeDocumentExtraction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtraction" ADD CONSTRAINT "KnowledgeDocumentExtraction_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtraction" ADD CONSTRAINT "KnowledgeDocumentExtraction_versionId_documentId_businessI_fkey" FOREIGN KEY ("versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtractedSection" ADD CONSTRAINT "KnowledgeDocumentExtractedSection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtractedSection" ADD CONSTRAINT "KnowledgeDocumentExtractedSection_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtractedSection" ADD CONSTRAINT "KnowledgeDocumentExtractedSection_versionId_documentId_bus_fkey" FOREIGN KEY ("versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentExtractedSection" ADD CONSTRAINT "KnowledgeDocumentExtractedSection_extractionId_versionId_d_fkey" FOREIGN KEY ("extractionId", "versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentExtraction"("id", "versionId", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentAnalysis" ADD CONSTRAINT "KnowledgeDocumentAnalysis_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentAnalysis" ADD CONSTRAINT "KnowledgeDocumentAnalysis_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentAnalysis" ADD CONSTRAINT "KnowledgeDocumentAnalysis_versionId_documentId_businessId_fkey" FOREIGN KEY ("versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentAnalysis" ADD CONSTRAINT "KnowledgeDocumentAnalysis_extractionId_versionId_documentI_fkey" FOREIGN KEY ("extractionId", "versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentExtraction"("id", "versionId", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentFact" ADD CONSTRAINT "KnowledgeDocumentFact_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentFact" ADD CONSTRAINT "KnowledgeDocumentFact_documentId_businessId_fkey" FOREIGN KEY ("documentId", "businessId") REFERENCES "KnowledgeDocument"("id", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentFact" ADD CONSTRAINT "KnowledgeDocumentFact_versionId_documentId_businessId_fkey" FOREIGN KEY ("versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentVersion"("id", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocumentFact" ADD CONSTRAINT "KnowledgeDocumentFact_analysisId_versionId_documentId_busi_fkey" FOREIGN KEY ("analysisId", "versionId", "documentId", "businessId") REFERENCES "KnowledgeDocumentAnalysis"("id", "versionId", "documentId", "businessId") ON DELETE CASCADE ON UPDATE CASCADE;
