-- CreateEnum
CREATE TYPE "AiPromptScope" AS ENUM (
  'GLOBAL',
  'AI_REPLIES',
  'FOLLOW_UP',
  'APPOINTMENTS',
  'SALES',
  'LEAD_QUALIFICATION',
  'KNOWLEDGE',
  'DOCUMENT_SENDING',
  'COMPLAINTS',
  'HUMAN_HANDOFF'
);

-- CreateEnum
CREATE TYPE "AiPromptStatus" AS ENUM (
  'DRAFT',
  'VALIDATING',
  'VALID',
  'INVALID',
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED'
);

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_VERSION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_VALIDATION_STARTED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_VALIDATION_SUCCEEDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_VALIDATION_FAILED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_ACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_DEACTIVATED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_ARCHIVED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_ROLLED_BACK';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_PREVIEWED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_BLOCKED_BY_PLAN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_BLOCKED_BY_SAFETY';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'AI_PROMPT_BLOCKED_BY_CONFLICT';

-- CreateTable
CREATE TABLE "AiPromptConfiguration" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "scope" "AiPromptScope" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "AiPromptStatus" NOT NULL DEFAULT 'DRAFT',
  "activeVersionId" TEXT,
  "latestVersionNumber" INTEGER NOT NULL DEFAULT 0,
  "createdByMembershipId" TEXT NOT NULL,
  "updatedByMembershipId" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiPromptConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPromptVersion" (
  "id" TEXT NOT NULL,
  "businessId" TEXT NOT NULL,
  "configurationId" TEXT NOT NULL,
  "scope" "AiPromptScope" NOT NULL,
  "versionNumber" INTEGER NOT NULL,
  "previousVersionId" TEXT,
  "status" "AiPromptStatus" NOT NULL DEFAULT 'DRAFT',
  "activeKey" TEXT,
  "promptText" TEXT NOT NULL,
  "changeSummary" TEXT,
  "compiled" JSONB,
  "validationResult" JSONB,
  "unsupportedIssues" JSONB,
  "safetyIssues" JSONB,
  "capabilityIssues" JSONB,
  "conflictIssues" JSONB,
  "compilerVersion" TEXT,
  "validatedAt" TIMESTAMP(3),
  "activatedAt" TIMESTAMP(3),
  "deactivatedAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "createdByMembershipId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AiPromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiPromptConfiguration_businessId_scope_key" ON "AiPromptConfiguration"("businessId", "scope");
CREATE INDEX "AiPromptConfiguration_businessId_idx" ON "AiPromptConfiguration"("businessId");
CREATE INDEX "AiPromptConfiguration_businessId_scope_idx" ON "AiPromptConfiguration"("businessId", "scope");
CREATE INDEX "AiPromptConfiguration_businessId_status_idx" ON "AiPromptConfiguration"("businessId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AiPromptVersion_configurationId_versionNumber_key" ON "AiPromptVersion"("configurationId", "versionNumber");
CREATE UNIQUE INDEX "AiPromptVersion_businessId_scope_activeKey_key" ON "AiPromptVersion"("businessId", "scope", "activeKey");
CREATE INDEX "AiPromptVersion_businessId_idx" ON "AiPromptVersion"("businessId");
CREATE INDEX "AiPromptVersion_businessId_scope_idx" ON "AiPromptVersion"("businessId", "scope");
CREATE INDEX "AiPromptVersion_configurationId_status_idx" ON "AiPromptVersion"("configurationId", "status");
CREATE INDEX "AiPromptVersion_businessId_status_idx" ON "AiPromptVersion"("businessId", "status");

-- AddForeignKey
ALTER TABLE "AiPromptConfiguration" ADD CONSTRAINT "AiPromptConfiguration_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPromptConfiguration" ADD CONSTRAINT "AiPromptConfiguration_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiPromptConfiguration" ADD CONSTRAINT "AiPromptConfiguration_updatedByMembershipId_fkey" FOREIGN KEY ("updatedByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiPromptVersion" ADD CONSTRAINT "AiPromptVersion_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPromptVersion" ADD CONSTRAINT "AiPromptVersion_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "AiPromptConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPromptVersion" ADD CONSTRAINT "AiPromptVersion_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "AiPromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiPromptVersion" ADD CONSTRAINT "AiPromptVersion_createdByMembershipId_fkey" FOREIGN KEY ("createdByMembershipId") REFERENCES "BusinessMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiPromptConfiguration" ADD CONSTRAINT "AiPromptConfiguration_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "AiPromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

